import { prisma } from "../prisma.js";
import { integrationsStatus } from "./settings.js";
import { isTwilioConfigured } from "./sms.js";
import { nextAvailableForBrand } from "./phones.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { allTenants, tenantForUser } from "./tenantDb.js";
import {
  upsertAssistant,
  importTwilioNumber,
  deleteAssistant,
  listVapiAssistants,
  listVapiPhoneNumbers,
  deleteVapiPhoneNumber,
  setAssistantMaxDuration,
  setNumberAssistant,
} from "./vapi.js";
import {
  getCallDurationCap,
  getEntitlement,
  remainingCallSeconds,
  reconcileSubscription,
  VAPI_MIN_CALL_SECONDS,
} from "./trial.js";
import { applyCallDurationCap, getCallDurationCapSetting } from "./callDurationCap.js";
import { replenishPool, releaseNumberPermanently } from "./phones.js";
import type { AgentConfig } from "../lib/agentConfig.js";

/**
 * Whether this account may have live infrastructure (a Vapi assistant, a Twilio
 * number) created for it. Mirrors the gate inside provisionAgentForUser so every
 * entry point applies the SAME rule: a paid plan or a card-backed trial, with the
 * platform admin exempt (they have no subscription but still need an agent).
 *
 * Exists because provisioning is reachable from several routes — claiming or
 * buying a number, an explicit agent sync — and each one used to trust `requireAuth`
 * alone. The UI funnels customers through plan → card → number, so a legitimate
 * user never trips this; it closes the direct-API path where a no-plan account
 * could mint a real number and a live assistant.
 */
export async function canProvisionForUser(userId: string, role?: string): Promise<boolean> {
  // ADMIN only, deliberately not every admin role: a brand admin gets a real
  // agent so they can place test calls, but the SUPER_ADMIN runs the platform
  // and must never have one provisioned for them.
  if (role === "ADMIN") return true;
  const profile = await tenantForUser(userId)
    .then((db) => db.profile.findUnique({ where: { userId }, select: { subscriptionStatus: true } }))
    .catch(() => null);
  const sub = profile?.subscriptionStatus;
  return sub === "trialing" || sub === "active";
}

/**
 * Provision a customer's AI receptionist on the admin's infrastructure: create
 * a live Vapi assistant from their captured agent_config. The phone number is
 * claimed separately by the customer from the quick-setup modal
 * (POST /profile/claim-number), which routes it to this assistant and emails them.
 *
 * Idempotent and best-effort: safe to call more than once (e.g. retried after
 * the admin configures Vapi). A no-op once the assistant is already live. Returns
 * false and leaves the conversion "pending" when Vapi isn't configured yet, so
 * it can be retried later without losing the request.
 */
export async function provisionAgentForUser(userId: string): Promise<boolean> {
  const db = await tenantForUser(userId).catch(() => null);
  if (!db) return false; // the platform's own people have no agent to provision
  const conversion = await db.conversion.findUnique({
    where: { userId },
    include: { user: { include: { profile: true } } },
  });
  if (!conversion) return false;
  const isAdmin = conversion.user.role === "ADMIN";

  // A number is "really assigned" only when it's tracked in the pool table for this
  // user. For admins we ignore the seeded placeholder Profile.receptionistNumber
  // (never imported to Vapi / no pool row) so they still draw a real, routable number.
  const ownedNumber = await prisma.phoneNumber.findFirst({
    where: { userId },
    select: { number: true },
  });

  // Already provisioned → nothing to do. Customers only need a live assistant (they
  // claim their number from the quick-setup modal, POST /profile/claim-number). The
  // admin additionally needs an auto-assigned number, since it has no claim UI — so
  // for an admin we only short-circuit once a pool number is actually assigned.
  const fullyProvisioned = isAdmin ? Boolean(ownedNumber) : true;
  if (conversion.status === "approved" && conversion.vapiAssistantId && fullyProvisioned) {
    return true;
  }

  // Provision paying customers (trial counts) and the platform admin — who has no
  // subscription/onboarding but still needs a live agent + number to test with.
  // Never on a bare customer signup.
  const sub = conversion.user.profile?.subscriptionStatus;
  if (!isAdmin && sub !== "trialing" && sub !== "active") return false;

  // Can't provision without Vapi — leave it pending so a later retry can finish.
  if (!integrationsStatus().vapi) return false;

  // Create (or reuse) the live Vapi assistant from the captured config.
  // Mirror the profile's business name into the config if it's missing (older
  // signups stored it only on the profile, not the agent config).
  const config = conversion.agentConfig as unknown as AgentConfig;
  const businessName = conversion.user.profile?.businessName?.trim();
  if (businessName && !config.identity.businessName?.trim()) {
    config.identity.businessName = businessName;
    config.identity.assistantName = `${businessName} Receptionist`;
  }
  // Cap each real inbound call to the owner's remaining trial/plan minutes
  // (null = unlimited plan → uncapped).
  const callCap = await getCallDurationCap(userId);
  const assistantId = await upsertAssistant(config, conversion.vapiAssistantId, {
    maxDurationSeconds: callCap ?? undefined,
    ownerId: userId,
  });

  // Customers claim their own number from the quick-setup modal
  // (POST /profile/claim-number), which routes it to the assistant + emails them —
  // so we do NOT auto-assign here. The platform admin is the exception: it has no
  // quick-setup flow, so draw an AVAILABLE pool number now and route it to the
  // assistant. Import on Vapi first so a failure leaves the number AVAILABLE rather
  // than half-assigned.
  if (isAdmin && isTwilioConfigured() && !ownedNumber) {
    try {
      // Their own brand's inventory before the shared pool — a released number
      // stays with the brand that paid for it (see nextAvailableForBrand).
      const brandId = await brandIdForOwner(userId);
      const poolNumber = await nextAvailableForBrand(brandId);
      if (poolNumber) {
        await importTwilioNumber({ number: poolNumber.number, assistantId });
        await prisma.phoneNumber.update({
          where: { id: poolNumber.id },
          data: {
            userId,
            assistantId,
            poolStatus: "ASSIGNED",
            status: "active",
            // Stamp the tenant so the number tracks back to this customer's
            // brand — and stays with it through a later release.
            brandId,
          },
        });
        // Keep the profile in sync so the dashboard + sidebar show the number.
        await db.profile.update({
          where: { userId },
          data: { receptionistNumber: poolNumber.number, numberActivated: true, phoneNumberId: poolNumber.id },
        });
        // A pool number just left the pool — top it back up (best-effort).
        void replenishPool().catch(() => {});
      } else {
        console.warn(
          `[provision] no AVAILABLE pool number for admin ${userId}; add one in Admin → Phone Numbers.`,
        );
      }
    } catch (e) {
      console.error("[provision] admin pool number assignment failed:", e instanceof Error ? e.message : e);
    }
  }

  // Persist provisioning (+ the personalised config).
  await db.conversion.update({
    where: { id: conversion.id },
    data: {
      status: "approved",
      approvedAt: new Date(),
      vapiAssistantId: assistantId,
      agentConfig: config as object,
    },
  });

  return true;
}

/**
 * Re-sync a customer's live Vapi assistant cap to their CURRENT remaining
 * minutes, so real inbound calls are cut at the limit as the allowance depletes.
 * Call after usage is recorded or the subscription changes. Best-effort, never
 * throws. Unlimited plans keep a generous cap (Vapi's max).
 */
export async function syncAssistantCallCap(userId: string): Promise<void> {
  if (!integrationsStatus().vapi) return;
  const conversion = await tenantForUser(userId)
    .then((db) => db.conversion.findUnique({ where: { userId }, select: { vapiAssistantId: true } }))
    .catch(() => null);
  if (!conversion?.vapiAssistantId) return;

  const ent = await getEntitlement(userId);

  // Freeze/unfreeze the live number for INCOMING calls. A blocked customer (trial
  // ended / plan minutes used up with auto-renew off / past_due) shouldn't have
  // their AI answer at all — so detach the assistant from their Vapi number. When
  // entitled again (e.g. after a renewal) re-route it. Best-effort.
  const phone = await prisma.phoneNumber.findFirst({ where: { userId }, select: { number: true } });
  if (phone?.number) {
    await setNumberAssistant(phone.number, ent.blocked ? null : conversion.vapiAssistantId);
  }

  // Per-call cap (belt-and-suspenders for an outbound/web call that still starts).
  // The platform ceiling is applied on top, so an unlimited plan is no longer an
  // exemption — it is the account a minute-burner would pick if it were.
  // `null` (uncapped) is written through rather than skipped: an assistant that
  // was capped earlier must be released when the reason for the cap goes away,
  // or lowering a cap would be a one-way door.
  const cap = applyCallDurationCap(remainingCallSeconds(ent), await getCallDurationCapSetting());
  await setAssistantMaxDuration(
    conversion.vapiAssistantId,
    cap == null ? null : Math.max(VAPI_MIN_CALL_SECONDS, cap),
  );
}

/**
 * Re-stamp every live assistant's per-call cap. Run when the platform ceiling
 * changes, so it applies to the next call rather than waiting for each customer
 * to hit a billing event.
 *
 * Deliberately PATCHes the single `maxDurationSeconds` field per assistant
 * instead of rebuilding the assistant: a full re-push would rewrite prompts and
 * tools, and a bad run there once stripped transfer/booking tools off every live
 * agent. A cap sweep has no business touching either.
 *
 * Best-effort and sequential — one slow/failed assistant must not abort the rest,
 * and a burst of parallel writes to Vapi buys nothing for a background job.
 */
/** Every provisioned agent, from every brand's database. */
async function liveConversions(): Promise<{ userId: string; vapiAssistantId: string; agentConfig: unknown }[]> {
  const out: { userId: string; vapiAssistantId: string; agentConfig: unknown }[] = [];
  for (const { db } of await allTenants()) {
    const rows = await db.conversion.findMany({
      where: { vapiAssistantId: { not: null } },
      select: { userId: true, vapiAssistantId: true, agentConfig: true },
    });
    for (const r of rows) {
      if (r.vapiAssistantId) out.push({ userId: r.userId, vapiAssistantId: r.vapiAssistantId, agentConfig: r.agentConfig });
    }
  }
  return out;
}

export async function resyncAllCallCaps(): Promise<{ updated: number; failed: number }> {
  if (!integrationsStatus().vapi) return { updated: 0, failed: 0 };
  const setting = await getCallDurationCapSetting();
  const conversions = await liveConversions();

  let updated = 0;
  let failed = 0;
  for (const c of conversions) {
    try {
      const ent = await getEntitlement(c.userId);
      const cap = applyCallDurationCap(remainingCallSeconds(ent), setting);
      // Written even when null. Switching the ceiling OFF has to actually
      // release the accounts it capped — skipping the write here would leave an
      // unlimited-plan customer stuck on the old ceiling with nothing to undo it.
      await setAssistantMaxDuration(
        c.vapiAssistantId!,
        cap == null ? null : Math.max(VAPI_MIN_CALL_SECONDS, cap),
      );
      updated += 1;
    } catch (err) {
      failed += 1;
      console.error(`[call-cap] resync failed for user=${c.userId}:`, err);
    }
  }
  console.log(`[call-cap] resync done — updated=${updated} failed=${failed}`);
  return { updated, failed };
}

/**
 * Re-push every live assistant's full config to Vapi.
 *
 * One-time backfill for the webhook secret: assistants created before the
 * secret existed carry a `server` config without it, so — once the webhook
 * starts enforcing the secret — their real calls would be rejected until the
 * assistant is rebuilt. Running this once stamps the current `server.secret`
 * (and anything else in the current payload) onto every existing assistant.
 * New assistants already get it at creation, so this never needs re-running for
 * them; re-running is harmless (idempotent — it just re-pushes the same config).
 *
 * Unlike resyncAllCallCaps this is a FULL rebuild (prompts + tools + server), so
 * it's admin-triggered, never automatic. Sequential + best-effort so one bad
 * assistant can't abort the sweep, and to stay well under Vapi's API rate limit.
 */
export async function resyncAllAssistants(): Promise<{ updated: number; failed: number }> {
  if (!integrationsStatus().vapi) return { updated: 0, failed: 0 };
  const conversions = await liveConversions();

  let updated = 0;
  let failed = 0;
  for (const c of conversions) {
    try {
      await upsertAssistant(c.agentConfig as unknown as AgentConfig, c.vapiAssistantId, {
        ownerId: c.userId,
      });
      updated += 1;
    } catch (err) {
      failed += 1;
      console.error(`[assistant-resync] failed for user=${c.userId}:`, err);
    }
  }
  console.log(`[assistant-resync] done — updated=${updated} failed=${failed}`);
  return { updated, failed };
}

/**
 * Settle a customer's entitlement right after a call ends:
 *  1. Reconcile with Stripe. A just-exhausted trial (minutes OR date) ends now,
 *     charges the card saved at onboarding, and converts to the paid plan. An
 *     active plan whose included minutes just ran out renews its cycle early —
 *     charges a fresh full period and tops the minutes back up — so the user is
 *     never blocked (a failed charge → past_due → blocked).
 *  2. Re-sync the live assistant's per-call cap to whatever entitlement remains
 *     (grows to the plan's minutes on conversion, drops to the minimum if blocked).
 * Best-effort and idempotent — a no-op for a healthy mid-trial user.
 */
export async function settleAfterCall(userId: string): Promise<void> {
  try {
    await reconcileSubscription(userId);
  } catch {
    /* best-effort — validateTrial on the next call also reconciles */
  }
  await syncAssistantCallCap(userId);
}

/**
 * Tear down a customer's provisioned resources before their account is deleted:
 * remove the live Vapi assistant and release their number back to the Twilio
 * pool (their DB profile/conversion are removed by the user-delete cascade, so
 * the number automatically frees up for reassignment). Best-effort, never throws.
 */
export async function deprovisionAgentForUser(userId: string): Promise<void> {
  if (!integrationsStatus().vapi) return;
  const conversion = await tenantForUser(userId)
    .then((db) => db.conversion.findUnique({ where: { userId }, select: { vapiAssistantId: true } }))
    .catch(() => null);
  if (!conversion) return;

  if (conversion.vapiAssistantId) {
    await deleteAssistant(conversion.vapiAssistantId);
  }
  // The account is going away, so its number goes back to Twilio for good
  // rather than into a pool: nobody is left to use it, and the platform should
  // stop being billed for it. Same permanent path a lapsed grace period takes —
  // it drops Vapi routing, releases at the carrier and deletes the row (and
  // keeps the row if Twilio refuses, so a number we still pay for stays on the
  // books). That covers the Vapi release for this user's number too.
  await releaseNumberPermanently(userId);
}

/**
 * Reconcile the admin's Vapi account against our DB: delete assistants and
 * release phone numbers that no longer belong to ANY customer. Covers the case
 * where a user was removed directly in the DB (bypassing the deprovision flow,
 * which also wipes the conversion/profile that held the Vapi ids) — the orphaned
 * Vapi assistant is removed and its number returns to the assignable pool.
 * Best-effort; returns counts for visibility.
 */
export async function syncVapiWithDb(): Promise<{ deletedAssistants: number; releasedNumbers: number }> {
  if (!integrationsStatus().vapi) return { deletedAssistants: 0, releasedNumbers: 0 };

  // Every brand's agents and numbers, from every brand's database.
  const liveAssistants = new Set<string | null>();
  const liveNumbers = new Set<string>();
  for (const { db } of await allTenants()) {
    const [convs, profiles] = await Promise.all([
      db.conversion.findMany({ where: { vapiAssistantId: { not: null } }, select: { vapiAssistantId: true } }),
      db.profile.findMany({ where: { receptionistNumber: { not: "" } }, select: { receptionistNumber: true } }),
    ]);
    for (const c of convs) liveAssistants.add(c.vapiAssistantId);
    for (const p of profiles) liveNumbers.add(p.receptionistNumber);
  }

  // Safety bailout: an empty known-set almost always means we're pointed at the
  // wrong database or a shared Vapi key (e.g. a dev box booting with the prod
  // key), NOT that every assistant/number is genuinely orphaned. Deleting on an
  // empty set would wipe the entire Vapi account, so we refuse to reconcile.
  if (liveAssistants.size === 0) {
    console.warn(
      "⚠️  Vapi sync skipped: DB has 0 known assistants — refusing to delete all remote assistants (wrong DB or shared key?).",
    );
    return { deletedAssistants: 0, releasedNumbers: 0 };
  }

  let releasedNumbers = 0;
  try {
    for (const pn of await listVapiPhoneNumbers()) {
      if (!liveNumbers.has(pn.number)) {
        await deleteVapiPhoneNumber(pn.id);
        releasedNumbers++;
      }
    }
  } catch {
    /* best-effort */
  }

  let deletedAssistants = 0;
  try {
    for (const a of await listVapiAssistants()) {
      if (!liveAssistants.has(a.id)) {
        await deleteAssistant(a.id);
        deletedAssistants++;
      }
    }
  } catch {
    /* best-effort */
  }

  return { deletedAssistants, releasedNumbers };
}
