import { prisma } from "../prisma.js";
import { allTenants, tenantFor, tenantForUser, TenantUnavailableError } from "./tenantDb.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { badRequest, notFound, notImplemented, HttpError } from "../lib/http.js";
import { getEffective, integrationsStatus, setSettingValue } from "./settings.js";
import {
  isTwilioConfigured,
  listTwilioNumbersDetailed,
  searchAvailableNumbers,
  searchNumbersByPrefix,
  purchaseNumber,
  sendSms,
  monthlyPriceCentsFor,
  describeSmsError,
  fetchSmsCapability,
  releaseTwilioNumber,
} from "./sms.js";
import { importTwilioNumber, releaseVapiNumber, upsertAssistant } from "./vapi.js";
import { audit } from "./audit.js";
import type { AgentConfig } from "../lib/agentConfig.js";
import { brandDisplayName } from "../lib/brandUrls.js";

/* ------------------------------------------------------------------ *
 *  Admin phone-number management. The PhoneNumber table is the source
 *  of truth for the panel; `Profile.receptionistNumber` is kept in sync
 *  on (re)assignment so the customer dashboard + provisioning still work.
 * ------------------------------------------------------------------ */

const DEFAULT_MONTHLY_CENTS = 5000;

const normalize = (s: string | null | undefined): string => (s ?? "").replace(/[^\d+]/g, "");

/** Customer-facing agent label, mirroring the Vapi assistant naming. */
function agentLabel(config: AgentConfig | null | undefined): string {
  const business = config?.identity?.businessName?.trim();
  if (business) return `${business} Receptionist`;
  return config?.identity?.assistantName?.trim() || "Receptionist";
}

/* ------------------------------------------------------------------ *
 *  Release lifecycle
 *
 *  A number leaves a customer in one of two ways, and they are NOT the
 *  same thing:
 *
 *  1. Deliberately — an admin moves it to the pool, or a customer's setup
 *     swaps their agent onto a different number. Either way the number was
 *     given up on purpose, so it goes back to THAT brand's own pool, ready
 *     for the brand's next customer — allocation enforces that boundary, so a
 *     number in Acme's pool can only be handed to an Acme customer.
 *
 *     It is not the brand's forever, though: `releasedAt` starts a reclaim
 *     clock, and a number the brand hasn't reused within the window moves to
 *     the shared platform pool. Use it or lose it — otherwise a brand could
 *     park inventory the platform pays for and nobody uses.
 *
 *     There is no customer-facing "release my number" — a customer only ever
 *     gives one up by taking another. If that ever ships, it belongs on this
 *     path: call releasedToBrandPool() and it lands in the right pool.
 *
 *  2. Incidentally — a trial lapses, an account is deleted. Nobody chose
 *     to give the number up, and holding that inventory for a month would
 *     starve signup, so it goes straight back to the shared pool.
 *
 *  Both paths null `userId`, which is exactly why `brandId` is stored on
 *  the row: after a release there is otherwise nothing left to say whose
 *  customer had it.
 * ------------------------------------------------------------------ */

/** Back to the shared platform pool, immediately and unowned.
 *
 *  Exported because the invariant it encodes — AVAILABLE implies no brand and
 *  no hold — has to hold for every release path in the codebase, including the
 *  ones in provisioning. A row left AVAILABLE with a stale brandId would show
 *  up in that tenant's pool while being handed to anyone's next customer. */
export const TO_SHARED_POOL = {
  userId: null,
  assistantId: null,
  poolStatus: "AVAILABLE",
  status: "active",
  brandId: null,
  releasedAt: null,
} as const;

/**
 * A deliberate release: the number goes back to its own brand's pool, free to
 * hand to another of that brand's customers straight away.
 *
 * The brand keeps it because the brand paid for it. It stays AVAILABLE rather
 * than sitting in a cooldown — allocation is what enforces the boundary now
 * (`availableForBrand`), so a number in Acme's pool can only ever go to an Acme
 * customer. With no brand (a platform-direct customer) it returns to the shared
 * pool, which is the same thing one level up.
 */
function releasedToBrandPool(brandId: string | null | undefined) {
  if (!brandId) return { ...TO_SHARED_POOL };
  return {
    userId: null,
    assistantId: null,
    poolStatus: "AVAILABLE",
    status: "active",
    brandId,
    // Starts the brand's use-it-or-lose-it clock (see sweepBrandReclaims).
    releasedAt: new Date(),
  };
}

/** Assignment side of the same coin — stamp the owner's tenant on the row and
 *  stop the reclaim clock, since the number is back in service. */
function assignedToBrand(brandId: string | null | undefined) {
  return { brandId: brandId ?? null, releasedAt: null };
}

export interface PoolNumberDto {
  id: string;
  number: string;
  status: string;
  poolStatus: string;
  purchasePriceCents: number;
  monthlyPriceCents: number;
  addedAt: string;
  /** Tenant holding this number; null = the shared platform pool. */
  brandId: string | null;
  /** That tenant's display name, for the admin table. Null when shared. */
  brandName: string | null;
  /** When an unassigned brand number moves to the shared platform pool, or null
   *  when nothing is counting down (in service, or already shared). The brand
   *  needs to see this: otherwise a number they were saving simply disappears. */
  reclaimAt: string | null;
}
export interface UserNumberDto extends PoolNumberDto {
  agentName: string;
  agentProvider: string;
  agentId: string | null;
  userEmail: string;
}
export interface OverviewDto {
  pool: PoolNumberDto[];
  userNumbers: UserNumberDto[];
  smsSender: string | null;
}
export interface AgentDto {
  id: string;
  name: string;
  provider: string;
  userEmail: string;
  autoRoutes: boolean;
  /** The brand whose database holds this agent — where a number assigned to
   *  it is recorded on the customer's profile. */
  brandId: string;
}
export interface ImportableDto {
  sid: string;
  number: string;
  monthlyPriceCents: number;
}

/**
 * Split every tracked number this viewer may see into System Pool vs User
 * Numbers, carving out the current SMS sender (it lives only in its own card).
 *
 * `viewerBrandId` is the acting admin's tenant — null for the SUPER_ADMIN and
 * any platform-level admin, exactly like `tenantScope()` elsewhere. It decides
 * what comes back:
 *
 *   platform (null)  every number the platform owns: its own free inventory,
 *                    everything the Twilio sync imported, and each brand's
 *                    numbers too (tagged with the owning brand). The platform
 *                    is billed for all of it, so none of it may silently vanish
 *                    from its inventory.
 *   a brand          ONLY that brand's own numbers — the ones its customers are
 *                    using (Used) and the ones its admin has unassigned. Not the
 *                    shared platform pool, and never another brand's.
 */
export async function getOverview(viewerBrandId: string | null = null): Promise<OverviewDto> {
  const sender = normalize(getEffective("twilio.fromNumber")) || null;
  const reclaimDays = await getReclaimDays();
  const rows = await prisma.phoneNumber.findMany({
    where: viewerBrandId ? { brandId: viewerBrandId } : {},
    orderBy: { createdAt: "desc" },
    include: { brand: { select: { name: true } } },
  });

  // Who holds each assigned number — an account in the brand's database the
  // row names. One read per brand, not per number.
  const holders = new Map<string, { email: string; conversion: { agentConfig: unknown; vapiAssistantId: string | null } | null }>();
  const byBrand = new Map<string, string[]>();
  for (const r of rows) {
    if (r.userId && r.brandId) byBrand.set(r.brandId, [...(byBrand.get(r.brandId) ?? []), r.userId]);
  }
  for (const [brandId, userIds] of byBrand) {
    try {
      const db = await tenantFor(brandId);
      const users = await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, conversion: { select: { agentConfig: true, vapiAssistantId: true } } },
      });
      for (const u of users) holders.set(u.id, { email: u.email, conversion: u.conversion });
    } catch (e) {
      // A brand whose database is not ready: its numbers still list, holder unnamed.
      if (!(e instanceof TenantUnavailableError)) throw e;
    }
  }

  const pool: PoolNumberDto[] = [];
  const userNumbers: UserNumberDto[] = [];
  for (const r of rows) {
    if (sender && normalize(r.number) === sender) continue; // shown in the SMS card
    const livePriceCents = await monthlyPriceCentsFor(r.number);
    const base: PoolNumberDto = {
      id: r.id,
      number: r.number,
      status: r.status,
      poolStatus: r.poolStatus,
      purchasePriceCents:
        r.purchasePriceCents > 0 ? r.purchasePriceCents : (livePriceCents ?? r.purchasePriceCents),
      monthlyPriceCents: livePriceCents ?? r.monthlyPriceCents,
      addedAt: r.createdAt.toISOString(),
      brandId: r.brandId,
      brandName: r.brand?.name ?? null,
      reclaimAt:
        r.brandId && !r.userId && r.releasedAt
          ? new Date(r.releasedAt.getTime() + reclaimDays * 86_400_000).toISOString()
          : null,
    };
    if (r.userId) {
      const holder = holders.get(r.userId);
      const conv = holder?.conversion;
      userNumbers.push({
        ...base,
        agentName: agentLabel(conv?.agentConfig as unknown as AgentConfig),
        agentProvider: "Voice Agent",
        agentId: r.assistantId ?? conv?.vapiAssistantId ?? null,
        userEmail: holder?.email ?? "(account not reachable)",
      });
    } else {
      pool.push(base);
    }
  }
  return {
    pool,
    userNumbers,
    smsSender: sender ? getEffective("twilio.fromNumber") : null,
  };
}

/**
 * The pool a customer of `brandId` may actually be given a number from.
 *
 * A brand's own pool first, the shared platform pool second. This is the rule
 * that lets a released number stay in its brand's pool while being immediately
 * usable: without it, "AVAILABLE with a brandId" would be handed to whoever
 * signed up next, and Acme would pay for a number Northwind is using.
 *
 * Order matters — a brand should spend the inventory it is already paying for
 * before drawing on the shared pool. Callers pass this to `findFirst` with
 * `orderBy` and take the first row.
 */
export function availableForBrand(brandId: string | null | undefined) {
  return {
    userId: null,
    poolStatus: "AVAILABLE",
    status: "active",
    // Null brandId is the shared pool, open to everyone; a platform-direct
    // customer (no brand) may only ever draw from it.
    ...(brandId ? { OR: [{ brandId }, { brandId: null }] } : { brandId: null }),
  };
}

/** Pick the next number a customer of `brandId` may have — their brand's own
 *  inventory before the shared pool. Null when nothing is free to them. */
export async function nextAvailableForBrand(brandId: string | null | undefined) {
  if (brandId) {
    const own = await prisma.phoneNumber.findFirst({
      where: { userId: null, poolStatus: "AVAILABLE", status: "active", brandId },
      orderBy: { createdAt: "asc" },
    });
    if (own) return own;
  }
  return prisma.phoneNumber.findFirst({
    where: { userId: null, poolStatus: "AVAILABLE", status: "active", brandId: null },
    orderBy: { createdAt: "asc" },
  });
}

/** Which tenant a number belongs to, for callers that must check reach before
 *  acting on it. Null = the shared platform pool (or no such number — either
 *  way a brand admin is allowed to attempt it, and reassign decides the rest). */
export async function numberBrandId(id: string): Promise<string | null> {
  const row = await prisma.phoneNumber.findUnique({ where: { id }, select: { brandId: true } });
  return row?.brandId ?? null;
}

/** Every agent a number can be assigned to (one per customer conversion),
 *  scoped to the viewer's tenant — a brand admin assigns numbers to their own
 *  customers and nobody else's. Null viewer = platform-level, sees all. */
export async function listAgents(viewerBrandId: string | null = null): Promise<AgentDto[]> {
  const tenants = viewerBrandId ? [{ brandId: viewerBrandId, db: await tenantFor(viewerBrandId) }] : await allTenants();
  const out: AgentDto[] = [];
  for (const { brandId, db } of tenants) {
    const convs = await db.conversion.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    });
    for (const c of convs) {
      out.push({
        id: c.id,
        name: agentLabel(c.agentConfig as unknown as AgentConfig),
        provider: "Voice Agent",
        userEmail: c.user.email,
        autoRoutes: Boolean(c.vapiAssistantId),
        brandId,
      });
    }
  }
  return out;
}

/** Owned Twilio numbers not yet tracked in the pool — importable as-is. */
export async function twilioAvailable(): Promise<ImportableDto[]> {
  if (!isTwilioConfigured()) return [];
  const [owned, rows] = await Promise.all([
    listTwilioNumbersDetailed(),
    prisma.phoneNumber.findMany({ select: { number: true } }),
  ]);
  const have = new Set(rows.map((r) => normalize(r.number)));
  const importable = owned.filter((o) => !have.has(normalize(o.number)));
  // Show the REAL Twilio monthly rate for each number (cached per country), so the
  // admin sees what they're actually paying — not a flat placeholder. Falls back to
  // the default only when live pricing can't be fetched.
  return Promise.all(
    importable.map(async (o) => ({
      sid: o.sid,
      number: o.number,
      monthlyPriceCents: (await monthlyPriceCentsFor(o.number)) ?? DEFAULT_MONTHLY_CENTS,
    })),
  );
}

/** Search Twilio's catalog for purchasable numbers. A `prefix` (e.g. AU 02/03/04)
 *  narrows to matching numbers; otherwise filters by area code / contains / type. */
export async function twilioSearch(opts: {
  country?: string;
  areaCode?: string;
  contains?: string;
  type?: "local" | "mobile";
  prefix?: string;
}): Promise<ImportableDto[]> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const country = (opts.country || "US").toUpperCase();
  const numbers = opts.prefix
    ? await searchNumbersByPrefix(country, opts.prefix, 10)
    : (
        await searchAvailableNumbers({
          country,
          areaCode: opts.areaCode,
          contains: opts.contains,
          type: opts.type,
          limit: 10,
        })
      ).map((f) => f.number);
  // No SID until purchased — the number itself keys the buy. Show the real Twilio
  // rate for each (cached per country), falling back to the default when pricing
  // can't be fetched.
  return Promise.all(
    numbers.map(async (n) => ({
      sid: n,
      number: n,
      monthlyPriceCents: (await monthlyPriceCentsFor(n)) ?? DEFAULT_MONTHLY_CENTS,
    })),
  );
}

/** Add a number to the system pool — either importing one already owned
 *  (purchase=false) or buying a new one from Twilio (purchase=true). */
export async function addSystem(opts: {
  number: string;
  sid?: string | null;
  purchase?: boolean;
}): Promise<PoolNumberDto> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const number = opts.number.trim();
  if (!/^\+?\d{6,15}$/.test(normalize(number))) throw badRequest("That doesn't look like a valid phone number");

  const existing = await prisma.phoneNumber.findUnique({ where: { number } });
  if (existing) throw badRequest("That number is already tracked in the pool");

  let twilioSid: string | null = opts.sid ?? null;
  // Whether the number can send SMS, per Twilio. null = we couldn't confirm, and
  // resolveSmsSender treats that as "no" rather than risking a silent failure.
  let smsCapable: boolean | null = null;
  if (opts.purchase) {
    twilioSid = await purchaseNumber(number);
  } else if (!twilioSid) {
    const owned = await listTwilioNumbersDetailed();
    const match = owned.find((o) => normalize(o.number) === normalize(number));
    twilioSid = match?.sid ?? null;
    smsCapable = match?.smsCapable ?? null;
  }
  // Resolve capability from the SID when the lookup above didn't already answer
  // it. Best-effort by design — a failed check stores null, and the admin's
  // Re-sync fills it in later.
  if (smsCapable === null && twilioSid) smsCapable = await fetchSmsCapability(twilioSid);

  // Use the real Twilio monthly rate for this number's country, falling back to
  // the flat default only if pricing can't be fetched.
  const monthlyPriceCents = (await monthlyPriceCentsFor(number)) ?? DEFAULT_MONTHLY_CENTS;
  const row = await prisma.phoneNumber.create({
    data: {
      number,
      provider: "twilio",
      twilioSid,
      smsCapable,
      status: "active",
      poolStatus: "AVAILABLE",
      // Buying a number costs the first month's rate up front; imports cost nothing.
      purchasePriceCents: opts.purchase ? monthlyPriceCents : 0,
      monthlyPriceCents,
    },
  });
  // A number the platform owner just added goes into the SHARED pool — it isn't
  // any tenant's, so there is no reclaim clock on it.
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    poolStatus: row.poolStatus,
    purchasePriceCents: row.purchasePriceCents,
    monthlyPriceCents: row.monthlyPriceCents,
    addedAt: row.createdAt.toISOString(),
    brandId: null,
    brandName: null,
    reclaimAt: null,
  };
}

/** Move a number to the system pool (conversionId null) or assign it to an
 *  agent — rewiring Vapi routing and keeping the owner's profile in sync.
 *
 *  Moving to the pool is the DELIBERATE release: the number is parked in its
 *  owner's brand pool for the hold window rather than going straight back to
 *  the shared pool. A number already held is refused outright — the whole point
 *  of the window is that nobody, including the brand holding it, can hand it
 *  out again until the window lapses. */
export async function reassign(
  id: string,
  /** The agent to route to, in the brand whose database holds it; null = release. */
  target: { conversionId: string; brandId: string } | null,
  viewerBrandId: string | null = null,
): Promise<void> {
  const row = await prisma.phoneNumber.findUnique({ where: { id } });
  if (!row) throw notFound("Phone number not found");
  if (integrationsStatus().vapi) await releaseVapiNumber(row.number);

  // Whoever held it lets go: the tenant side, then the inventory row. Two
  // databases, so two writes; the reclaim sweep repairs a half-done pair.
  const clearHolder = async (brandId: string | null, userId: string | null, number: string) => {
    if (!brandId || !userId) return;
    await tenantFor(brandId)
      .then((db) =>
        db.profile.updateMany({
          where: { userId, receptionistNumber: number },
          data: { receptionistNumber: "", numberActivated: false, phoneNumberId: null },
        }),
      )
      .catch(() => undefined);
  };

  if (!target) {
    await clearHolder(row.brandId, row.userId, row.number);
    // A brand number goes back to that brand's pool with the reclaim clock
    // running; releasedToBrandPool handles the shared-pool case too.
    await prisma.phoneNumber.update({ where: { id }, data: releasedToBrandPool(row.brandId) });
    return;
  }

  if (viewerBrandId && target.brandId !== viewerBrandId) throw notFound("Agent not found");
  const db = await tenantFor(target.brandId);
  const conv = await db.conversion.findUnique({ where: { id: target.conversionId }, include: { user: true } });
  if (!conv) throw notFound("Agent not found");
  // One number per agent — free any other number this customer currently holds.
  const previous = await prisma.phoneNumber.findMany({ where: { userId: conv.userId, id: { not: id } } });
  let routedAssistantId = conv.vapiAssistantId;
  if (integrationsStatus().vapi) {
    try {
      for (const p of previous) await releaseVapiNumber(p.number);
      routedAssistantId = await upsertAssistant(conv.agentConfig as unknown as AgentConfig, conv.vapiAssistantId, { ownerId: conv.userId });
      if (routedAssistantId !== conv.vapiAssistantId) {
        await db.conversion.update({ where: { id: conv.id }, data: { vapiAssistantId: routedAssistantId } });
      }
      await importTwilioNumber({ number: row.number, assistantId: routedAssistantId });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const raw = e instanceof Error ? e.message : "";
      if (/already in use by another org/i.test(raw)) {
        throw new HttpError(
          409,
          `${row.number} is already registered to another account and can't be connected here. Assign a different number to this agent, or release ${row.number} from the account that currently holds it.`,
        );
      }
      throw new HttpError(
        502,
        `Couldn't connect ${row.number} to this agent. Please try again in a moment, or assign a different number.`,
      );
    }
  }
  // Main: the inventory rows.
  await prisma.$transaction(async (tx) => {
    if (previous.length) {
      await tx.phoneNumber.updateMany({
        where: { id: { in: previous.map((p) => p.id) } },
        data: releasedToBrandPool(target.brandId),
      });
    }
    await tx.phoneNumber.update({
      where: { id },
      data: {
        userId: conv.userId,
        assistantId: routedAssistantId,
        poolStatus: "ASSIGNED",
        status: "active",
        ...assignedToBrand(target.brandId),
      },
    });
  });
  // Then the tenant side: the previous holder (possibly in another brand)
  // lets go, and the new holder's profile shows the number.
  if (row.userId && row.userId !== conv.userId) await clearHolder(row.brandId, row.userId, row.number);
  await db.profile.updateMany({
    where: { userId: conv.userId },
    data: { receptionistNumber: row.number, numberActivated: true, phoneNumberId: row.id },
  });
  void replenishPool().catch(() => {});
}

/** Set the global SMS sender (the `from` on every post-call summary text). */
export async function assignSmsSender(number: string): Promise<string> {
  const clean = normalize(number);
  if (!/^\+?\d{6,15}$/.test(clean)) throw badRequest("That doesn't look like a valid phone number");
  await setSettingValue("twilio.fromNumber", clean);
  return clean;
}

/** Send a test SMS from the configured sender to a recipient, to verify the
 *  sender number works end-to-end. Surfaces Twilio's error verbatim on failure. */
export async function sendTestSms(to: string): Promise<{ from: string; to: string }> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const from = normalize(getEffective("twilio.fromNumber"));
  if (!from) throw badRequest("Set an SMS sender number before sending a test");
  const clean = normalize(to);
  if (!/^\+?\d{6,15}$/.test(clean)) throw badRequest("Enter a valid recipient phone number");
  try {
    await sendSms(
      clean,
      `✅ ${brandDisplayName()} test SMS — your sender number is configured correctly.`,
    );
  } catch (e) {
    throw new HttpError(502, describeSmsError(e));
  }
  return { from: getEffective("twilio.fromNumber"), to: clean };
}

/** Clear the SMS sender. Writes an empty override (not a delete) so it also
 *  masks any `TWILIO_FROM_NUMBER` coming from .env / the Twilio connection —
 *  the number fully disappears from the card AND Settings until reassigned. */
export async function unassignSmsSender(): Promise<void> {
  await setSettingValue("twilio.fromNumber", "");
}

/** Drop pool rows whose Twilio number the account no longer owns. */
/**
 * Reflect a self-serve number claim (from the customer setup wizard) in the
 * admin pool: release any other number the user held, then flip/create this
 * number's row to ASSIGNED under the user + their assistant. Best-effort caller.
 */
export async function markNumberAssignedToUser(opts: {
  userId: string;
  number: string;
  assistantId: string | null;
}): Promise<void> {
  const brandId = await brandIdForOwner(opts.userId);
  // One number per agent — free any other number this user currently holds.
  // The customer swapping their own number is a deliberate give-up, so the old
  // one goes back to their brand's pool with the reclaim clock running.
  await prisma.phoneNumber.updateMany({
    where: { userId: opts.userId, number: { not: opts.number } },
    data: releasedToBrandPool(brandId),
  });
  // Flip (or create) this number's row to ASSIGNED under the user.
  const existing = await prisma.phoneNumber.findUnique({ where: { number: opts.number } });
  const data = {
    userId: opts.userId,
    assistantId: opts.assistantId,
    poolStatus: "ASSIGNED",
    status: "active",
    ...assignedToBrand(brandId),
  };
  const row = existing
    ? await prisma.phoneNumber.update({ where: { number: opts.number }, data })
    : await prisma.phoneNumber.create({ data: { number: opts.number, ...data } });
  // The tenant side last: the profile names the inventory row it holds.
  await tenantForUser(opts.userId)
    .then((db) => db.profile.updateMany({ where: { userId: opts.userId }, data: { phoneNumberId: row.id } }))
    .catch(() => undefined);
}

/**
 * Release the number a user currently holds back to the system pool — without
 * touching their Vapi assistant (so a later re-subscribe reuses it). Used when a
 * post-trial grace period lapses. Mirrors the number side of
 * `deprovisionAgentForUser` but keeps the assistant. Returns the freed number
 * (for the notification), or null if the user held none. Best-effort on Vapi.
 */
export async function releaseUserNumberToPool(userId: string): Promise<string | null> {
  const rows = await prisma.phoneNumber.findMany({ where: { userId }, select: { number: true } });
  for (const r of rows) {
    if (r.number) await releaseVapiNumber(r.number);
  }
  await prisma.phoneNumber.updateMany({
    where: { userId },
    data: { ...TO_SHARED_POOL },
  });
  await tenantForUser(userId)
    .then((db) => db.profile.update({ where: { userId }, data: { receptionistNumber: "", phoneNumberId: null } }))
    .catch(() => undefined);
  return rows[0]?.number ?? null;
}

/**
 * Give a discontinued customer's number back to Twilio, for good.
 *
 * This is the end of the line, not a pool release: the customer stopped paying,
 * their warning window (Admin -> Plans -> grace period, 7 days by default) ran
 * out, and the platform should stop being billed for a number nobody is using.
 * So the number is released at the carrier and the row is deleted — it does not
 * land in the brand's pool, or the shared one, because we no longer own it.
 *
 * Irreversible: once Twilio has it back, anyone may buy it. That is the point,
 * and it is why only the grace-lapse sweep calls this.
 *
 * Order matters. Vapi first (so no assistant is left pointing at a number we are
 * about to lose), then Twilio, then the row. If Twilio fails we keep the row:
 * a number we still own and still pay for must stay visible in the pool rather
 * than vanish from the books.
 */
export async function releaseNumberPermanently(userId: string): Promise<string | null> {
  const rows = await prisma.phoneNumber.findMany({
    where: { userId },
    select: { id: true, number: true, twilioSid: true, brandId: true },
  });

  const removed: string[] = [];
  for (const row of rows) {
    if (integrationsStatus().vapi) {
      try {
        await releaseVapiNumber(row.number);
      } catch {
        // Vapi routing is best-effort: an assistant left pointing at a number we
        // no longer own simply stops receiving calls.
      }
    }

    try {
      await releaseTwilioNumber({ sid: row.twilioSid, number: row.number });
    } catch (e) {
      console.warn(
        `[phones] Twilio release failed for ${row.number}; keeping the row so it stays on the books:`,
        e instanceof Error ? e.message : e,
      );
      continue;
    }

    await prisma.phoneNumber.delete({ where: { id: row.id } });
    removed.push(row.number);

    // The row is gone, so the audit log is the only record left of a number the
    // platform paid for and no longer has.
    void audit({
      action: "phone.released_permanently",
      targetType: "phone_number",
      targetId: row.number,
      metadata: { userId, brandId: row.brandId, reason: "grace_period_expired" },
    });
  }

  await tenantForUser(userId)
    .then((db) => db.profile.update({ where: { userId }, data: { receptionistNumber: "", phoneNumberId: null } }))
    .catch(() => undefined);

  return removed[0] ?? rows[0]?.number ?? null;
}

export async function cleanupOrphaned(): Promise<{ removed: number; numbers: string[] }> {
  if (!isTwilioConfigured()) return { removed: 0, numbers: [] };
  const owned = await listTwilioNumbersDetailed();
  const ownedSids = new Set(owned.map((o) => o.sid));
  const ownedNums = new Set(owned.map((o) => normalize(o.number)));
  const rows = await prisma.phoneNumber.findMany();
  const orphans = rows.filter((r) =>
    r.twilioSid ? !ownedSids.has(r.twilioSid) : !ownedNums.has(normalize(r.number)),
  );
  if (orphans.length) {
    await prisma.phoneNumber.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  }
  return { removed: orphans.length, numbers: orphans.map((o) => o.number) };
}

/** Reset any number stuck in a non-active health status back to active. */
export async function clearSync(): Promise<{ changed: number; numbers: string[] }> {
  const stuck = await prisma.phoneNumber.findMany({ where: { status: { not: "active" } } });
  if (stuck.length) {
    await prisma.phoneNumber.updateMany({
      where: { id: { in: stuck.map((s) => s.id) } },
      data: { status: "active" },
    });
  }
  return { changed: stuck.length, numbers: stuck.map((s) => s.number) };
}

/** Ensure each customer's already-assigned `receptionistNumber` is tracked as an
 *  ASSIGNED pool row. Returns how many rows were created or repaired. */
async function backfillAssignments(): Promise<number> {
  const vapiOn = integrationsStatus().vapi;
  let changed = 0;
  for (const { brandId, db } of await allTenants()) {
    const profiles = await db.profile.findMany({
      where: { NOT: { receptionistNumber: "" } },
      select: {
        userId: true,
        receptionistNumber: true,
        user: { select: { conversion: { select: { vapiAssistantId: true } } } },
      },
    });
    for (const p of profiles) {
      const assistantId = p.user.conversion?.vapiAssistantId ?? null;
      const existing = await prisma.phoneNumber.findUnique({ where: { number: p.receptionistNumber } });
      let rowId = existing?.id ?? null;
      if (existing) {
        if (existing.userId !== p.userId || existing.poolStatus !== "ASSIGNED" || existing.brandId !== brandId) {
          await prisma.phoneNumber.update({
            where: { id: existing.id },
            data: { userId: p.userId, assistantId, poolStatus: "ASSIGNED", status: "active", ...assignedToBrand(brandId) },
          });
          changed++;
        }
      } else {
        const created = await prisma.phoneNumber.create({
          data: {
            number: p.receptionistNumber,
            provider: "twilio",
            userId: p.userId,
            assistantId,
            poolStatus: "ASSIGNED",
            status: "active",
            ...assignedToBrand(brandId),
            monthlyPriceCents: (await monthlyPriceCentsFor(p.receptionistNumber)) ?? DEFAULT_MONTHLY_CENTS,
          },
        });
        rowId = created.id;
        changed++;
      }
      if (rowId) {
        await db.profile.updateMany({ where: { userId: p.userId }, data: { phoneNumberId: rowId } }).catch(() => undefined);
      }
      if (vapiOn && assistantId && p.receptionistNumber) {
        try {
          await importTwilioNumber({ number: p.receptionistNumber, assistantId });
        } catch (e) {
          console.error(
            `[resync] Vapi import/route failed for ${p.receptionistNumber}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    }
  }
  return changed;
}

export interface ResyncResult {
  configured: boolean;
  purged: number;
  owned: number;
  inPool: number;
  missing: number;
  assignmentsSynced: number;
}

/** Reconcile the pool against the connected Twilio account. With creds removed
 *  it purges all Twilio rows (account switch); otherwise it repairs SIDs, maps
 *  existing assignments, and reports inventory. Throws if creds are rejected. */
export async function resyncTwilio(): Promise<ResyncResult> {
  if (!isTwilioConfigured()) {
    const purged = await prisma.phoneNumber.deleteMany({ where: { provider: "twilio" } });
    return { configured: false, purged: purged.count, owned: 0, inPool: 0, missing: 0, assignmentsSynced: 0 };
  }

  const owned = await listTwilioNumbersDetailed(); // throws on 401 → route maps to 502
  const rows = await prisma.phoneNumber.findMany();
  const byNum = new Map(rows.map((r) => [normalize(r.number), r]));

  let inPool = 0;
  for (const o of owned) {
    const r = byNum.get(normalize(o.number));
    if (r) {
      inPool++;
      // Reconcile both the Twilio SID and the real monthly price (backfills the
      // old flat $50 placeholder with the actual per-country Twilio rate).
      // SMS capability rides along here too — this is what backfills every row
      // that predates the column, so caller-facing texts can start using the
      // business's own number instead of the shared platform sender.
      const data: { twilioSid?: string; monthlyPriceCents?: number; smsCapable?: boolean } = {};
      if (!r.twilioSid) data.twilioSid = o.sid;
      if (r.smsCapable !== o.smsCapable) data.smsCapable = o.smsCapable;
      const realPrice = await monthlyPriceCentsFor(o.number);
      if (realPrice != null && realPrice !== r.monthlyPriceCents) data.monthlyPriceCents = realPrice;
      if (Object.keys(data).length) await prisma.phoneNumber.update({ where: { id: r.id }, data });
    }
  }
  const assignmentsSynced = await backfillAssignments();
  // Re-sync is the admin's "reconcile everything" action — give any cross-org
  // blocked numbers a fresh chance (e.g. after pointing at the right Vapi org).
  // If still locked, the next claim attempt simply re-blocks them.
  await clearBlockedNumbers().catch(() => {});
  return {
    configured: true,
    purged: 0,
    owned: owned.length,
    inPool,
    missing: owned.length - inPool,
    assignmentsSynced,
  };
}

/* ------------------------------------------------------------------ *
 *  Auto-replenish — keep at least `target` AVAILABLE numbers in the
 *  pool. Imports already-owned Twilio numbers first (free); only buys
 *  new ones when auto-purchase is enabled. Persisted as platform settings.
 * ------------------------------------------------------------------ */

const POOL_TARGET_KEY = "phones.poolTarget";
const AUTO_PURCHASE_KEY = "phones.autoPurchase";
const PURCHASE_COUNTRY_KEY = "phones.purchaseCountry";
const USER_PURCHASE_KEY = "phones.userPurchase";
const BLOCKED_NUMBERS_KEY = "phones.blockedNumbers";
const ALLOWED_COUNTRIES_KEY = "phones.allowedCountries";
const ALLOWED_PREFIXES_KEY = "phones.allowedPrefixes";
const DEFAULT_POOL_TARGET = 5;
const DEFAULT_PURCHASE_COUNTRY = "US";
// Countries customers may pick a number from during setup. AU + US are checked by
// default since that's where our existing customers are.
const DEFAULT_ALLOWED_COUNTRIES = ["US", "AU"];
const digitsOf = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/* ------------------------------------------------------------------ *
 *  Brand reclaim — "use it or lose it".
 *
 *  A number a brand unassigns stays in that brand's pool, usable by them
 *  straight away. If they do not reuse it within this window it moves to
 *  the shared platform pool, where every brand's customers can draw on
 *  it. Without this a brand could sit on inventory the platform is being
 *  billed for while nobody answers calls on it.
 * ------------------------------------------------------------------ */

const RECLAIM_DAYS_KEY = "phones.brandReclaimDays";
const DEFAULT_RECLAIM_DAYS = 7;
/** A window longer than a year would quietly strand paid-for inventory.
 *  0 is allowed and means "return it to the shared pool on the next sweep". */
const MAX_RECLAIM_DAYS = 365;

/** How long a brand keeps an unassigned number before the platform reclaims it. */
export async function getReclaimDays(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: RECLAIM_DAYS_KEY } });
  // A blank value is "unset", not zero. Number("") is 0, which is a LEGITIMATE
  // setting here ("reclaim on the next sweep") — so without this check, someone
  // clearing the field in a DB tool would quietly strip every brand's unassigned
  // numbers within the hour. Only parse a value that actually has digits in it.
  const raw = (row?.value ?? "").trim();
  if (!raw) return DEFAULT_RECLAIM_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_RECLAIM_DAYS ? n : DEFAULT_RECLAIM_DAYS;
}

/**
 * Move every brand-pooled number past its reclaim window into the shared
 * platform pool. Run hourly by the scheduler; safe to call ad hoc.
 *
 * Re-reads the window each pass rather than baking an expiry date into the row,
 * so shortening it releases the backlog on the next tick instead of stranding it
 * under the old rule.
 *
 * Only ever touches UNASSIGNED numbers (`userId: null`): a number the brand put
 * back into service has its clock cleared, and this clause is the second line of
 * defence if that ever failed — reclaiming a number mid-call would be the worst
 * bug in this file.
 */
export async function sweepBrandReclaims(): Promise<number> {
  const days = await getReclaimDays();
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const { count } = await prisma.phoneNumber.updateMany({
    where: {
      userId: null,
      brandId: { not: null },
      poolStatus: "AVAILABLE",
      releasedAt: { lte: cutoff },
    },
    data: { ...TO_SHARED_POOL },
  });
  return count;
}

/** Normalize an arbitrary value to a clean, de-duped list of 2-letter ISO codes. */
function normalizeCountryCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const codes = input
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.toUpperCase().slice(0, 2))
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return [...new Set(codes)];
}

/** Parse the stored allowed-countries JSON, falling back to the default set. */
function parseAllowedCountries(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_COUNTRIES];
  const codes = (() => {
    try {
      return normalizeCountryCodes(JSON.parse(raw));
    } catch {
      return [];
    }
  })();
  return codes.length ? codes : [...DEFAULT_ALLOWED_COUNTRIES];
}

/** ISO codes of the countries customers may pick a number from during setup. */
export async function getAllowedCountries(): Promise<string[]> {
  const row = await prisma.platformSetting.findUnique({ where: { key: ALLOWED_COUNTRIES_KEY } });
  return parseAllowedCountries(row?.value);
}

/** Parse the stored allowed-prefixes JSON — `{ iso(lowercase): nationalPrefix[] }`.
 *  An absent country key means "all prefixes allowed"; an empty array means "none". */
function parseAllowedPrefixes(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj)) {
      const iso = k.toLowerCase().slice(0, 2);
      if (!/^[a-z]{2}$/.test(iso) || !Array.isArray(v)) continue;
      out[iso] = [...new Set(v.filter((p): p is string => typeof p === "string").map((p) => p.replace(/\D/g, "")).filter(Boolean))];
    }
    return out;
  } catch {
    return {};
  }
}

/** Per-country national prefixes customers may pick during setup. */
export async function getAllowedPrefixes(): Promise<Record<string, string[]>> {
  const row = await prisma.platformSetting.findUnique({ where: { key: ALLOWED_PREFIXES_KEY } });
  return parseAllowedPrefixes(row?.value);
}

/**
 * Numbers that live in the shared Twilio account but are locked to a DIFFERENT
 * Vapi organisation (e.g. a teammate imported them on their own local Vapi key),
 * so importing them into *this* project 409s with "already in use by another org".
 * We remember them (digit-only) so they stop being offered as claimable and don't
 * keep throwing the same error. Stored as a JSON array in platform_settings.
 */
export async function getBlockedNumberDigits(): Promise<Set<string>> {
  const row = await prisma.platformSetting.findUnique({ where: { key: BLOCKED_NUMBERS_KEY } });
  if (!row?.value) return new Set();
  try {
    const arr = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(arr) ? arr.map((n) => digitsOf(String(n))).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

/** Flag a number as locked to another Vapi org so it's no longer offered/claimable. */
export async function blockNumber(number: string): Promise<void> {
  const d = digitsOf(number);
  if (!d) return;
  const set = await getBlockedNumberDigits();
  if (set.has(d)) return;
  set.add(d);
  await setSettingValue(BLOCKED_NUMBERS_KEY, JSON.stringify([...set]));
}

/** Clear the cross-org block list — e.g. after pointing the app at the Vapi org
 *  that actually owns those numbers. */
export async function clearBlockedNumbers(): Promise<void> {
  await setSettingValue(BLOCKED_NUMBERS_KEY, "[]");
}

export interface ReplenishConfig {
  target: number;
  autoPurchase: boolean;
  country: string;
  /** Let customers buy a brand-new number (from Twilio inventory) during setup. */
  userPurchase: boolean;
  /** ISO codes of countries customers may pick a number from during setup. */
  allowedCountries: string[];
  /** Per-country national prefixes customers may pick (iso → prefix[]). */
  allowedPrefixes: Record<string, string[]>;
  /** Days a deliberately released number stays held in its brand's pool before
   *  returning to the shared platform pool. 0 = return immediately. */
}

export async function getReplenishConfig(): Promise<ReplenishConfig> {
  const rows = await prisma.platformSetting.findMany({
    where: {
      key: {
        in: [
          POOL_TARGET_KEY,
          AUTO_PURCHASE_KEY,
          PURCHASE_COUNTRY_KEY,
          USER_PURCHASE_KEY,
          ALLOWED_COUNTRIES_KEY,
          ALLOWED_PREFIXES_KEY,
        ],
      },
    },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const target = Number(map.get(POOL_TARGET_KEY));
  return {
    target: Number.isInteger(target) && target >= 0 ? target : DEFAULT_POOL_TARGET,
    autoPurchase: map.get(AUTO_PURCHASE_KEY) === "true",
    country: (map.get(PURCHASE_COUNTRY_KEY) || DEFAULT_PURCHASE_COUNTRY).toUpperCase(),
    userPurchase: map.get(USER_PURCHASE_KEY) === "true",
    allowedCountries: parseAllowedCountries(map.get(ALLOWED_COUNTRIES_KEY)),
    allowedPrefixes: parseAllowedPrefixes(map.get(ALLOWED_PREFIXES_KEY)),
  };
}

/** Whether customers may buy their own brand-new number during setup. */
export async function isUserPurchaseEnabled(): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: USER_PURCHASE_KEY } });
  return row?.value === "true";
}

export async function setReplenishConfig(input: {
  target?: number;
  autoPurchase?: boolean;
  country?: string;
  userPurchase?: boolean;
  allowedCountries?: string[];
  allowedPrefixes?: Record<string, string[]>;
}): Promise<ReplenishConfig> {
  const upsert = (key: string, value: string) =>
    prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  const writes: Promise<unknown>[] = [];
  if (input.target !== undefined) {
    if (!Number.isInteger(input.target) || input.target < 0 || input.target > 100) {
      throw badRequest("Minimum pool size must be a whole number between 0 and 100");
    }
    writes.push(upsert(POOL_TARGET_KEY, String(input.target)));
  }
  if (input.autoPurchase !== undefined) {
    writes.push(upsert(AUTO_PURCHASE_KEY, input.autoPurchase ? "true" : "false"));
  }
  if (input.country !== undefined) {
    writes.push(upsert(PURCHASE_COUNTRY_KEY, input.country.toUpperCase().slice(0, 2)));
  }
  if (input.userPurchase !== undefined) {
    writes.push(upsert(USER_PURCHASE_KEY, input.userPurchase ? "true" : "false"));
  }
  if (input.allowedCountries !== undefined) {
    const codes = normalizeCountryCodes(input.allowedCountries);
    writes.push(upsert(ALLOWED_COUNTRIES_KEY, JSON.stringify(codes)));
  }
  if (input.allowedPrefixes !== undefined) {
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(input.allowedPrefixes)) {
      const iso = k.toLowerCase().slice(0, 2);
      if (!/^[a-z]{2}$/.test(iso) || !Array.isArray(v)) continue;
      clean[iso] = [...new Set(v.map((p) => String(p).replace(/\D/g, "")).filter(Boolean))];
    }
    writes.push(upsert(ALLOWED_PREFIXES_KEY, JSON.stringify(clean)));
  }
  await Promise.all(writes);
  return getReplenishConfig();
}

export interface ReplenishResult {
  target: number;
  before: number;
  imported: number;
  purchased: number;
  available: number;
  autoPurchase: boolean;
  skipped?: string;
}

// In-process guard so concurrent triggers (two signups at once + a scheduler
// tick) don't all race to import/buy the same deficit.
let replenishing = false;

const availableCount = () =>
  prisma.phoneNumber.count({ where: { userId: null, poolStatus: "AVAILABLE", status: "active" } });

/** Top the pool back up to `target` AVAILABLE numbers: import owned Twilio
 *  numbers first, then buy the rest only if auto-purchase is enabled. Best-effort
 *  and idempotent — safe to call after every assignment and on a timer. */
export async function replenishPool(): Promise<ReplenishResult> {
  const cfg = await getReplenishConfig();
  if (!isTwilioConfigured()) {
    const available = await availableCount();
    return { target: cfg.target, before: available, imported: 0, purchased: 0, available, autoPurchase: cfg.autoPurchase, skipped: "twilio-not-configured" };
  }
  if (replenishing) {
    const available = await availableCount();
    return { target: cfg.target, before: available, imported: 0, purchased: 0, available, autoPurchase: cfg.autoPurchase, skipped: "already-running" };
  }

  replenishing = true;
  try {
    const before = await availableCount();
    let deficit = cfg.target - before;
    let imported = 0;
    let purchased = 0;
    if (deficit <= 0) {
      return { target: cfg.target, before, imported, purchased, available: before, autoPurchase: cfg.autoPurchase };
    }

    // 1) Import already-owned Twilio numbers not yet tracked (free).
    const [owned, tracked] = await Promise.all([
      listTwilioNumbersDetailed(),
      prisma.phoneNumber.findMany({ select: { number: true } }),
    ]);
    const have = new Set(tracked.map((r) => normalize(r.number)));
    for (const o of owned) {
      if (deficit <= 0) break;
      if (have.has(normalize(o.number))) continue;
      try {
        const monthlyPriceCents = (await monthlyPriceCentsFor(o.number)) ?? DEFAULT_MONTHLY_CENTS;
        await prisma.phoneNumber.create({
          data: { number: o.number, provider: "twilio", twilioSid: o.sid, smsCapable: o.smsCapable, status: "active", poolStatus: "AVAILABLE", monthlyPriceCents },
        });
        imported++;
        deficit--;
      } catch {
        /* unique-collision race — skip */
      }
    }

    // 2) Buy the remaining deficit — only when auto-purchase is enabled.
    if (deficit > 0 && cfg.autoPurchase) {
      const candidates = await searchAvailableNumbers({ country: cfg.country });
      for (const c of candidates) {
        if (deficit <= 0) break;
        if (await prisma.phoneNumber.findUnique({ where: { number: c.number } })) continue;
        try {
          const sid = await purchaseNumber(c.number);
          const monthlyPriceCents = (await monthlyPriceCentsFor(c.number)) ?? DEFAULT_MONTHLY_CENTS;
          await prisma.phoneNumber.create({
            data: { number: c.number, provider: "twilio", twilioSid: sid, smsCapable: await fetchSmsCapability(sid), status: "active", poolStatus: "AVAILABLE", monthlyPriceCents },
          });
          purchased++;
          deficit--;
        } catch (e) {
          console.error("[replenish] purchase failed:", e instanceof Error ? e.message : e);
        }
      }
    }

    const available = await availableCount();
    return { target: cfg.target, before, imported, purchased, available, autoPurchase: cfg.autoPurchase };
  } finally {
    replenishing = false;
  }
}
