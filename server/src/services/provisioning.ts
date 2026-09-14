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

/** Gate for creating live infra: paid plan or card-backed trial, admin exempt. Closes the direct-API path where a no-plan account could mint a real number. */
export async function canProvisionForUser(userId: string, role?: string): Promise<boolean> {
  // ADMIN only: a brand admin gets a test agent, but the SUPER_ADMIN runs the
  // platform and must never have one provisioned.
  if (role === "ADMIN") return true;
  const profile = await tenantForUser(userId)
    .then((db) => db.profile.findUnique({ where: { userId }, select: { subscriptionStatus: true } }))
    .catch(() => null);
  const sub = profile?.subscriptionStatus;
  return sub === "trialing" || sub === "active";
}

/** Creates the live Vapi assistant from agent_config. Idempotent; returns false and leaves the conversion pending when Vapi isn't configured so it can be retried. */
export async function provisionAgentForUser(userId: string): Promise<boolean> {
  const db = await tenantForUser(userId).catch(() => null);
  if (!db) return false; // the platform's own people have no agent to provision
  const conversion = await db.conversion.findUnique({
    where: { userId },
    include: { user: { include: { profile: true } } },
  });
  if (!conversion) return false;
  const isAdmin = conversion.user.role === "ADMIN";

  // Only a pool row counts as assigned; the admin's seeded placeholder
  // receptionistNumber has no pool row and isn't routable.
  const ownedNumber = await prisma.phoneNumber.findFirst({
    where: { userId },
    select: { number: true },
  });

  // Customers claim their own number; the admin has no claim UI, so for them
  // "done" also requires a pool number.
  const fullyProvisioned = isAdmin ? Boolean(ownedNumber) : true;
  if (conversion.status === "approved" && conversion.vapiAssistantId && fullyProvisioned) {
    return true;
  }

  // Paying customers (trial counts) and the admin only — never a bare signup.
  const sub = conversion.user.profile?.subscriptionStatus;
  if (!isAdmin && sub !== "trialing" && sub !== "active") return false;

  // Can't provision without Vapi — leave it pending so a later retry can finish.
  if (!integrationsStatus().vapi) return false;

  // Older signups stored the business name only on the profile, so mirror it in.
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

  // No auto-assign for customers (they claim via quick-setup). Admin is the exception.
  // Import on Vapi first so a failure leaves the number AVAILABLE, not half-assigned.
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

/** Re-syncs the live assistant's per-call cap to current remaining minutes. Never throws. */
export async function syncAssistantCallCap(userId: string): Promise<void> {
  if (!integrationsStatus().vapi) return;
  const conversion = await tenantForUser(userId)
    .then((db) => db.conversion.findUnique({ where: { userId }, select: { vapiAssistantId: true } }))
    .catch(() => null);
  if (!conversion?.vapiAssistantId) return;

  const ent = await getEntitlement(userId);

  // Blocked customers get the assistant detached from their number so the AI
  // doesn't answer at all; re-routed once entitled again.
  const phone = await prisma.phoneNumber.findFirst({ where: { userId }, select: { number: true } });
  if (phone?.number) {
    await setNumberAssistant(phone.number, ent.blocked ? null : conversion.vapiAssistantId);
  }

  // Platform ceiling applies on top, so unlimited plans aren't exempt. `null` is
  // written through, not skipped — otherwise a cap could never be lifted.
  const cap = applyCallDurationCap(remainingCallSeconds(ent), await getCallDurationCapSetting());
  await setAssistantMaxDuration(
    conversion.vapiAssistantId,
    cap == null ? null : Math.max(VAPI_MIN_CALL_SECONDS, cap),
  );
}

// resyncAllCallCaps PATCHes only maxDurationSeconds — a full re-push once stripped
// transfer/booking tools off every live agent. Sequential so one failure can't abort the rest.
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
      // Written even when null, or switching the ceiling OFF would leave capped accounts stuck.
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

/** FULL re-push of every assistant (prompts + tools + server) — backfills the webhook secret onto pre-secret assistants. Admin-triggered only, never automatic; idempotent. */
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

/** Post-call settle: reconcile with Stripe (exhausted trial converts, exhausted plan renews early), then re-sync the call cap. Idempotent. */
export async function settleAfterCall(userId: string): Promise<void> {
  try {
    await reconcileSubscription(userId);
  } catch {
    /* best-effort — validateTrial on the next call also reconciles */
  }
  await syncAssistantCallCap(userId);
}

/** Tears down a customer's Vapi assistant and number before account deletion. Never throws. */
export async function deprovisionAgentForUser(userId: string): Promise<void> {
  if (!integrationsStatus().vapi) return;
  const conversion = await tenantForUser(userId)
    .then((db) => db.conversion.findUnique({ where: { userId }, select: { vapiAssistantId: true } }))
    .catch(() => null);
  if (!conversion) return;

  if (conversion.vapiAssistantId) {
    await deleteAssistant(conversion.vapiAssistantId);
  }
  // Back to Twilio for good, not a pool — nobody is left to use it. Same path as
  // a lapsed grace period; it also handles the Vapi release.
  await releaseNumberPermanently(userId);
}

/** Deletes Vapi assistants/numbers that belong to no customer (e.g. a user removed directly in the DB). Best-effort. */
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

  // Safety bailout: an empty known-set almost always means the wrong DB or a shared
  // Vapi key (dev box with the prod key). Deleting on it would wipe the whole account.
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
