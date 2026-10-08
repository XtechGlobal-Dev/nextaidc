import { prisma } from "../prisma.js";
import { allTenants, tenantFor, type TenantClient } from "./tenantDb.js";
import { brandIdForOwner } from "./customerDirectory.js";

// Which account's agent a Vapi assistant belongs to — asked by the Vapi webhook on every call (twice: once when the
// call goes live, once for the end-of-call report). A webhook carries no session, and every brand and every
// main-domain customer has its own database, so a scan of all of them would grow with every sign-up. Instead the
// answer comes straight from what the call already says, cheapest first:
//   1. this process remembered it from an earlier call (verified, never trusted blind);
//   2. the owner id we stamp on every assistant (`assistant.metadata.customerId`) → Main's directory;
//   3. the number the call came in on → Main's phone inventory;
//   4. the assistant id itself in Main's phone inventory (number-bound assistants);
// and only then a full scan, logged so a miss shows up instead of silently costing every call.

export interface AssistantHints {
  /** Our account id stamped on the assistant (`message.assistant.metadata.customerId`) or the call (`metadata.userId`). */
  ownerUserId?: string | null;
  /** The E.164 number the call came in on / went out from (`message.phoneNumber.number`). */
  phoneNumber?: string | null;
}

export interface AssistantOwner {
  brandId: string;
  db: TenantClient;
  conversion: { id: string; userId: string; agentConfig: unknown };
}

const SELECT = { id: true, userId: true, agentConfig: true } as const;
const CACHE_MAX = 5000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const remembered = new Map<string, { brandId: string; at: number }>();

function remember(assistantId: string, brandId: string): void {
  remembered.delete(assistantId);
  remembered.set(assistantId, { brandId, at: Date.now() });
  // Oldest first in insertion order: drop it once the map is full.
  if (remembered.size > CACHE_MAX) remembered.delete(remembered.keys().next().value!);
}

/** Looks for the assistant in one brand's database. Null when it isn't there (or the database won't open). */
async function inBrand(brandId: string | null | undefined, assistantId: string): Promise<AssistantOwner | null> {
  if (!brandId) return null;
  try {
    const db = await tenantFor(brandId);
    const conversion = await db.conversion.findFirst({ where: { vapiAssistantId: assistantId }, select: SELECT });
    return conversion ? { brandId, db, conversion } : null;
  } catch {
    return null;
  }
}

/** The agent behind a Vapi assistant id, in whichever account database holds it. */
export async function conversionByAssistant(
  assistantId: string,
  hints: AssistantHints = {},
): Promise<AssistantOwner | null> {
  const found = await findOwner(assistantId, hints);
  if (found) remember(assistantId, found.brandId);
  else remembered.delete(assistantId);
  return found;
}

async function findOwner(assistantId: string, hints: AssistantHints): Promise<AssistantOwner | null> {
  const cached = remembered.get(assistantId);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    const hit = await inBrand(cached.brandId, assistantId);
    if (hit) return hit;
  }

  if (hints.ownerUserId) {
    const hit = await inBrand(await brandIdForOwner(hints.ownerUserId).catch(() => null), assistantId);
    if (hit) return hit;
  }

  const number = hints.phoneNumber?.trim();
  // A hiccup here must not fail the webhook — the next step still finds the agent.
  const inventory = await Promise.resolve()
    .then(() =>
      prisma.phoneNumber.findFirst({
        where: number ? { OR: [{ number }, { assistantId }] } : { assistantId },
        select: { brandId: true },
      }),
    )
    .catch(() => null);
  if (inventory?.brandId) {
    const hit = await inBrand(inventory.brandId, assistantId);
    if (hit) return hit;
  }

  console.warn(`[assistant owner] ${assistantId} not found from the call's own hints — scanning every database`);
  for (const { brandId, db } of await allTenants()) {
    const conversion = await db.conversion.findFirst({ where: { vapiAssistantId: assistantId }, select: SELECT });
    if (conversion) return { brandId, db, conversion };
  }
  return null;
}

/** Test seam: forget everything this process remembered. */
export function forgetAssistantOwners(): void {
  remembered.clear();
}
