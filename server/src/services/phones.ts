import { prisma } from "../prisma.js";
import { allTenants, tenantFor, tenantForUser, TenantUnavailableError } from "./tenantDb.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { badRequest, notFound, notImplemented, HttpError } from "../lib/http.js";
import {
  getEffective,
  getBrandOverride,
  integrationsStatus,
  setSettingValue,
  saveBrandIntegrations,
  INHERIT_SENTINEL,
} from "./settings.js";
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

// Admin phone-number management. PhoneNumber is the source of truth;
// Profile.receptionistNumber is kept in sync on (re)assignment.

const DEFAULT_MONTHLY_CENTS = 5000;

const normalize = (s: string | null | undefined): string => (s ?? "").replace(/[^\d+]/g, "");

/** Customer-facing agent label, mirroring the Vapi assistant naming. */
function agentLabel(config: AgentConfig | null | undefined): string {
  const business = config?.identity?.businessName?.trim();
  if (business) return `${business} Receptionist`;
  return config?.identity?.assistantName?.trim() || "Receptionist";
}

// Two release paths: deliberate (admin/customer swap) → the brand's own pool with a reclaim
// clock; incidental (trial lapse, deletion) → shared pool. Both null userId, hence brandId on the row.

/** Shared pool, unowned, no hold. Exported so every release path keeps the invariant: AVAILABLE with a stale brandId would leak into that tenant's pool. */
export const TO_SHARED_POOL = {
  userId: null,
  assistantId: null,
  poolStatus: "AVAILABLE",
  status: "active",
  brandId: null,
  releasedAt: null,
} as const;

// Deliberate release: back to the brand's pool, AVAILABLE right away — allocation
// (availableForBrand) enforces the boundary, not a cooldown. No brand → shared pool.
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
  /** When an unassigned brand number moves to the shared pool; null when nothing is counting down. */
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
  /** Caller ID outbound test calls go out from for customers with no number of
   *  their own. For a brand admin this is their brand's effective value. */
  outboundCaller: string | null;
  /** True when that value is the platform's, seen by a brand that hasn't set its own. */
  outboundCallerInherited: boolean;
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

/** Pool vs user numbers for a viewer. Platform (null) sees everything it's billed for, brand-tagged; a brand sees ONLY its own numbers — never the shared pool or another brand's. */
export async function getOverview(viewerBrandId: string | null = null): Promise<OverviewDto> {
  const sender = normalize(getEffective("twilio.fromNumber")) || null;
  // Same rule as the SMS sender: the number shown in the outbound card isn't
  // repeated in the free pool below it. Only while it is unassigned — once a
  // customer holds it, it belongs in their row.
  const outboundSender =
    normalize(
      viewerBrandId ? getBrandOverride(viewerBrandId, "twilio.outboundNumber") : "",
    ) || normalize(getEffective("twilio.outboundNumber")) || null;
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
    if (!r.userId && outboundSender && normalize(r.number) === outboundSender) continue; // shown in the outbound card
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
  // A brand admin sees their brand's effective caller ID (own override, else the
  // platform's); a platform admin sees the platform value itself.
  const brandOutbound = viewerBrandId
    ? normalize(getBrandOverride(viewerBrandId, "twilio.outboundNumber"))
    : "";
  const platformOutbound = normalize(getEffective("twilio.outboundNumber"));
  const outbound = brandOutbound || platformOutbound;
  return {
    pool,
    userNumbers,
    smsSender: sender ? getEffective("twilio.fromNumber") : null,
    outboundCaller: outbound || null,
    outboundCallerInherited: Boolean(viewerBrandId) && !brandOutbound && Boolean(platformOutbound),
  };
}

/** Numbers no customer may be handed, however free they look.
 *
 *  The shared outbound caller IDs are dialling identities other customers' test
 *  calls go out on. Assign one to a customer and every other customer of that
 *  brand (or of the platform) starts calling from that customer's private line —
 *  and their callbacks land there too. Both spellings are listed because the
 *  setting is normalised on save but a legacy value may have no leading "+". */
function reservedCallerIds(brandId: string | null | undefined): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const clean = normalize(raw);
    if (!clean) return;
    out.add(clean);
    out.add(clean.startsWith("+") ? clean.slice(1) : `+${clean}`);
  };
  add(getEffective("twilio.outboundNumber"));
  if (brandId) add(getBrandOverride(brandId, "twilio.outboundNumber"));
  return [...out];
}

/** Where clause for numbers a brand's customer may take: own pool or shared. Without it "AVAILABLE with a brandId" would go to anyone, and Acme would pay for Northwind's number. */
export function availableForBrand(brandId: string | null | undefined) {
  const reserved = reservedCallerIds(brandId);
  return {
    userId: null,
    poolStatus: "AVAILABLE",
    status: "active",
    ...(reserved.length ? { number: { notIn: reserved } } : {}),
    // Null brandId is the shared pool, open to everyone; a platform-direct
    // customer (no brand) may only ever draw from it.
    ...(brandId ? { OR: [{ brandId }, { brandId: null }] } : { brandId: null }),
  };
}

/** Pick the next number a customer of `brandId` may have — their brand's own
 *  inventory before the shared pool. Null when nothing is free to them. */
export async function nextAvailableForBrand(brandId: string | null | undefined) {
  const reserved = reservedCallerIds(brandId);
  const notReserved = reserved.length ? { number: { notIn: reserved } } : {};
  if (brandId) {
    const own = await prisma.phoneNumber.findFirst({
      where: { userId: null, poolStatus: "AVAILABLE", status: "active", brandId, ...notReserved },
      orderBy: { createdAt: "asc" },
    });
    if (own) return own;
  }
  return prisma.phoneNumber.findFirst({
    where: { userId: null, poolStatus: "AVAILABLE", status: "active", brandId: null, ...notReserved },
    orderBy: { createdAt: "asc" },
  });
}

/** Tenant owning a number, for reach checks. Null = shared pool or no such number; reassign decides the rest. */
export async function numberBrandId(id: string): Promise<string | null> {
  const row = await prisma.phoneNumber.findUnique({ where: { id }, select: { brandId: true } });
  return row?.brandId ?? null;
}

/** Assignable agents, scoped to the viewer's tenant so a brand admin only sees their own customers. Null viewer = all. */
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
  // Real Twilio rate per number (cached per country); default only if pricing fails.
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
  // No SID until purchased — the number itself keys the buy.
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
  // Best-effort: a failed check stores null and Re-sync fills it in later.
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

/** Releases a number (target null) or assigns it to an agent, rewiring Vapi and syncing the profile. Release here is the DELIBERATE path: brand pool with the reclaim clock running. */
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

/** Clears the SMS sender with an empty override (not a delete) so it also masks TWILIO_FROM_NUMBER from .env. */
export async function unassignSmsSender(): Promise<void> {
  await setSettingValue("twilio.fromNumber", "");
}

/* --------------------- Outbound caller ID (test calls) --------------------- */

/** Where the caller ID on an outbound test call came from. The customer hears
 *  their own agent either way — this only says whose number appears on the
 *  handset, which is what decides who pays for the line. */
export type CallerIdSource = "customer" | "brand" | "platform";

export interface OutboundCallerId {
  /** E.164 number the call is placed FROM. */
  number: string;
  source: CallerIdSource;
}

/** Set the platform-wide outbound caller ID (super admin), or a single brand's
 *  override of it. A brand's value wins for that brand's customers. */
export async function assignOutboundCaller(
  number: string,
  brandId: string | null = null,
): Promise<string> {
  const clean = normalize(number);
  if (!/^\+?\d{6,15}$/.test(clean)) throw badRequest("That doesn't look like a valid phone number");
  // The other half of reservedCallerIds: a shared caller ID must not be a line a
  // customer already answers on, or their callers reach a stranger's agent.
  const held = await prisma.phoneNumber.findFirst({
    where: { number: { in: [clean, clean.startsWith("+") ? clean.slice(1) : `+${clean}`] }, userId: { not: null } },
    select: { number: true },
  });
  if (held)
    throw badRequest(
      `${held.number} is assigned to a customer — pick a number that isn't in use as someone's receptionist line.`,
    );
  if (brandId) await saveBrandIntegrations(brandId, { "twilio.outboundNumber": clean });
  else await setSettingValue("twilio.outboundNumber", clean);
  return clean;
}

/** Clear with an empty override rather than a delete, so it also masks
 *  TWILIO_OUTBOUND_NUMBER from .env (same reason as the SMS sender). */
export async function unassignOutboundCaller(brandId: string | null = null): Promise<void> {
  // A brand clearing its own override falls back to the platform number, so the row is
  // deleted (INHERIT) rather than blanked — a blank would read as "no outbound calling".
  if (brandId) await saveBrandIntegrations(brandId, { "twilio.outboundNumber": INHERIT_SENTINEL });
  else await setSettingValue("twilio.outboundNumber", "");
}

/** The number a customer's own outbound calls go out from.
 *
 *  Their own line first — a customer (or a brand) that bought a number should
 *  dial from it, so the person they ring sees a number they can ring back. Only
 *  when they have none does the shared platform caller ID stand in. Which number
 *  is used never changes WHICH agent answers: that is always the caller's own
 *  assistant, picked separately by the route. */
export async function resolveOutboundCallerId(userId: string): Promise<OutboundCallerId | null> {
  const own = await prisma.phoneNumber.findFirst({
    where: { userId, poolStatus: "ASSIGNED", status: "active" },
    orderBy: { createdAt: "desc" },
    select: { number: true },
  });
  if (own?.number) return { number: own.number, source: "customer" };

  const brandId = await brandIdForOwner(userId).catch(() => null);
  if (brandId) {
    const brandOwn = normalize(getBrandOverride(brandId, "twilio.outboundNumber"));
    if (brandOwn) return { number: brandOwn, source: "brand" };
  }

  const platform = normalize(getEffective("twilio.outboundNumber"));
  if (platform) return { number: platform, source: "platform" };
  return null;
}

/** Drop pool rows whose Twilio number the account no longer owns. */
/** Reflects a self-serve claim in the pool: release the user's other numbers, then mark this one ASSIGNED. */
export async function markNumberAssignedToUser(opts: {
  userId: string;
  number: string;
  assistantId: string | null;
}): Promise<void> {
  const brandId = await brandIdForOwner(opts.userId);
  // One number per agent. A self-swap is a deliberate give-up → brand pool, clock running.
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

/** Releases a user's number to the shared pool, keeping their Vapi assistant so a re-subscribe reuses it. Returns the freed number or null. */
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

/** Hands a discontinued customer's number back to Twilio for good — row deleted, not pooled, since we no longer own it. Irreversible; only the grace-lapse sweep calls this. Vapi first, then Twilio, then the row; if Twilio fails the row stays so a number we still pay for stays on the books. */
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

/** Reconciles the pool against Twilio. No creds = account switch, so all Twilio rows are purged; otherwise repairs SIDs and assignments. Throws if creds are rejected. */
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
      // Backfills SID, the real per-country price (over the old flat $50), and
      // smsCapable for rows that predate the column.
      const data: { twilioSid?: string; monthlyPriceCents?: number; smsCapable?: boolean } = {};
      if (!r.twilioSid) data.twilioSid = o.sid;
      if (r.smsCapable !== o.smsCapable) data.smsCapable = o.smsCapable;
      const realPrice = await monthlyPriceCentsFor(o.number);
      if (realPrice != null && realPrice !== r.monthlyPriceCents) data.monthlyPriceCents = realPrice;
      if (Object.keys(data).length) await prisma.phoneNumber.update({ where: { id: r.id }, data });
    }
  }
  const assignmentsSynced = await backfillAssignments();
  // Give cross-org blocked numbers a fresh chance; a still-locked one re-blocks on the next claim.
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

// Auto-replenish: keep `target` AVAILABLE numbers. Import owned Twilio numbers
// first (free); buy only when auto-purchase is on.

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

// Brand reclaim ("use it or lose it"): an unassigned brand number not reused within
// the window moves to the shared pool, so brands can't park inventory the platform pays for.

const RECLAIM_DAYS_KEY = "phones.brandReclaimDays";
const DEFAULT_RECLAIM_DAYS = 7;
/** A window longer than a year would quietly strand paid-for inventory.
 *  0 is allowed and means "return it to the shared pool on the next sweep". */
const MAX_RECLAIM_DAYS = 365;

/** How long a brand keeps an unassigned number before the platform reclaims it. */
export async function getReclaimDays(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: RECLAIM_DAYS_KEY } });
  // Blank is "unset", not zero: Number("") is 0, and 0 is a legitimate value, so a
  // cleared field would otherwise strip every brand's unassigned numbers within the hour.
  const raw = (row?.value ?? "").trim();
  if (!raw) return DEFAULT_RECLAIM_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_RECLAIM_DAYS ? n : DEFAULT_RECLAIM_DAYS;
}

/** Hourly: brand numbers past the reclaim window go to the shared pool. Re-reads the window each pass so shortening it releases the backlog. `userId: null` is the safety clause — never reclaim a number mid-call. */
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

/** Numbers locked to a DIFFERENT Vapi org (import 409s "already in use by another org"), remembered digit-only so they stop being offered. */
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

/** Tops the pool up to `target`: import owned numbers first, buy only if auto-purchase is on. Idempotent. */
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
