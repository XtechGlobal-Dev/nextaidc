import { prisma } from "../prisma.js";
import { allTenants } from "./tenantDb.js";
import { isStripeConfigured, stripe } from "./stripe.js";

// One Stripe account, many brand DBs: `stripe_customers` maps a Stripe customer id to
// its brand and user so a webhook knows which DB to open. Also stamped as Stripe metadata.

export interface StripeOwner {
  brandId: string;
  userId: string;
}

export interface StripeOwnerInput {
  brandId: string | null | undefined;
  userId: string;
}

/** Remember which brand and customer a Stripe customer id belongs to. A
 *  platform-level account has no brand and nothing to route, so it is skipped. */
export async function indexStripeCustomer(stripeCustomerId: string, owner: StripeOwnerInput): Promise<void> {
  if (!stripeCustomerId || !owner.brandId) return;
  await prisma.stripeCustomer.upsert({
    where: { stripeCustomerId },
    create: { stripeCustomerId, brandId: owner.brandId, userId: owner.userId },
    update: { brandId: owner.brandId, userId: owner.userId },
  });
}

/** The metadata a Stripe customer is created with — the owner, on the Stripe
 *  object itself, so a lost index row can be rebuilt from Stripe. */
export function stripeOwnerMetadata(owner: StripeOwnerInput | null | undefined): Record<string, string> {
  if (!owner?.brandId) return {};
  return { brandId: owner.brandId, userId: owner.userId };
}

/** Stamp the owner onto an existing Stripe customer. Best-effort: Stripe being
 *  down must not fail the billing action this rides along with. */
export async function stampStripeCustomer(stripeCustomerId: string, owner: StripeOwnerInput): Promise<void> {
  if (!isStripeConfigured() || !owner.brandId) return;
  try {
    await stripe().customers.update(stripeCustomerId, { metadata: stripeOwnerMetadata(owner) });
  } catch (e) {
    console.warn(`[stripe] could not stamp customer ${stripeCustomerId}:`, e instanceof Error ? e.message : e);
  }
}

/** Unknown customers recently asked about, so Stripe's retries of an event nobody holds don't each cost a lookup. */
const unknownUntil = new Map<string, number>();
const UNKNOWN_MS = 10 * 60 * 1000;

/** Whose Stripe customer is this? The index first; for one not indexed yet, the owner stamped on the Stripe customer
 *  itself (one API call), believed only if Main's directory agrees, and indexed on the way out. Never a scan of every
 *  account database — there is one per brand and per main-domain customer. Null means nobody holds it: park the
 *  event, don't guess (`backfillStripeCustomerIndex` is the repair tool for customers from before the stamp). */
export async function resolveStripeCustomer(stripeCustomerId: string | null | undefined): Promise<StripeOwner | null> {
  if (!stripeCustomerId) return null;
  const indexed = await prisma.stripeCustomer.findUnique({ where: { stripeCustomerId } });
  if (indexed) return { brandId: indexed.brandId, userId: indexed.userId };

  if ((unknownUntil.get(stripeCustomerId) ?? 0) > Date.now() || !isStripeConfigured()) return null;
  let stamped: StripeOwner | null = null;
  try {
    const customer = await stripe().customers.retrieve(stripeCustomerId);
    const meta = "deleted" in customer && customer.deleted ? {} : (customer.metadata ?? {});
    if (meta.brandId && meta.userId) stamped = { brandId: meta.brandId, userId: meta.userId };
  } catch (e) {
    console.warn(`[stripe] could not read customer ${stripeCustomerId}:`, e instanceof Error ? e.message : e);
    return null;
  }
  const known = stamped
    ? await prisma.customerDirectory.findUnique({
        where: { brandId_userId: { brandId: stamped.brandId, userId: stamped.userId } },
        select: { userId: true },
      })
    : null;
  if (!stamped || !known) {
    unknownUntil.set(stripeCustomerId, Date.now() + UNKNOWN_MS);
    if (unknownUntil.size > 10_000) unknownUntil.clear();
    return null;
  }
  await indexStripeCustomer(stripeCustomerId, stamped).catch(() => {});
  return stamped;
}

/** Re-indexes every Stripe customer id any brand's profiles hold. Repair tool for suspected gaps; returns how many rows were written. */
export async function backfillStripeCustomerIndex(): Promise<number> {
  let written = 0;
  for (const { brandId, db } of await allTenants()) {
    const profiles = await db.profile.findMany({
      where: { OR: [{ stripeCustomerId: { not: null } }, { pendingSwitchCustomerId: { not: null } }] },
      select: { userId: true, stripeCustomerId: true, pendingSwitchCustomerId: true },
    });
    for (const p of profiles) {
      for (const id of [p.stripeCustomerId, p.pendingSwitchCustomerId]) {
        if (!id) continue;
        await indexStripeCustomer(id, { brandId, userId: p.userId });
        written++;
      }
    }
  }
  return written;
}
