import express from "express";
import { z } from "zod";
import { requestTenant, tenantForUser } from "../services/tenantDb.js";
import { asyncHandler, notFound, badRequest, HttpError } from "../lib/http.js";
import { clampName, titleCaseName, DEFAULT_AGENT_CONFIG } from "../lib/agentConfig.js";
import { normalizeCountry } from "../lib/countryStyles.js";
import { requireAuth } from "../middleware/auth.js";
import {
  isTwilioConfigured,
  listTwilioNumbers,
  searchNumbersByPrefix,
  searchNumbersByPattern,
  searchDefaultNumbers,
  type NumberMatch,
  getNumberPricing,
  purchaseNumber,
} from "../services/sms.js";
import {
  markNumberAssignedToUser,
  isUserPurchaseEnabled,
  getAllowedCountries,
  getAllowedPrefixes,
  blockNumber,
  getBlockedNumberDigits,
} from "../services/phones.js";
import { importTwilioNumber, upsertAssistant } from "../services/vapi.js";
import { canProvisionForUser } from "../services/provisioning.js";
import type { AgentConfig } from "../lib/agentConfig.js";
import { integrationsStatus, getEffective } from "../services/settings.js";
import { getEntitlement, billedMinutesFor, getPlanFeatures, chargeTrialAndActivateNow } from "../services/trial.js";
import { canSelectVoice, DEFAULT_AGENT_VOICE_ID } from "../services/voices.js";
import { getTrialDays, getTrialMinutes } from "../services/billing.js";
import { numberAssignedEmail } from "../services/email.js";
import { hasCustomerWorkspace } from "../lib/roles.js";

/** Normalize a phone number to digits-only for reliable comparison. */
const digitsOnly = (n: string) => n.replace(/\D/g, "");

/** The admin-reserved SMS sender number (never claimable). */
function smsSenderDigits(): string {
  return digitsOnly(getEffective("twilio.fromNumber") || "");
}

/**
 * Clamp trial-only choices down to what the plan includes — called the moment a
 * user goes live (claims a number). During the trial every add-on is unlocked, so
 * the config may carry a voice or languages the plan doesn't include; strip those
 * so the live assistant + AI Brain honour the chosen plan's real limits. Mutates
 * and returns the config, plus whether anything changed.
 */
async function clampConfigToPlan(
  userId: string,
  config: AgentConfig,
): Promise<{ config: AgentConfig; changed: boolean }> {
  let changed = false;
  if (config.identity) {
    // Languages — only on a multilingual plan.
    const features = await getPlanFeatures(userId);
    if (!features.multilingual && (config.identity.languages?.length ?? 0) > 0) {
      config.identity.languages = [];
      changed = true;
    }
    // Voice — must be in the plan's Voice Bank category, else fall back to the
    // always-available default (Sarah). The picker is already plan-scoped now.
    const voiceId = config.identity.voiceId;
    if (voiceId && voiceId !== DEFAULT_AGENT_VOICE_ID && !(await canSelectVoice(userId, voiceId))) {
      config.identity.voiceId = DEFAULT_AGENT_VOICE_ID;
      changed = true;
    }
  }
  return { config, changed };
}

/**
 * Reserve `number` for `userId`: set the profile, route it to their live Vapi
 * assistant, flip the pool row to ASSIGNED, and email them. Returns the updated
 * profile. Shared by the claim (pool) and buy (new Twilio number) flows.
 */
async function assignNumberToUser(userId: string, number: string) {
  // Going live commits a trial user to the plan they picked at onboarding: end the
  // trial and charge the saved card NOW, before the number is assigned. Throws a
  // 400 if the charge fails (declined / needs auth), so we never hand out a live
  // number the user hasn't paid for — they fix their card and retry. A no-op for
  // anyone who isn't a trialing user (already active, no card, later number swap).
  const { converted } = await chargeTrialAndActivateNow(userId, { number });

  const prev = await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: { receptionistNumber: true },
  });
  const prevNumber = prev?.receptionistNumber ?? "";

  const profile = await (await tenantForUser(userId)).profile.update({
    where: { userId },
    data: { receptionistNumber: number },
  });

  // Route the number to this user's LIVE Vapi assistant so real inbound calls
  // are answered by their AI. The assistant may not exist yet — the user can
  // pick their number from the quick-setup modal before ever opening the AI
  // Brain, so the conversion's vapiAssistantId can still be null here. Provision
  // it now (upsertAssistant verifies/recreates a stale id) so routing never
  // silently no-ops on a missing assistant — which is what left numbers claimed
  // in the DB + the "you're live" email sent, but never imported into Vapi.
  let assistantId: string | null = null;
  let routeError: unknown = null;
  const conversion = await (await tenantForUser(userId)).conversion.findUnique({
    where: { userId },
    select: { id: true, vapiAssistantId: true, agentConfig: true },
  });

  // Going live commits them to their plan — clamp any trial-only voice/languages
  // the config still carries down to what the plan includes, and persist it so the
  // live assistant AND the AI Brain both reflect the plan's real limits. (The
  // profile now has the number, so getPlanFeatures/canSelectVoice are plan-scoped.)
  let liveConfig = conversion?.agentConfig as unknown as AgentConfig | undefined;
  if (conversion && liveConfig) {
    const clamped = await clampConfigToPlan(userId, liveConfig);
    liveConfig = clamped.config;
    if (clamped.changed) {
      await (await tenantForUser(userId)).conversion
        .update({ where: { id: conversion.id }, data: { agentConfig: liveConfig as object } })
        .catch(() => {});
    }
  }

  if (integrationsStatus().vapi && conversion && liveConfig) {
    try {
      assistantId = await upsertAssistant(liveConfig, conversion.vapiAssistantId, {
        ownerId: userId,
      });
      if (assistantId && assistantId !== conversion.vapiAssistantId) {
        await (await tenantForUser(userId)).conversion.update({
          where: { id: conversion.id },
          data: { vapiAssistantId: assistantId, status: "approved" },
        });
      }
      await importTwilioNumber({ number, assistantId });
    } catch (e) {
      routeError = e;
      console.error(
        `[assign-number] routing failed for user ${userId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  } else {
    assistantId = conversion?.vapiAssistantId ?? null;
  }

  // Cross-org lock (Vapi 409): this number is owned by a DIFFERENT Vapi org and
  // can never be connected from this project — it just keeps surfacing in the
  // picker and 409ing. Block it so it stops being offered, roll back the tentative
  // assignment (don't leave the user holding a dead number), and surface the error.
  if (routeError instanceof HttpError && routeError.status === 409) {
    await blockNumber(number).catch(() => {});
    await (await tenantForUser(userId)).profile
      .update({ where: { userId }, data: { receptionistNumber: prevNumber } })
      .catch(() => {});
    throw routeError;
  }

  try {
    await markNumberAssignedToUser({ userId, number, assistantId });
  } catch {
    /* best-effort — admin can resync from the Phone Numbers panel */
  }

  // Only tell the customer their AI is "live" once the number is actually routed
  // to the assistant — otherwise the email would be a false promise. Skip it when
  // we just converted them to paid: this template is trial-framed (X trial days /
  // minutes), and notifyPlanActivated already emailed them their plan is active.
  if (!routeError && !converted) {
    void (async () => {
      try {
        if (!integrationsStatus().email) return;
        const user = await (await tenantForUser(userId)).user.findUnique({
          where: { id: userId },
          select: { email: true, fullName: true, profile: { select: { businessName: true } } },
        });
        if (!user?.email) return;
        const [trialDays, trialMinutes] = await Promise.all([getTrialDays(), getTrialMinutes()]);
        await numberAssignedEmail({
          ownerEmail: user.email,
          fullName: user.fullName,
          businessName: user.profile?.businessName ?? undefined,
          number,
          trialDays,
          trialMinutes,
        });
      } catch {
        /* best-effort — never block on the email */
      }
    })();
  }

  // Surface a routing failure so the user knows they aren't live yet instead of
  // believing they are. Preserve a clear, actionable error (e.g. the number is
  // locked to another Vapi org) verbatim; for transient failures the number is
  // saved, so a retry just re-runs the idempotent import.
  if (routeError) {
    if (routeError instanceof HttpError) throw routeError;
    throw new HttpError(
      502,
      "We saved your number but couldn't connect it to your AI yet. Please try again in a moment.",
    );
  }

  return profile;
}

const router = express.Router();

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    let profile = await (await requestTenant(req)).profile.findUnique({ where: { userId: req.user!.sub } });
    // ADMIN and USER accounts are customer-facing and always need a Profile — the
    // AI Brain / Settings pages hang on a skeleton without one. A promoted admin
    // (an existing user upgraded to ADMIN) or any account whose Profile row is
    // missing would otherwise 404 here forever, so self-heal by creating it.
    // STAFF, RESELLER and the SUPER_ADMIN are excluded: they have no customer
    // workspace and are redirected away from these pages, so creating a Profile
    // for them would only mint customer state nothing will ever use.
    if (!profile && hasCustomerWorkspace(req.user!.role) && req.user!.role !== "RESELLER") {
      profile = await (await requestTenant(req)).profile.create({ data: { userId: req.user!.sub } });
    }
    if (!profile) throw notFound("Profile not found");
    // Fold the account email + fullName (User table) into the response — the
    // Profile row has neither column, and the Settings form reads them from here.
    const user = await (await requestTenant(req)).user.findUnique({
      where: { id: req.user!.sub },
      select: { email: true, fullName: true },
    });
    res.json({ ...profile, email: user?.email, fullName: user?.fullName });
  }),
);

const patchSchema = z.object({
  // Title-case a person's name on save so it displays consistently everywhere.
  fullName: z.string().transform(titleCaseName).optional(),
  // Email lives on the User table; trim + lowercase so it stays consistent with login.
  email: z.string().email().transform((s) => s.trim().toLowerCase()).optional(),
  // Clamp to 40 (Vapi's assistant-name limit) instead of rejecting the save.
  businessName: z.string().transform(clampName).optional(),
  mobile: z.string().optional(),
  website: z.string().optional(),
  businessNumber: z.string().optional(),
  address: z.string().optional(),
  // A display country NAME (e.g. "Australia"), not an ISO code — it's injected
  // verbatim into the prompt's "a business based in {country}" line. (The ISO code
  // used for the regional-style block lives separately on agentConfig.identity.country.)
  country: z.string().max(60).optional(),
  industry: z.string().max(100).optional(),
  // Call forwarding: the chosen behaviour, and a boolean the client sends to mark
  // (or clear) that forwarding is live — mapped to the forwardingConfirmedAt stamp.
  forwardingMode: z.enum(["", "all", "overflow"]).optional(),
  forwardingConfirmed: z.boolean().optional(),
});

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const {
      fullName,
      email,
      businessName,
      mobile,
      website,
      businessNumber,
      address,
      country,
      industry,
      forwardingMode,
      forwardingConfirmed,
    } = patchSchema.parse(req.body);
    const userId = req.user!.sub;

    // fullName and email both live on the User record.
    if (fullName !== undefined || email !== undefined) {
      try {
        await (await requestTenant(req)).user.update({
          where: { id: userId },
          data: {
            ...(fullName !== undefined ? { fullName } : {}),
            ...(email !== undefined ? { email } : {}),
          },
        });
      } catch (e) {
        // email is @unique — surface a clear message instead of a 500.
        if ((e as { code?: string }).code === "P2002") {
          throw badRequest("That email is already in use by another account.");
        }
        throw e;
      }
    }

    const profile = await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        ...(businessName !== undefined ? { businessName } : {}),
        ...(mobile !== undefined ? { mobile } : {}),
        ...(website !== undefined ? { website } : {}),
        ...(businessNumber !== undefined ? { businessNumber } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(industry !== undefined ? { industry } : {}),
        ...(forwardingMode !== undefined ? { forwardingMode } : {}),
        // Boolean → timestamp: stamp when confirmed, clear when unset.
        ...(forwardingConfirmed !== undefined
          ? { forwardingConfirmedAt: forwardingConfirmed ? new Date() : null }
          : {}),
      },
    });

    // The Profile row has no email/fullName columns; fold the (possibly updated)
    // account email + fullName into the response so the client store/form sync.
    const user = await (await requestTenant(req)).user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    res.json({ ...profile, email: user?.email, fullName: user?.fullName });
  }),
);

const onboardingSchema = z.object({
  step: z.number().int().min(0).max(8).optional(),
  completed: z.boolean().optional(),
});

// Persist guided-onboarding progress so a returning user resumes where they left
// off. `step` only ever advances (we keep the furthest reached); `completed`
// stamps onboardingCompletedAt and clears the pending step.
router.patch(
  "/onboarding",
  asyncHandler(async (req, res) => {
    const { step, completed } = onboardingSchema.parse(req.body);
    const userId = req.user!.sub;

    const current = await (await requestTenant(req)).profile.findUnique({
      where: { userId },
      select: { onboardingStep: true },
    });
    if (!current) throw notFound("Profile not found");

    const profile = await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        ...(completed
          ? { onboardingCompletedAt: new Date(), onboardingStep: 0 }
          : step !== undefined
            ? { onboardingStep: Math.max(current.onboardingStep, step) }
            : {}),
      },
    });
    res.json(profile);
  }),
);

// Mark the quick-setup modal as seen so it never auto-opens again (the user can
// still open it manually). Stamps the first-seen time once; later calls are a
// no-op on the timestamp. Server-side so it survives a cache clear / new browser.
router.post(
  "/quick-setup-seen",
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const current = await (await requestTenant(req)).profile.findUnique({
      where: { userId },
      select: { quickSetupSeenAt: true },
    });
    if (!current) throw notFound("Profile not found");
    const profile = current.quickSetupSeenAt
      ? await (await requestTenant(req)).profile.findUnique({ where: { userId } })
      : await (await requestTenant(req)).profile.update({ where: { userId }, data: { quickSetupSeenAt: new Date() } });
    res.json(profile);
  }),
);

router.post(
  "/activate-number",
  asyncHandler(async (req, res) => {
    const profile = await (await requestTenant(req)).profile.update({
      where: { userId: req.user!.sub },
      data: { numberActivated: true },
    });
    res.json(profile);
  }),
);

/** Numbers from the connected Twilio account, each flagged taken/mine. */
router.get(
  "/available-numbers",
  asyncHandler(async (req, res) => {
    if (!isTwilioConfigured()) {
      res.json({ configured: false, numbers: [] });
      return;
    }
    const sender = smsSenderDigits();
    // Show every Twilio number. The admin's reserved SMS sender stays in the
    // list but is flagged taken (never claimable) instead of being hidden, so a
    // number that's already in use is visibly accounted for.
    const all = await listTwilioNumbers();
    const rows = await (await requestTenant(req)).profile.findMany({
      where: { receptionistNumber: { not: "" } },
      select: { receptionistNumber: true, userId: true },
    });
    const mySub = req.user!.sub;
    // Compare on digits so formatting differences can't slip a held number through.
    const takenByOthers = new Set(
      rows.filter((r) => r.userId !== mySub).map((r) => digitsOnly(r.receptionistNumber)),
    );
    const mineNumber = rows.find((r) => r.userId === mySub)?.receptionistNumber ?? null;
    const mineDigits = mineNumber ? digitsOnly(mineNumber) : null;
    // Drop numbers we already know are locked to another Vapi org (would 409 on claim).
    const blocked = await getBlockedNumberDigits();
    const numbers = all
      .filter((number) => !blocked.has(digitsOnly(number)))
      .map((number) => {
        const d = digitsOnly(number);
        return {
          number,
          taken: takenByOthers.has(d) || (Boolean(sender) && d === sender),
          mine: mineDigits != null && d === mineDigits,
        };
      });
    res.json({ configured: true, numbers, canBuyMore: await isUserPurchaseEnabled() });
  }),
);

const claimSchema = z.object({ number: z.string().min(3), country: z.string().optional() });

/**
 * Persist the customer's ISO country onto their agent config (identity.country)
 * so the live assistant picks up the matching regional style. Called from the
 * onboarding number flows with the country the user selected. Best-effort — a
 * blank/invalid country is ignored. Runs BEFORE the number is routed so the very
 * first assistant push already carries the regional style.
 */
async function persistAgentCountry(userId: string, country?: string): Promise<void> {
  const iso = normalizeCountry(country);
  if (!iso) return;
  const conversion = await (await tenantForUser(userId)).conversion.findUnique({
    where: { userId },
    select: { id: true, agentConfig: true },
  });
  if (conversion) {
    const cfg = (conversion.agentConfig ?? {}) as { identity?: Record<string, unknown> };
    const identity = { ...(cfg.identity ?? {}), country: iso };
    await (await tenantForUser(userId)).conversion.update({
      where: { id: conversion.id },
      data: { agentConfig: { ...cfg, identity } as object },
    });
  } else {
    await (await tenantForUser(userId)).conversion.create({
      data: {
        userId,
        agentConfig: {
          ...DEFAULT_AGENT_CONFIG,
          identity: { ...DEFAULT_AGENT_CONFIG.identity, country: iso },
        } as object,
      },
    });
  }
}

/** Reserve a number from the pool for this user. */
router.post(
  "/claim-number",
  asyncHandler(async (req, res) => {
    const { number, country } = claimSchema.parse(req.body);
    // A number is live infrastructure (recurring Twilio cost + a Vapi assistant
    // created to route it to), so it follows the same entitlement rule as every
    // other provisioning path. The quick-setup wizard already walks customers
    // through plan → card → number, so this only ever fires on a direct API call.
    if (!(await canProvisionForUser(req.user!.sub, req.user!.role)))
      throw badRequest("Choose a plan before claiming your number.");
    if (!isTwilioConfigured()) throw badRequest("Phone numbers aren't configured yet.");
    // The SMS sender number is reserved — never claimable by a customer.
    const sender = smsSenderDigits();
    if (sender && digitsOnly(number) === sender) throw badRequest("That number isn't available.");
    const all = await listTwilioNumbers();
    if (!all.includes(number)) throw badRequest("That number isn't available.");
    const blocked = await getBlockedNumberDigits();
    if (blocked.has(digitsOnly(number)))
      throw badRequest("That number can't be connected (it's registered to another account). Pick another.");
    const taken = await (await requestTenant(req)).profile.findFirst({
      where: { receptionistNumber: number, userId: { not: req.user!.sub } },
      select: { userId: true },
    });
    if (taken) throw badRequest("That number was just taken — pick another.");
    await persistAgentCountry(req.user!.sub, country);
    const profile = await assignNumberToUser(req.user!.sub, number);
    res.json(profile);
  }),
);

/** Countries (ISO codes) + per-country prefixes the admin allows for number selection. */
router.get(
  "/number-countries",
  asyncHandler(async (_req, res) => {
    const [countries, prefixes] = await Promise.all([getAllowedCountries(), getAllowedPrefixes()]);
    res.json({ countries, prefixes });
  }),
);

/** Live Twilio monthly pricing per number type for a country. */
router.get(
  "/number-pricing",
  asyncHandler(async (req, res) => {
    const country = String(req.query.country || "US").toUpperCase().slice(0, 2);
    if (!isTwilioConfigured()) {
      res.json({ currency: "USD", prices: {} });
      return;
    }
    try {
      res.json(await getNumberPricing(country));
    } catch {
      res.json({ currency: "USD", prices: {} });
    }
  }),
);

/** Search Twilio for brand-new, purchasable numbers (gated by the admin toggle). */
router.get(
  "/searchable-numbers",
  asyncHandler(async (req, res) => {
    if (!(await isUserPurchaseEnabled())) throw badRequest("Buying a new number isn't available.");
    if (!isTwilioConfigured()) {
      res.json({ numbers: [] });
      return;
    }
    const country = String(req.query.country || "US").toUpperCase().slice(0, 2);
    const prefix = String(req.query.prefix || "").replace(/\D/g, "").slice(0, 4);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ""), 10) || 0, 0), 20);
    // Free-text digit search, anchored like Twilio's "Match to" control.
    const q = String(req.query.q || "").replace(/\D/g, "").slice(0, 10);
    const matchRaw = String(req.query.match || "anywhere");
    const match: NumberMatch =
      matchRaw === "start" || matchRaw === "end" ? matchRaw : "anywhere";

    // Digits + prefix combine: the digits say WHICH numbers, the prefix says which
    // series. Either can be used alone.
    if (q) {
      const allowedPrefixes = await getAllowedPrefixes();
      res.json({
        numbers: await searchNumbersByPattern(country, q, match, limit || 10, {
          allowedPrefixes: allowedPrefixes[country.toLowerCase()],
          prefix: prefix || undefined,
        }),
      });
      return;
    }

    // A prefix (e.g. AU 02/03/04/07/08) narrows the search to up to 20 matching numbers.
    if (prefix) {
      res.json({ numbers: await searchNumbersByPrefix(country, prefix, limit || 20) });
      return;
    }

    // Default (no prefix): a mix topped up to a minimum of 5, but restricted to the
    // admin-allowed prefixes so a disallowed series (e.g. AU mobile 04) never shows.
    const allowedPrefixes = await getAllowedPrefixes();
    const numbers = await searchDefaultNumbers(
      country,
      allowedPrefixes[country.toLowerCase()],
      5,
    );
    res.json({ numbers });
  }),
);

/**
 * Buy a brand-new Twilio number (on the admin's account), add it to the pool,
 * and assign it to this user — gated by the admin toggle. Costs money, so only
 * call on an explicit user confirmation.
 */
router.post(
  "/buy-number",
  asyncHandler(async (req, res) => {
    if (!(await isUserPurchaseEnabled())) throw badRequest("Buying a new number isn't available.");
    // Same entitlement gate as /claim-number — this one additionally spends money
    // on Twilio the moment it succeeds.
    if (!(await canProvisionForUser(req.user!.sub, req.user!.role)))
      throw badRequest("Choose a plan before buying a number.");
    const { number, country } = claimSchema.parse(req.body);
    if (!isTwilioConfigured()) throw badRequest("Phone numbers aren't configured yet.");
    // Don't let a number already held by someone else be (re)bought.
    const held = await (await requestTenant(req)).profile.findFirst({
      where: { receptionistNumber: number, userId: { not: req.user!.sub } },
      select: { userId: true },
    });
    if (held) throw badRequest("That number was just taken — pick another.");
    try {
      await purchaseNumber(number);
    } catch (e) {
      // Surface the real Twilio reason (e.g. regulatory bundle/address required
      // for AU numbers, trial-account limits, billing) so it's actionable.
      const reason = e instanceof Error ? e.message : "";
      console.error("[buy-number] purchase failed:", reason || e);
      throw badRequest(
        reason ? `Couldn't buy that number: ${reason}` : "Couldn't buy that number — it may no longer be available.",
      );
    }
    await persistAgentCountry(req.user!.sub, country);
    const profile = await assignNumberToUser(req.user!.sub, number);
    res.json(profile);
  }),
);

router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    // Source minutes from the entitlement (trial vs active plan) so the dashboard
    // matches the sidebar — on plan activation the plan's minutes reset to 0/N,
    // not the stale trial counter.
    const ent = await getEntitlement(req.user!.sub);

    const db = await requestTenant(req);
    const conversion = await db.conversion.findUnique({ where: { userId: req.user!.sub }, select: { id: true } });

    const callsHandled = conversion ? await db.callLog.count({ where: { conversionId: conversion.id } }) : 0;
    const planMinutes = ent.minutesAllocated;
    // Unlimited entitlements (admin) don't track a per-cycle counter, so the
    // entitlement reports 0 used. Derive the real consumed minutes from the
    // call logs instead, rounding each call up to a full billable minute so it
    // matches how paid usage is metered.
    let minutesUsed = ent.minutesUsed;
    if (ent.unlimited && conversion) {
      minutesUsed = await billedMinutesFor(db, conversion.id);
    }
    const percent =
      ent.unlimited || planMinutes <= 0
        ? 0
        : Math.min(100, Math.round((minutesUsed / planMinutes) * 100));

    res.json({ callsHandled, minutesUsed, planMinutes, percent, unlimited: ent.unlimited });
  }),
);

export default router;
