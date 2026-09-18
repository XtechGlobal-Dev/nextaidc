import express from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound, HttpError } from "../lib/http.js";
import { hashPassword } from "../lib/password.js";
import {
  requireAuth,
  requireAdmin,
  requireAdminOrStaff,
  requirePermission,
  requireSuperAdmin,
} from "../middleware/auth.js";
import { signToken } from "../lib/jwt.js";
import { serializeUser } from "../lib/serialize.js";
import { isAdminRole, isAdminTeamRole } from "../lib/roles.js";
import { tenantScope } from "../lib/tenant.js";
import {
  callDb,
  allCallDbs,
  allTenants,
  tenantsFor,
  tenantFor,
  planeOf,
  requestTenant,
  type TenantClient,
} from "../services/tenantDb.js";
import { withPlan, withPlans } from "../services/planLookup.js";
import { cachedBrand } from "../services/brands.js";
import { brandPlanIds } from "../services/brandSetup.js";
import type { Prisma as TenantPrisma } from "@prisma/tenant-client";
import { refreshBrandPricesForPlan } from "../services/brandPricing.js";
import { nextAvailableForBrand } from "../services/phones.js";
import {
  SECTIONS,
  ALL_PERMISSION_KEYS,
  CAPABILITIES,
  CAPABILITY_LABELS,
  BRAND_SCOPED_SECTIONS,
  PLATFORM_ONLY_SECTIONS,
  PLATFORM_TEAM_SECTIONS,
  scopePermissionsToTenant,
} from "../lib/permissions.js";
import { createOtp, sendOtpEmail, consumeOtp } from "../services/otp.js";
import {
  DEFAULT_PIN,
  PIN_HASH_KEY,
  PIN_LENGTH,
  attemptsRemaining,
  clearFailures,
  isDefaultPin,
  isValidPinFormat,
  lockedForMs,
  maskEmail,
  registerFailure,
  setPin,
  verifyPin,
} from "../services/impersonationPin.js";
import {
  integrationsView,
  saveIntegrations,
  clearIntegration,
  integrationsStatus,
  getPromptTemplate,
  setPromptTemplate,
  getPromptTemplateHistory,
  getAgentDefaultNames,
  setAgentDefaultNames,
  getAgentLlm,
  setAgentLlm,
  getTranscriberFallback,
  setTranscriberFallback,
  getOnboardingCardRequired,
  setOnboardingCardRequired,
  getEffectiveCountryStyles,
  setCountryStyles,
  getIndustryAdminView,
  approveIndustry,
  rejectIndustry,
  removeApprovedIndustry,
} from "../services/settings.js";
import { BUILTIN_COUNTRY_STYLES } from "../lib/countryStyles.js";
import { sanitizeIndustry } from "../lib/industries.js";
import {
  isStripeConfigured,
  getCustomerInvoices,
  createStripeProductPrice,
  createStripePrice,
  updateStripeProduct,
  archiveStripePrice,
  archiveStripeProduct,
  deleteStripeCoupon,
  type StripeInterval,
} from "../services/stripe.js";
import {
  GRANT_REJECTION_MESSAGE,
  PENDING_RESERVATION_TTL_MS,
  getActiveRedemption,
  grantCoupon,
  grantableCoupons,
  normalizeCode,
  revokeRedemption,
  syncStripeCoupon,
} from "../services/coupons.js";
import { upsertAssistant, importTwilioNumber } from "../services/vapi.js";
import { testAdminNexleon, retryDelivery, webhookStats } from "../services/webhook.js";
import { isTwilioConfigured } from "../services/sms.js";
import { sendTestWhatsApp, verifyWhatsAppConnection, whatsAppWebhookUrl } from "../services/whatsapp.js";
import { sendEmail, sendTemplate, accountSuspendedEmail, accountReactivatedEmail } from "../services/email.js";
import { renderEmail, getEmailBranding, setEmailBranding, isUnsubscribable } from "../services/emailTemplates.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { MAX_DEPARTMENTS } from "../lib/transfer.js";
import { MAX_MONTHLY_INTERVAL_COUNT, cycleMonths } from "../lib/billingInterval.js";
import { publicApiBaseUrl } from "../env.js";
// Email links resolve against the request's tenant — sending a brand's staff to the platform sign-in page breaks the white label.
import { brandAppUrl, brandDisplayName } from "../lib/brandUrls.js";
import {
  TRIAL_MINUTES_KEY,
  DEFAULT_TRIAL_MINUTES,
  GRACE_ENABLED_KEY,
  GRACE_DAYS_KEY,
  getGraceConfig,
  getTrialDays,
  getTrialMinutes,
  getFxRates,
  toReportingCents,
  REPORTING_CURRENCY,
  FX_RATES_KEY,
  DEFAULT_FX_RATES,
} from "../services/billing.js";
import { billedMinutesFor, evaluateTrialStatus, TRIAL_STATUS } from "../services/trial.js";
import { forgetDepartmentScopes } from "../services/tickets.js";
import { audit, listAudit, listAuditActions } from "../services/audit.js";
import { buildUserDigest, sendDigests, getLastDigestRun } from "../services/reports.js";
import { compileMasterPrompt, DEFAULT_PROMPT_TEMPLATE, DEFAULT_AGENT_CONFIG, NAME_MAX, DEFAULT_AGENT_LLM, type AgentConfig } from "../lib/agentConfig.js";
import { getAgentLlmOptions, isKnownAgentLlm } from "../services/vapiModels.js";
import { getTranscriberOptions } from "../services/vapiTranscribers.js";
import { isKnownTranscriber } from "../lib/transcribers.js";
import { deprovisionAgentForUser, syncVapiWithDb, syncAssistantCallCap, resyncAllCallCaps, resyncAllAssistants } from "../services/provisioning.js";
import {
  getCallDurationCapSetting,
  setCallDurationCapSetting,
  MIN_MAX_CALL_SECONDS,
  MAX_MAX_CALL_SECONDS,
} from "../services/callDurationCap.js";
import { replenishPool } from "../services/phones.js";
import { onlineUserIds } from "../services/events.js";
import { getBranding, setBrandingAsset, clearBrandingAsset, isBrandingSlot } from "../services/branding.js";
import { getSeoScripts, setSeoScripts } from "../services/seo.js";
import { isStorageConfigured } from "../services/storage.js";
import { notify } from "../services/notifications.js";

const router = express.Router();

router.use(requireAuth, requireAdminOrStaff);

// In-memory upload for branding assets (logos / favicon) — small image files
// streamed straight to S3, so no disk staging needed.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/gif",
]);
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(badRequest("Only PNG, JPEG, WebP, SVG, GIF or ICO images are allowed."));
  },
});

/* ------------------------- Integrations / API keys ------------------------ */
router.get(
  "/integrations",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json(integrationsView());
  }),
);

router.put(
  "/integrations",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { updates } = z
      .object({ updates: z.record(z.string(), z.string()) })
      .parse(req.body);
    await saveIntegrations(updates);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "integrations.save",
      targetType: "integrations",
      metadata: { keys: Object.keys(updates) },
      ip: req.ip,
    });
    res.json(integrationsView());
  }),
);

router.delete(
  "/integrations/:id",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    await clearIntegration(req.params.id);
    res.json(integrationsView());
  }),
);

/* ------------------------------- Voice Bank ------------------------------- *
 *  Admin-curated voice categories (from BOTH providers). A plan points at one. */
const voiceCategorySchema = z.object({
  title: z.string().trim().min(1).max(60),
  voiceIds: z.array(z.string()).default([]),
});

router.get(
  "/voice-categories",
  requirePermission("voice_bank", "view"),
  asyncHandler(async (_req, res) => {
    const categories = await prisma.voiceCategory.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json(categories);
  }),
);

router.post(
  "/voice-categories",
  requirePermission("voice_bank", "create"),
  asyncHandler(async (req, res) => {
    const { title, voiceIds } = voiceCategorySchema.parse(req.body);
    const count = await prisma.voiceCategory.count();
    const created = await prisma.voiceCategory.create({
      data: { title, voiceIds, sortOrder: count },
    });
    res.status(201).json(created);
  }),
);

router.put(
  "/voice-categories/:id",
  requirePermission("voice_bank", "edit"),
  asyncHandler(async (req, res) => {
    const { title, voiceIds } = voiceCategorySchema.parse(req.body);
    const updated = await prisma.voiceCategory
      .update({ where: { id: req.params.id }, data: { title, voiceIds } })
      .catch(() => null);
    if (!updated) throw notFound("Voice category not found");
    res.json(updated);
  }),
);

router.delete(
  "/voice-categories/:id",
  requirePermission("voice_bank", "delete"),
  asyncHandler(async (req, res) => {
    await prisma.voiceCategory.delete({ where: { id: req.params.id } }).catch(() => null);
    res.json({ ok: true });
  }),
);

router.post(
  "/integrations/perfex/test",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const result = await testAdminNexleon();
    res.json(result);
  }),
);

router.post(
  "/integrations/whatsapp/test",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { to } = z
      .object({ to: z.string().min(6, "Enter a recipient number in E.164 format, e.g. +14155551234") })
      .parse(req.body);
    res.json(await sendTestWhatsApp(to));
  }),
);

router.post(
  "/integrations/whatsapp/verify",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await verifyWhatsAppConnection());
  }),
);

router.get(
  "/integrations/whatsapp/info",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    // Prefer the configured public base; otherwise derive from the incoming request
    // (works locally and behind Render's proxy) so the URL is always shown.
    const configured = whatsAppWebhookUrl();
    const host = req.get("host");
    const derived = host ? `${req.protocol}://${host}/api/whatsapp/webhook` : "";
    res.json({ webhookUrl: configured || derived });
  }),
);

/** Send a test email via the configured SMTP to verify the settings work.
 *  Defaults to the admin's own address; surfaces the provider error on failure. */
router.post(
  "/integrations/email/test",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { to } = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
    const recipient = to?.trim() || req.user!.email;
    try {
      await sendEmail({
        to: recipient,
        // Named for the tenant whose SMTP is being tested: a brand admin
        // checking their own sender must not be shown the platform's name.
        subject: `${brandDisplayName()} — test email ✅`,
        html:
          `<p>This is a test email from <strong>${escapeHtml(brandDisplayName())}</strong>.</p>` +
          `<p>If you're reading this, your SMTP settings are working correctly. 🎉</p>`,
        text: `Test email from ${brandDisplayName()} — if you're reading this, your SMTP settings work.`,
      });
      res.json({ success: true, to: recipient });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send test email";
      // `error` is the key the API client surfaces in toasts — without it the
      // admin only sees a generic "Bad Request" instead of the SMTP failure.
      res.status(400).json({ success: false, error: message, message });
    }
  }),
);

/* ------------------------------- Branding -------------------------------- */
router.get(
  "/branding",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ storageConfigured: isStorageConfigured(), assets: await getBranding() });
  }),
);

router.post(
  "/branding/:slot",
  requireAdmin,
  brandingUpload.single("file"),
  asyncHandler(async (req, res) => {
    const slot = req.params.slot;
    if (!isBrandingSlot(slot)) throw badRequest("Unknown branding slot.");
    if (!req.file) throw badRequest("No file uploaded.");
    const assets = await setBrandingAsset(slot, req.file.buffer, req.file.mimetype, req.file.originalname);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "branding.upload",
      targetType: "branding",
      targetId: slot,
      ip: req.ip,
    });
    res.json({ storageConfigured: isStorageConfigured(), assets });
  }),
);

router.delete(
  "/branding/:slot",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const slot = req.params.slot;
    if (!isBrandingSlot(slot)) throw badRequest("Unknown branding slot.");
    const assets = await clearBrandingAsset(slot);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "branding.clear",
      targetType: "branding",
      targetId: slot,
      ip: req.ip,
    });
    res.json({ storageConfigured: isStorageConfigured(), assets });
  }),
);

/** Reconcile Vapi against the DB — delete orphaned assistants + release their
 *  numbers back to the pool (e.g. after users were removed directly in the DB). */
router.post(
  "/vapi/sync",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const result = await syncVapiWithDb();
    res.json({ ok: true, ...result });
  }),
);

/** Plan price as a MONTHLY figure — a $300 quarterly plan is $100 MRR, so intervalCount is the divisor. */
function monthlyCents(priceCents: number, interval: string, intervalCount = 1): number {
  return priceCents / cycleMonths(interval, intervalCount);
}

/* ----------------------------- Overview ----------------------------- */
router.get(
  "/overview",
  requirePermission("overview"),
  asyncHandler(async (req, res) => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Brand-scoped: read from the brand's DB. Phone numbers are the exception — inventory lives in Main, stamped with the holder.
    const db = await requestTenant(req);
    const brandId = req.user!.brandId!;
    const customerScope = { user: { role: "USER" as const } };
    const [
      customers,
      newCustomers,
      trialing,
      payingProfiles,
      liveByPlan,
      plans,
      totalCalls,
      usageAgg,
      recent,
      phoneTotal,
      phoneAssigned,
      phoneAvailable,
      resellers,
      pendingCommissionAgg,
      staff,
      admins,
    ] = await Promise.all([
      db.user.count({ where: { role: "USER" } }),
      db.user.count({ where: { role: "USER", createdAt: { gte: monthAgo } } }),
      // In a free trial (not yet billed) — the admin's conversion pipeline.
      db.profile.count({ where: { ...customerScope, subscriptionStatus: "trialing" } }),
      // Truly paying subscribers (recurring charge) → count + a *real* MRR built
      // from each subscriber's actual plan price, monthly-normalised.
      db.profile.findMany({
        where: { ...customerScope, subscriptionStatus: { in: ["active", "past_due"] } },
        select: { subscriptionPlanId: true },
      }),
      // Live subscribers grouped by their *actual* plan → the real plan mix.
      db.profile.groupBy({
        by: ["subscriptionPlanId"],
        where: {
          ...customerScope,
          subscriptionStatus: { in: LIVE_SUB_STATUSES },
          subscriptionPlanId: { not: null },
        },
        _count: { _all: true },
      }),
      // The catalogue, from the control plane: names, prices, whether still sold.
      prisma.subscriptionPlan.findMany({
        select: { id: true, displayName: true, active: true, priceCents: true, interval: true, intervalCount: true, currency: true },
      }),
      countCalls(brandId),
      // Metered usage counters (trial + paid-plan seconds) — the authoritative
      // "minutes consumed"; call-log durations are sparse and exclude trials.
      db.profile.aggregate({
        _sum: { trialSecondsUsed: true, planSecondsUsed: true },
        where: customerScope,
      }),
      db.user.findMany({
        where: { role: "USER" },
        select: {
          id: true,
          email: true,
          fullName: true,
          createdAt: true,
          profile: { select: { plan: true, subscriptionStatus: true, subscriptionPlanId: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      prisma.phoneNumber.count({ where: { brandId } }),
      prisma.phoneNumber.count({ where: { brandId, userId: { not: null } } }),
      prisma.phoneNumber.count({ where: { brandId, poolStatus: "AVAILABLE", userId: null } }),
      db.user.count({ where: { role: "RESELLER" } }),
      db.commission.aggregate({ _sum: { amountCents: true }, where: { status: "pending" } }),
      db.user.count({ where: { role: "STAFF" } }),
      db.user.count({ where: { role: "ADMIN" } }),
    ]);

    const planMeta = new Map(plans.map((p) => [p.id, p]));
    const paying = payingProfiles.length;
    // Every subscriber's MRR converted into ONE reporting currency: summing
    // raw cents across currencies produced a figure in no currency at all.
    const fxRates = await getFxRates();
    let mrrUnconvertible = false;
    const mrrCents = payingProfiles.reduce((sum, p) => {
      const pl = p.subscriptionPlanId ? planMeta.get(p.subscriptionPlanId) : undefined;
      if (!pl) return sum;
      const monthly = monthlyCents(pl.priceCents, pl.interval, pl.intervalCount);
      const converted = toReportingCents(monthly, pl.currency, fxRates);
      if (converted.unconvertible) mrrUnconvertible = true;
      return sum + converted.cents;
    }, 0);

    // The real plan mix. Each live plan keeps its admin-given name and is
    // flagged `legacy` when the plan has been deactivated but still has holders.
    const liveTotal = liveByPlan.reduce((sum, g) => sum + g._count._all, 0);
    const planMix = liveByPlan
      .map((g) => {
        const meta = planMeta.get(g.subscriptionPlanId!);
        return {
          id: g.subscriptionPlanId,
          name: meta?.displayName ?? "Unknown plan",
          subscribers: g._count._all,
          legacy: meta ? !meta.active : false,
        };
      })
      .sort((a, b) => b.subscribers - a.subscribers);
    // Everyone not on a live paid/trial plan (free flag, canceled, never subscribed).
    const freeOrNone = customers - liveTotal;
    if (freeOrNone > 0) {
      planMix.push({ id: null, name: "Free / no plan", subscribers: freeOrNone, legacy: false });
    }

    // Split metered usage into free-trial vs paid-plan minutes.
    const trialMinutes = Math.round((usageAgg._sum.trialSecondsUsed ?? 0) / 60);
    const planMinutes = Math.round((usageAgg._sum.planSecondsUsed ?? 0) / 60);

    res.json({
      customers,
      newCustomers,
      trialing,
      paying,
      mrr: Math.round(mrrCents / 100),
      /** Currency `mrr` is expressed in — the UI must label the figure. */
      mrrCurrency: REPORTING_CURRENCY,
      /** True when a live plan uses a currency with no configured rate. */
      mrrUnconvertible,
      totalCalls,
      totalMinutes: trialMinutes + planMinutes,
      trialMinutes,
      planMinutes,
      phones: { total: phoneTotal, assigned: phoneAssigned, available: phoneAvailable },
      resellers,
      pendingCommission: Math.round((pendingCommissionAgg._sum.amountCents ?? 0) / 100),
      staff,
      admins,
      planMix,
      recentSignups: recent.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        plan: u.profile?.plan ?? "free",
        planName: u.profile?.subscriptionPlanId ? (planMeta.get(u.profile.subscriptionPlanId)?.displayName ?? null) : null,
        status: u.profile?.subscriptionStatus ?? "none",
        createdAt: u.createdAt,
      })),
    });
  }),
);

/** Call count for one brand or all. Calls live per brand DB, so platform-wide is a sum over tenants; a not-ready brand counts as zero. */
async function countCalls(
  brandId: string | null | undefined,
  where: TenantPrisma.CallLogWhereInput = {},
): Promise<number> {
  if (brandId) {
    try {
      return await (await callDb(brandId)).callLog.count({ where });
    } catch {
      return 0;
    }
  }
  let total = 0;
  for (const { db } of await allCallDbs()) total += await db.callLog.count({ where });
  return total;
}

/* Back-compat simple stats. */
router.get(
  "/stats",
  requirePermission("overview"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const [users, calls, premium] = await Promise.all([
      db.user.count(),
      countCalls(req.user!.brandId),
      db.profile.count({ where: { plan: "premium" } }),
    ]);
    res.json({ users, calls, premium });
  }),
);

/* ----------------------------- Customers ---------------------------- */

/** Global trial settings + clock, resolved ONCE per request and threaded into
 *  serializeCustomer so per-row lifecycle derivation costs no extra queries. */
interface TrialCtx {
  trialMinutes: number;
  trialDays: number;
  now: Date;
}
async function loadTrialCtx(): Promise<TrialCtx> {
  const [trialMinutes, trialDays] = await Promise.all([getTrialMinutes(), getTrialDays()]);
  return { trialMinutes, trialDays, now: new Date() };
}

/** Where a "none" customer sits: a mid-funnel drop-off and a card-less free-trial user share that status, so onboardingCompletedAt is the divider. */
function deriveCustomerLifecycle(
  profile: {
    subscriptionStatus: string;
    stripeSubscriptionId: string | null;
    onboardingCompletedAt: Date | null;
    createdAt: Date;
    trialStartedAt: Date | null;
    trialSecondsUsed: number;
    trialMinutesAllocated: number | null;
  } | null,
  ctx: TrialCtx,
): { onboarding: boolean; freeTrial: boolean } {
  const noSub = (profile?.subscriptionStatus ?? "none") === "none" && !profile?.stripeSubscriptionId;
  if (!profile || !noSub) return { onboarding: false, freeTrial: false };
  // Verified but never finished the signup funnel → still genuinely onboarding.
  if (!profile.onboardingCompletedAt) return { onboarding: true, freeTrial: false };
  // Finished onboarding, no plan yet → on the card-less trial while it lasts.
  const minutesAllocated = profile.trialMinutesAllocated ?? ctx.trialMinutes;
  const minutesUsed = profile.trialSecondsUsed / 60;
  const startedAt = profile.trialStartedAt ?? profile.createdAt ?? ctx.now;
  const endsAt = new Date(startedAt.getTime() + ctx.trialDays * 24 * 60 * 60 * 1000);
  const active = evaluateTrialStatus({ minutesUsed, minutesAllocated, endsAt, now: ctx.now }) === TRIAL_STATUS.ACTIVE;
  return { onboarding: false, freeTrial: active };
}

function serializeCustomer(
  u: {
  id: string;
  email: string;
  fullName: string;
  role: string;
  createdAt: Date;
  emailOptOutAt: Date | null;
  profile:
    | {
        businessName: string;
        plan: string;
        numberActivated: boolean;
        subscriptionStatus: string;
        stripeSubscriptionId: string | null;
        suspendedAt: Date | null;
        onboardingCompletedAt: Date | null;
        createdAt: Date;
        trialStartedAt: Date | null;
        trialSecondsUsed: number;
        trialMinutesAllocated: number | null;
        subscriptionPlan: { displayName: string; priceCents: number; interval: string } | null;
      }
    | null;
  // `vapiAssistantId` is optional: it is only queried (and thus present) for
  // admins — staff never receive it.
  conversion: { vapiAssistantId?: string | null; _count: { callLogs: number } } | null;
  },
  ctx: TrialCtx,
  onlineIds?: Set<string>,
) {
  const lifecycle = deriveCustomerLifecycle(u.profile, ctx);
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    businessName: u.profile?.businessName ?? "",
    plan: u.profile?.plan ?? "free",
    numberActivated: u.profile?.numberActivated ?? false,
    vapiAssistantId: u.conversion?.vapiAssistantId ?? null,
    // Real subscription state (not the legacy free/premium flag) so the admin
    // sees the actual plan name + status (Trial/Active/Past due).
    subscriptionStatus: u.profile?.subscriptionStatus ?? "none",
    // Verified but never FINISHED onboarding. Derived, not stored, so it can't drift.
    onboarding: lifecycle.onboarding,
    // Completed onboarding, on the card-less free trial (status still "none") — a live user, not a lead.
    freeTrial: lifecycle.freeTrial,
    // True only for an admin account lock (vs a grace-lapsed billing suspension).
    suspended: !!u.profile?.suspendedAt,
    planName: u.profile?.subscriptionPlan?.displayName ?? null,
    planPriceCents: u.profile?.subscriptionPlan?.priceCents ?? 0,
    planInterval: u.profile?.subscriptionPlan?.interval ?? "month",
    callCount: u.conversion?._count.callLogs ?? 0,
    createdAt: u.createdAt,
    // Notification-email opt-out timestamp (null = still subscribed). Surfaces
    // in the admin customers table so support can see who won't get reminders.
    emailOptOutAt: u.emailOptOutAt ?? null,
    // Live SSE presence. Point-in-time only — NOT "last seen", and doesn't survive an API restart.
    online: onlineIds?.has(u.id) ?? false,
  };
}

const customerSelectBase = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
  emailOptOutAt: true,
  profile: {
    select: {
      businessName: true,
      plan: true,
      numberActivated: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      suspendedAt: true,
      // Lifecycle inputs (see deriveCustomerLifecycle).
      onboardingCompletedAt: true,
      createdAt: true,
      trialStartedAt: true,
      trialSecondsUsed: true,
      trialMinutesAllocated: true,
      subscriptionPlanId: true,
    },
  },
} as const;

// Admins see the linked Vapi assistant id (the "Assistant" column). Staff never
// do — for them it is neither selected from the DB nor returned in the payload.
const customerSelect = {
  ...customerSelectBase,
  conversion: { select: { id: true, vapiAssistantId: true } },
} as const;

const customerSelectNoAssistant = {
  ...customerSelectBase,
  conversion: { select: { id: true } },
} as const;

/** Customers as the pages show them. Plan (control plane) and call count (no relation) can't be joined by Prisma any more. */
async function withCustomerExtras<
  T extends {
    id: string;
    profile: { subscriptionPlanId: string | null } | null;
    conversion: { id: string; vapiAssistantId?: string | null } | null;
  },
>(db: TenantClient, users: T[]) {
  const planIds = [...new Set(users.map((u) => u.profile?.subscriptionPlanId).filter((id): id is string => !!id))];
  const plans = planIds.length
    ? await prisma.subscriptionPlan.findMany({
        where: { id: { in: planIds } },
        select: { id: true, displayName: true, priceCents: true, interval: true },
      })
    : [];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const convIds = users.map((u) => u.conversion?.id).filter((id): id is string => !!id);
  const counts = convIds.length
    ? await db.callLog.groupBy({ by: ["conversionId"], where: { conversionId: { in: convIds } }, _count: { _all: true } })
    : [];
  const callsByConv = new Map(counts.map((c) => [c.conversionId, c._count._all]));
  return users.map((u) => ({
    ...u,
    profile: u.profile
      ? {
          ...u.profile,
          subscriptionPlan: u.profile.subscriptionPlanId ? (planById.get(u.profile.subscriptionPlanId) ?? null) : null,
        }
      : null,
    conversion: u.conversion ? { ...u.conversion, _count: { callLogs: callsByConv.get(u.conversion.id) ?? 0 } } : null,
  }));
}

/** Choose the customer projection for the requester. Only admins get the Vapi
 *  assistant id; staff (even with customer view permission) never fetch it. */
function customerSelectFor(role?: string) {
  return isAdminRole(role) ? customerSelect : customerSelectNoAssistant;
}

router.get(
  "/customers",
  requirePermission("customers"),
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    // The brand's own database: there is nobody else's customer in it.
    const db = await requestTenant(req);
    const users = await db.user.findMany({
      where: {
        role: { notIn: ["ADMIN", "STAFF", "RESELLER"] },
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: "insensitive" } },
                { fullName: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: customerSelectFor(req.user?.role),
      orderBy: { createdAt: "desc" },
    });
    const ctx = await loadTrialCtx();
    const onlineIds = onlineUserIds();
    res.json((await withCustomerExtras(db, users)).map((u) => serializeCustomer(u, ctx, onlineIds)));
  }),
);

router.get(
  "/customers/:id",
  requirePermission("customers"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const user = await db.user.findUnique({
      where: { id: req.params.id },
      select: customerSelectFor(req.user?.role),
    });
    if (!user) throw notFound("Customer not found");
    if (isAdminTeamRole(user.role))
      throw badRequest("This endpoint is for customers only.");
    const [full] = await withCustomerExtras(db, [user]);
    res.json(serializeCustomer(full, await loadTrialCtx(), onlineUserIds()));
  }),
);

router.patch(
  "/customers/:id",
  requirePermission("customers", "edit"),
  asyncHandler(async (req, res) => {
    const { plan } = z.object({ plan: z.enum(["free", "premium"]).optional() }).parse(req.body);
    const db = await requestTenant(req);
    const exists = await db.user.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Customer not found");
    if (isAdminTeamRole(exists.role))
      throw badRequest("This endpoint is for customers only.");

    if (plan) await db.profile.update({ where: { userId: req.params.id }, data: { plan } });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "customer.update",
      targetType: "user",
      targetId: req.params.id,
      metadata: { plan },
      ip: req.ip,
    });

    const updated = await db.user.findUnique({ where: { id: req.params.id }, select: customerSelect });
    const [full] = await withCustomerExtras(db, [updated!]);
    res.json(serializeCustomer(full, await loadTrialCtx()));
  }),
);

router.delete(
  "/customers/:id",
  requirePermission("customers", "delete"),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.sub) throw badRequest("You can't delete your own account here.");
    const db = await requestTenant(req);
    const exists = await db.user.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Customer not found");
    if (isAdminTeamRole(exists.role))
      throw badRequest("This endpoint is for customers only.");
    // Vapi assistant + number first, then the account — whose profile, agent
    // record and everything else in the brand's database go with it.
    await deprovisionAgentForUser(req.params.id);
    await db.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

/* ---- Admin manual suspend / reactivate (locks/unlocks the whole account) ---- */
router.post(
  "/customers/:id/suspend",
  requirePermission("customers", "edit"),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.sub) throw badRequest("You can't suspend your own account.");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const db = await requestTenant(req);
    const target = await db.user.findUnique({
      where: { id: req.params.id },
      select: { role: true, email: true, fullName: true, profile: { select: { subscriptionStatus: true, suspendedAt: true } } },
    });
    if (!target) throw notFound("Customer not found");
    if (isAdminTeamRole(target.role))
      throw badRequest("This endpoint is for customers only.");
    if (target.profile?.suspendedAt) throw badRequest("This account is already suspended.");

    await db.profile.update({
      where: { userId: req.params.id },
      // suspendedAt = admin lock (blocks login); the status keeps entitlement/number-detach behaving like a billing suspension.
      data: { subscriptionStatus: "suspended", suspendedAt: new Date() },
    });
    // Detach their number from answering (blocked → setNumberAssistant null). We
    // keep the number ASSIGNED so a reactivate restores service on the same line.
    void syncAssistantCallCap(req.params.id);
    void notify(req.params.id, {
      type: "billing",
      title: "Your account has been suspended",
      message: "Your account has been suspended by an administrator. Please contact support.",
      link: "/login",
    });
    // Email the customer so they know their account was locked (best-effort).
    if (integrationsStatus().email) {
      void accountSuspendedEmail({
        ownerEmail: target.email,
        fullName: target.fullName,
        reason: reason || undefined,
      }).catch(() => {});
    }
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "customer.suspend",
      targetType: "user",
      targetId: req.params.id,
      metadata: { from: target.profile?.subscriptionStatus ?? "none", reason: reason || undefined },
      ip: req.ip,
    });

    const updated = await db.user.findUnique({ where: { id: req.params.id }, select: customerSelect });
    const [full] = await withCustomerExtras(db, [updated!]);
    res.json(serializeCustomer(full, await loadTrialCtx()));
  }),
);

/** Impersonation: mint a customer session for an admin. ADMIN-only, never for other admins/staff, every entry audited. */
router.post(
  "/customers/:id/impersonate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // PIN checked HERE, first — the hidden dialog is worth nothing against curl. Before the target
    // lookup so a wrong PIN can't probe which customer ids exist.
    const { pin } = z.object({ pin: z.string() }).parse(req.body ?? {});

    const lockedMs = await lockedForMs();
    if (lockedMs > 0) {
      throw new HttpError(
        429,
        `Too many incorrect PINs. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`,
      );
    }

    if (!(await verifyPin(pin))) {
      const lockedForNow = await registerFailure();
      // Log every failure — a run of them is the guessing signal the audit trail would otherwise miss.
      void audit({
        actorId: req.user!.sub,
        actorBrandId: req.user!.brandId ?? null,
        actorEmail: req.user!.email,
        action: "customer.impersonate.pin_failed",
        targetType: "user",
        targetId: req.params.id,
        metadata: { lockedOut: lockedForNow > 0 },
        ip: req.ip,
      });
      if (lockedForNow > 0) {
        throw new HttpError(
          429,
          `Too many incorrect PINs. Try again in ${Math.ceil(lockedForNow / 60000)} minute(s).`,
        );
      }
      const left = await attemptsRemaining();
      throw badRequest(`Incorrect PIN. ${left} attempt(s) remaining before a temporary lockout.`);
    }
    // Correct PIN — the run of failures is over.
    await clearFailures();

    if (req.params.id === req.user!.sub) throw badRequest("You're already signed in as yourself.");
    // The customer is in the admin's own brand's database; the session the
    // admin borrows is read from there, like the customer's own would be.
    const db = await requestTenant(req);
    const found = await db.user.findUnique({ where: { id: req.params.id }, include: { profile: true } });
    const brand = cachedBrand(req.user!.brandId);
    const user = found
      ? { ...found, brandId: req.user!.brandId ?? null, brand: brand ? { name: brand.name, slug: brand.slug } : null }
      : null;
    if (!user) throw notFound("Customer not found");
    if (isAdminTeamRole(user.role))
      throw badRequest("You can only access customer accounts.");
    // Block only a mid-funnel customer (no dashboard to land on). Card-required signups are exempt —
    // abandoning at the card step leaves both fields unset, and they're exactly who an admin needs to open.
    if (
      !user.profile?.onboardingCompletedAt &&
      !user.profile?.stripeSubscriptionId &&
      !user.profile?.cardRequiredAtSignup
    )
      throw badRequest("This customer hasn't finished onboarding yet — there's nothing to access.");

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions: user.permissions ?? [],
      // The customer's brand: the session is read from that brand's database.
      brandId: user.brandId ?? null,
      // Flags the session as "an admin wearing this identity". Access is
      // unchanged; it only keeps live presence honest (see onlineUserIds).
      imp: true,
    });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "customer.impersonate",
      targetType: "user",
      targetId: user.id,
      metadata: { email: user.email },
      ip: req.ip,
    });

    res.json({ token, user: serializeUser(user) });
  }),
);

/** Is the impersonation PIN still the shipped default? Returns NOTHING else — never the PIN or its hash. */
router.get(
  "/impersonation-pin",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ isDefault: await isDefaultPin(), lockedForMs: await lockedForMs() });
  }),
);

/** Change the PIN. Requires the CURRENT one, or an unattended admin session could lock the real admin out. */
router.put(
  "/impersonation-pin",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { currentPin, newPin } = z
      .object({ currentPin: z.string(), newPin: z.string() })
      .parse(req.body);

    // The lockout covers this route too. Without it, the change endpoint is an
    // unlimited oracle for guessing the very PIN the other route rate-limits.
    const lockedMs = await lockedForMs();
    if (lockedMs > 0) {
      throw new HttpError(
        429,
        `Too many incorrect PINs. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`,
      );
    }
    if (!(await verifyPin(currentPin))) {
      const lockedForNow = await registerFailure();
      void audit({
        actorId: req.user!.sub,
        actorBrandId: req.user!.brandId ?? null,
        actorEmail: req.user!.email,
        action: "impersonation_pin.change_failed",
        targetType: "setting",
        targetId: PIN_HASH_KEY,
        metadata: { lockedOut: lockedForNow > 0 },
        ip: req.ip,
      });
      throw badRequest(
        lockedForNow > 0
          ? `Too many incorrect PINs. Try again in ${Math.ceil(lockedForNow / 60000)} minute(s).`
          : "That's not the current PIN.",
      );
    }
    if (!isValidPinFormat(newPin)) {
      throw badRequest(`The new PIN must be exactly ${PIN_LENGTH} digits.`);
    }
    if (newPin === DEFAULT_PIN) {
      throw badRequest("Pick something other than the default PIN.");
    }
    if (newPin === currentPin) {
      throw badRequest("That's already your PIN.");
    }

    await setPin(newPin);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "impersonation_pin.changed",
      targetType: "setting",
      targetId: PIN_HASH_KEY,
      ip: req.ip,
    });
    res.json({ ok: true, isDefault: false });
  }),
);

/** "Forgot PIN": email a one-time code to the SESSION's address, never one from the request — that would be account takeover.
 *  Deliberately not blocked by the PIN lockout (being locked out is why you're here; the code lands in a mailbox the guesser lacks). */
router.post(
  "/impersonation-pin/reset/start",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const email = req.user!.email;
    const code = await createOtp({ email, purpose: "impersonation_pin_reset" });
    await sendOtpEmail(email, code, "impersonation_pin_reset");
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: email,
      action: "impersonation_pin.reset_requested",
      targetType: "setting",
      targetId: PIN_HASH_KEY,
      ip: req.ip,
    });
    // Echo the address back MASKED, so the admin can tell which inbox to open
    // without the response becoming a way to read it out of a hijacked session.
    res.json({ ok: true, sentTo: maskEmail(email) });
  }),
);

/** Finish the reset: consume the emailed code and set the new PIN. */
router.post(
  "/impersonation-pin/reset/complete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { code, newPin } = z.object({ code: z.string(), newPin: z.string() }).parse(req.body);
    if (!isValidPinFormat(newPin)) {
      throw badRequest(`The new PIN must be exactly ${PIN_LENGTH} digits.`);
    }
    if (newPin === DEFAULT_PIN) {
      throw badRequest("Pick something other than the default PIN.");
    }
    // Throws on a wrong/expired/spent code, and counts the attempt. Consumed
    // BEFORE the PIN is written so a replayed request can't set it twice.
    await consumeOtp(req.user!.email, "impersonation_pin_reset", code);

    await setPin(newPin);
    // Whatever lockout was running belongs to the forgotten PIN, not this one.
    await clearFailures();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "impersonation_pin.reset_completed",
      targetType: "setting",
      targetId: PIN_HASH_KEY,
      ip: req.ip,
    });
    res.json({ ok: true, isDefault: false });
  }),
);

router.post(
  "/customers/:id/reactivate",
  requirePermission("customers", "edit"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const target = await db.user.findUnique({
      where: { id: req.params.id },
      select: {
        role: true,
        email: true,
        fullName: true,
        profile: {
          select: {
            subscriptionPlanId: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
            cardRequiredAtSignup: true,
            cardConfirmedAt: true,
          },
        },
      },
    });
    if (!target) throw notFound("Customer not found");
    if (isAdminTeamRole(target.role))
      throw badRequest("This endpoint is for customers only.");
    const p = target.profile;

    // Restore the best-fit status: a still-valid paid period → active, an
    // unexpired trial → trialing, otherwise none (they'll be sent to /subscribe).
    const now = new Date();
    // No confirmed card = no trial to restore. trialEndsAt is stamped at plan pick, BEFORE any card, so
    // trusting it would reactivate to "trialing" with no card. Back on the card wall at "none".
    const awaitingFirstCard = !!p?.cardRequiredAtSignup && !p.cardConfirmedAt;
    const restored =
      p?.subscriptionPlanId && p.currentPeriodEnd && p.currentPeriodEnd.getTime() > now.getTime()
        ? "active"
        : !awaitingFirstCard && p?.trialEndsAt && p.trialEndsAt.getTime() > now.getTime()
          ? "trialing"
          : "none";

    await db.profile.update({
      where: { userId: req.params.id },
      // Lift the admin lock (suspendedAt) so the customer can sign in again.
      data: { subscriptionStatus: restored, suspendedAt: null },
    });
    void syncAssistantCallCap(req.params.id); // re-route the number if now entitled
    void notify(req.params.id, {
      type: "billing",
      title: "Your account has been reactivated",
      message:
        restored === "none"
          ? "Pick a plan to bring your AI back online."
          : "Your AI receptionist is back online.",
      link: restored === "none" ? "/subscribe" : "/dashboard",
    });
    if (integrationsStatus().email) {
      void accountReactivatedEmail({
        ownerEmail: target.email,
        fullName: target.fullName,
      }).catch(() => {});
    }
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "customer.reactivate",
      targetType: "user",
      targetId: req.params.id,
      metadata: { restored },
      ip: req.ip,
    });

    const updated = await db.user.findUnique({ where: { id: req.params.id }, select: customerSelect });
    const [full] = await withCustomerExtras(db, [updated!]);
    res.json(serializeCustomer(full, await loadTrialCtx()));
  }),
);

// Agent requests. New signups land as "pending"; approving provisions the assistant, assigns a pool number and emails the customer.
router.get(
  "/agent-requests",
  requirePermission("subscriptions"),
  asyncHandler(async (req, res) => {
    const rows = await (await requestTenant(req)).conversion.findMany({
      where: { status: "pending", user: { role: "USER" } },
      include: { user: { include: { profile: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(
      rows.map((c) => ({
        id: c.id,
        userId: c.userId,
        fullName: c.user.fullName,
        email: c.user.email,
        businessName: c.user.profile?.businessName ?? "",
        website: c.user.profile?.website ?? "",
        mobile: c.user.profile?.mobile ?? "",
        subscriptionStatus: c.user.profile?.subscriptionStatus ?? "none",
        status: c.status,
        createdAt: c.createdAt,
      })),
    );
  }),
);

router.post(
  "/agent-requests/:id/approve",
  requirePermission("subscriptions", "edit"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const brandId = req.user!.brandId!;
    const conversion = await db.conversion.findUnique({
      where: { id: req.params.id },
      include: { user: { include: { profile: true } } },
    });
    if (!conversion) throw notFound("Request not found");
    if (conversion.status === "approved") throw badRequest("Already approved");
    if (!integrationsStatus().vapi) throw badRequest("Configure Vapi in Settings before approving.");

    // 1) Create (or update) the live Vapi assistant from the captured config.
    const assistantId = await upsertAssistant(
      conversion.agentConfig as unknown as AgentConfig,
      conversion.vapiAssistantId,
      { ownerId: conversion.userId },
    );

    // 2) Assign an available pool number and route it. Best-effort — admin can retry / assign manually.
    let assignedNumber: string | null = conversion.user.profile?.receptionistNumber || null;
    if (isTwilioConfigured() && !assignedNumber) {
      try {
        const poolNumber = await nextAvailableForBrand(brandId);
        if (poolNumber) {
          await importTwilioNumber({ number: poolNumber.number, assistantId });
          await prisma.phoneNumber.update({
            where: { id: poolNumber.id },
            data: {
              userId: conversion.userId,
              assistantId,
              poolStatus: "ASSIGNED",
              status: "active",
              // Tenant stamp — see PhoneNumber.brandId.
              brandId,
            },
          });
          assignedNumber = poolNumber.number;
          void replenishPool().catch(() => {});
        }
      } catch {
        /* number assignment is best-effort — admin can retry / assign manually */
      }
    }

    // 3) Persist approval.
    await db.conversion.update({
      where: { id: conversion.id },
      data: { status: "approved", approvedAt: new Date(), vapiAssistantId: assistantId },
    });
    if (assignedNumber && conversion.user.profile) {
      await db.profile.update({
        where: { userId: conversion.userId },
        data: { receptionistNumber: assignedNumber, numberActivated: true },
      });
    }

    // 4) Email the customer (best-effort).
    if (integrationsStatus().email) {
      try {
        await sendEmail({
          to: conversion.user.email,
          subject: "Your AI receptionist is live 🎉",
          html:
            `<p>Hi ${conversion.user.fullName},</p>` +
            `<p>Your AI receptionist has been set up${assignedNumber ? ` and your number is <b>${assignedNumber}</b>` : ""}. ` +
            `Log in to your dashboard to start handling calls.</p>`,
        });
      } catch {
        /* best-effort */
      }
    }

    void notify(conversion.userId, {
      type: "agent",
      title: "Your AI receptionist is live 🎉",
      message: "Your assistant is approved and ready to take calls.",
      link: "/dashboard",
    });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "agent-request.approve",
      targetType: "conversion",
      targetId: conversion.id,
      metadata: { userId: conversion.userId, vapiAssistantId: assistantId, receptionistNumber: assignedNumber },
      ip: req.ip,
    });

    res.json({ ok: true, vapiAssistantId: assistantId, receptionistNumber: assignedNumber });
  }),
);

// Admin → Subscriptions. Read-only over the billing engine's own state.

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Effective status for the admin view — an admin account lock wins. */
function effectiveSubStatus(p: { subscriptionStatus: string; suspendedAt: Date | null }): string {
  return p.suspendedAt ? "suspended" : p.subscriptionStatus;
}

/** Minutes used/allocated for the CURRENT phase: trial counters while trialing,
 *  paid-plan counters otherwise (falling back to the plan's included minutes). */
function subscriptionMinutes(p: {
  subscriptionStatus: string;
  trialMinutesAllocated: number | null;
  trialSecondsUsed: number;
  planMinutesAllocated: number | null;
  planSecondsUsed: number;
  subscriptionPlan: { includedMinutes: number } | null;
}): { used: number; allocated: number } {
  if (p.subscriptionStatus === "trialing") {
    return { used: round1(p.trialSecondsUsed / 60), allocated: p.trialMinutesAllocated ?? 0 };
  }
  return {
    used: round1(p.planSecondsUsed / 60),
    allocated: p.planMinutesAllocated ?? p.subscriptionPlan?.includedMinutes ?? 0,
  };
}

/** Subscription columns the viewer may see (STAFF allow-listed per `subscriptions.field.*`). Enforced server-side so hidden data
 *  is never sent. Only price/minutes/invoices — nulling plan/status would break the client's filtering. */
function subscriptionFieldAccess(user: { role: string; permissions: string[] }) {
  const can = (f: string) =>
    isAdminRole(user.role) || user.permissions.includes(`subscriptions.field.${f}`);
  return { price: can("price"), minutes: can("minutes"), invoices: can("invoices") };
}

router.get(
  "/subscriptions",
  requirePermission("subscriptions"),
  asyncHandler(async (req, res) => {
    // Every customer: billing footprint = subscription row, otherwise an "under onboarding" lead for sales.
    // Brand DB; plans joined from the control-plane catalogue.
    const db = await requestTenant(req);
    const profiles = await withPlans(
      await db.profile.findMany({
        where: { user: { role: "USER" } },
        select: {
          userId: true,
          businessName: true,
          mobile: true,
          onboardingStep: true,
          onboardingCompletedAt: true,
          subscriptionStatus: true,
          suspendedAt: true,
          autoRenew: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          trialMinutesAllocated: true,
          trialSecondsUsed: true,
          planMinutesAllocated: true,
          planSecondsUsed: true,
          scheduledPlanId: true,
          scheduledPlanEffectiveAt: true,
          subscriptionPlanId: true,
          user: { select: { fullName: true, email: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    );

    // Resolve pending-downgrade plan names in one query.
    const scheduledIds = [...new Set(profiles.map((p) => p.scheduledPlanId).filter((id): id is string => !!id))];
    const scheduledPlans = scheduledIds.length
      ? await prisma.subscriptionPlan.findMany({
          where: { id: { in: scheduledIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const scheduledById = new Map(scheduledPlans.map((p) => [p.id, p.displayName]));

    const subscriptions = profiles.map((p) => {
      const status = effectiveSubStatus(p);
      const minutes = subscriptionMinutes(p);
      const pl = p.subscriptionPlan;
      // Mid-funnel drop-offs are leads, not churn. A completed-onboarding free-trial user (also "none") is NOT a lead.
      const underOnboarding = status === "none" && !pl && !p.onboardingCompletedAt;
      // Per-row MRR, left in the PLAN's currency so it matches the price beside it; FX normalisation happens once in the summary.
      const mrrCents =
        pl && (status === "active" || status === "past_due")
          ? Math.round(monthlyCents(pl.priceCents, pl.interval, pl.intervalCount))
          : 0;
      return {
        userId: p.userId,
        fullName: p.user.fullName,
        email: p.user.email,
        phone: p.mobile,
        businessName: p.businessName,
        signupAt: p.user.createdAt.toISOString(),
        underOnboarding,
        // Pending funnel step to resume at (5=Services, 6=Voice, 7=Finish,
        // 8=Pricing); 0 = finished the funnel or signed up directly.
        onboardingStep: p.onboardingStep,
        onboardingCompletedAt: p.onboardingCompletedAt?.toISOString() ?? null,
        plan: pl
          ? {
              id: pl.id,
              name: pl.displayName,
              priceCents: pl.priceCents,
              currency: pl.currency,
              interval: pl.interval,
              intervalCount: pl.intervalCount,
              legacy: !pl.active,
            }
          : null,
        status,
        autoRenew: p.autoRenew,
        trialEndsAt: p.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: p.currentPeriodEnd?.toISOString() ?? null,
        scheduledPlan: p.scheduledPlanId
          ? {
              id: p.scheduledPlanId,
              name: scheduledById.get(p.scheduledPlanId) ?? "Unknown plan",
              effectiveAt: p.scheduledPlanEffectiveAt?.toISOString() ?? null,
            }
          : null,
        minutesUsed: minutes.used,
        minutesAllocated: minutes.allocated,
        mrrCents,
      };
    });

    const fxRates = await getFxRates();
    const count = (s: (status: string) => boolean) => subscriptions.filter((r) => s(r.status)).length;
    const summary = {
      total: subscriptions.length,
      active: count((s) => s === "active"),
      trialing: count((s) => s === "trialing"),
      pastDue: count((s) => s === "past_due"),
      onboarding: subscriptions.filter((r) => r.underOnboarding).length,
      canceled: subscriptions.filter(
        (r) => !r.underOnboarding && (r.status === "canceled" || r.status === "suspended" || r.status === "none"),
      ).length,
      // Summed in USD. Rows can be priced in different currencies, and adding
      // their raw cents together produced a total in no currency at all.
      mrrCents: Math.round(
        subscriptions.reduce(
          (sum, r) => sum + toReportingCents(r.mrrCents, r.plan?.currency ?? REPORTING_CURRENCY, fxRates).cents,
          0,
        ),
      ),
      /** Currency `mrrCents` is expressed in — the UI must label the figure. */
      mrrCurrency: REPORTING_CURRENCY,
    };

    // Redact the columns this viewer isn't permitted to see — enforced here so
    // hidden columns' values never reach the browser (not just hidden in the UI).
    const access = subscriptionFieldAccess(req.user!);
    const redacted = subscriptions.map((s) => ({
      ...s,
      plan: s.plan ? { ...s.plan, priceCents: access.price ? s.plan.priceCents : 0 } : null,
      mrrCents: access.price ? s.mrrCents : 0,
      minutesUsed: access.minutes ? s.minutesUsed : 0,
      minutesAllocated: access.minutes ? s.minutesAllocated : 0,
    }));

    res.json({
      summary: { ...summary, mrrCents: access.price ? summary.mrrCents : 0 },
      subscriptions: redacted,
    });
  }),
);

router.get(
  "/subscriptions/:userId",
  requirePermission("subscriptions"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const found = await db.user.findUnique({
      where: { id: req.params.userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        profile: {
          select: {
            businessName: true,
            mobile: true,
            onboardingStep: true,
            onboardingCompletedAt: true,
            subscriptionStatus: true,
            suspendedAt: true,
            autoRenew: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            trialMinutesAllocated: true,
            trialSecondsUsed: true,
            planMinutesAllocated: true,
            planSecondsUsed: true,
            scheduledPlanId: true,
            scheduledPlanEffectiveAt: true,
            stripeCustomerId: true,
            subscriptionPlanId: true,
          },
        },
      },
    });
    if (!found || found.role !== "USER") throw notFound("Customer not found");
    const user = { ...found, brandId: req.user!.brandId!, profile: await withPlan(found.profile) };
    const p = user.profile;

    let scheduledPlan: { id: string; name: string; effectiveAt: string | null } | null = null;
    if (p?.scheduledPlanId) {
      const sp = await prisma.subscriptionPlan.findUnique({
        where: { id: p.scheduledPlanId },
        select: { displayName: true },
      });
      scheduledPlan = {
        id: p.scheduledPlanId,
        name: sp?.displayName ?? "Unknown plan",
        effectiveAt: p.scheduledPlanEffectiveAt?.toISOString() ?? null,
      };
    }

    // Billing history is in the customer's brand's database; a brand whose
    // database is not ready shows none rather than failing the whole view.
    const history = await tenantFor(user.brandId)
      .then((db) => db.planEvent.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 100 }))
      .catch(() => []);

    // Invoices are best-effort: a Stripe outage (or unconfigured Stripe) must
    // never blank the whole detail view — the drawer just shows none.
    let invoices: Awaited<ReturnType<typeof getCustomerInvoices>> = [];
    if (isStripeConfigured() && p?.stripeCustomerId) {
      try {
        invoices = await getCustomerInvoices(p.stripeCustomerId, 24);
      } catch {
        invoices = [];
      }
    }

    const minutes = p
      ? subscriptionMinutes(p)
      : { used: 0, allocated: 0 };

    const detailStatus = p ? effectiveSubStatus(p) : "none";

    // Same column-level allow-list as the list — enforced server-side so hidden
    // financial/usage columns never reach the browser.
    const access = subscriptionFieldAccess(req.user!);

    res.json({
      customer: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: p?.mobile ?? "",
        businessName: p?.businessName ?? "",
        createdAt: user.createdAt,
      },
      subscription: {
        status: detailStatus,
        underOnboarding: detailStatus === "none" && !p?.subscriptionPlan,
        onboardingStep: p?.onboardingStep ?? 0,
        plan: p?.subscriptionPlan
          ? {
              id: p.subscriptionPlan.id,
              name: p.subscriptionPlan.displayName,
              priceCents: access.price ? p.subscriptionPlan.priceCents : 0,
              currency: p.subscriptionPlan.currency,
              interval: p.subscriptionPlan.interval,
              legacy: !p.subscriptionPlan.active,
            }
          : null,
        autoRenew: p?.autoRenew ?? false,
        trialEndsAt: p?.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: p?.currentPeriodEnd?.toISOString() ?? null,
        scheduledPlan,
        stripeCustomerId: p?.stripeCustomerId ?? null,
        minutesUsed: access.minutes ? minutes.used : 0,
        minutesAllocated: access.minutes ? minutes.allocated : 0,
      },
      history: history.map((e) => ({
        id: e.id,
        type: e.type,
        fromPlanId: e.fromPlanId,
        fromPlanName: e.fromPlanName,
        toPlanId: e.toPlanId,
        toPlanName: e.toPlanName,
        priceCents: access.price ? e.priceCents : 0,
        currency: e.currency,
        amountCents: access.price ? e.amountCents : 0,
        note: e.note,
        createdAt: e.createdAt,
      })),
      invoices: access.invoices ? invoices : [],
    });
  }),
);

/* ----------------------------- Resellers --------------------------- */
function genReferralCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

/** Best-effort welcome email to a new reseller with the admin-set password and a prompt to change it. */
async function emailResellerWelcome(opts: {
  email: string;
  fullName: string;
  password: string;
  referralCode: string;
}): Promise<void> {
  if (!integrationsStatus().email) return;
  // A brand recruits its own resellers, so the whole email is the brand's.
  const appName = brandDisplayName();
  const loginUrl = brandAppUrl("/login");
  await sendEmail({
    to: opts.email,
    subject: `Your ${appName} reseller account`,
    html:
      `<p>Hi ${escapeHtml(opts.fullName)},</p>` +
      `<p>A reseller account has been created for you on ${escapeHtml(appName)}. Use these credentials to log in:</p>` +
      `<ul>` +
      `<li><strong>Email:</strong> ${escapeHtml(opts.email)}</li>` +
      `<li><strong>Password:</strong> ${escapeHtml(opts.password)}</li>` +
      `<li><strong>Your referral code:</strong> ${escapeHtml(opts.referralCode)}</li>` +
      `</ul>` +
      `<p>Log in to your reseller portal here: <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a></p>` +
      `<p>For your security, please change your password after your first login.</p>`,
    text:
      `Hi ${opts.fullName},\n\n` +
      `A reseller account has been created for you on ${appName}.\n\n` +
      `Email: ${opts.email}\nPassword: ${opts.password}\nReferral code: ${opts.referralCode}\n\n` +
      `Log in: ${loginUrl}\n\nPlease change your password after your first login.`,
  });
}

async function uniqueReferralCode(db: TenantClient): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const code = genReferralCode();
    const clash = await db.user.findUnique({ where: { referralCode: code } });
    if (!clash) return code;
  }
  return `${genReferralCode()}${Date.now().toString(36).toUpperCase()}`;
}

function serializeReseller(r: {
  id: string;
  email: string;
  fullName: string;
  referralCode: string | null;
  commissionPercent: number;
  createdAt: Date;
  _count?: { referrals: number };
}) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.fullName,
    referralCode: r.referralCode,
    commissionPercent: r.commissionPercent,
    referredCount: r._count?.referrals ?? 0,
    createdAt: r.createdAt,
    // Default to 0 so create/update responses (no commission yet) never render
    // as NaN; the list endpoint overrides these with the real totals.
    earnedCents: 0,
    pendingCents: 0,
  };
}

const resellerSelect = {
  id: true,
  email: true,
  fullName: true,
  referralCode: true,
  commissionPercent: true,
  createdAt: true,
  _count: { select: { referrals: true } },
} as const;

router.get(
  "/resellers",
  requirePermission("resellers"),
  asyncHandler(async (req, res) => {
    // Resellers are a brand's own programme, in the brand's database. The
    // platform recruits none, so its own people see an empty list.
    if (!req.user!.brandId) {
      res.json([]);
      return;
    }
    const db = await requestTenant(req);
    const [rows, commissions] = await Promise.all([
      db.user.findMany({
        where: { role: "RESELLER" },
        select: resellerSelect,
        orderBy: { createdAt: "desc" },
      }),
      db.commission.groupBy({
        by: ["resellerId", "status"],
        _sum: { amountCents: true },
      }),
    ]);
    const earned = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const c of commissions) {
      const amt = c._sum.amountCents ?? 0;
      const map = c.status === "paid" ? earned : pending;
      map.set(c.resellerId, (map.get(c.resellerId) ?? 0) + amt);
    }
    res.json(
      rows.map((r) => ({
        ...serializeReseller(r),
        earnedCents: earned.get(r.id) ?? 0,
        pendingCents: pending.get(r.id) ?? 0,
      })),
    );
  }),
);

router.post(
  "/resellers",
  requirePermission("resellers", "create"),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        email: z.string().email(),
        fullName: z.string().min(2),
        password: z
          .string()
          .min(8, "Password must be at least 8 characters")
          .regex(/[a-z]/, "Password must include a lowercase letter")
          .regex(/[A-Z]/, "Password must include an uppercase letter")
          .regex(/[^A-Za-z0-9]/, "Password must include a special character"),
        commissionPercent: z.number().min(0).max(100),
      })
      .parse(req.body);

    const brandId = req.user!.brandId;
    if (!brandId) throw badRequest("Resellers are recruited by a brand's admin — open the brand to add one.");
    const db = await requestTenant(req);
    const existing = await db.user.findUnique({ where: { email: data.email } });
    if (existing) throw new HttpError(409, "Email already registered");
    const passwordHash = await hashPassword(data.password);
    const referralCode = await uniqueReferralCode(db);
    const reseller = await db.user.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        passwordHash,
        role: "RESELLER",
        commissionPercent: data.commissionPercent,
        referralCode,
      },
      select: resellerSelect,
    });
    // Email the reseller their credentials so they can log in (best-effort).
    void emailResellerWelcome({
      email: data.email,
      fullName: data.fullName,
      password: data.password,
      referralCode,
    }).catch(() => {});

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "reseller.create",
      targetType: "user",
      targetId: reseller.id,
      metadata: { email: reseller.email, commissionPercent: reseller.commissionPercent },
      ip: req.ip,
    });
    res.status(201).json(serializeReseller(reseller));
  }),
);

router.patch(
  "/resellers/:id",
  requirePermission("resellers", "edit"),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fullName: z.string().min(1).optional(),
        commissionPercent: z.number().min(0).max(100).optional(),
      })
      .parse(req.body);
    // Scoped, not just existence-checked — by id alone a brand admin could edit another brand's reseller.
    const exists = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { id: req.params.id, role: "RESELLER" },
    });
    if (!exists) throw notFound("Reseller not found");
    const updated = await (await planeOf(req.user!.brandId ?? null)).user.update({
      where: { id: req.params.id },
      data,
      select: resellerSelect,
    });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "reseller.update",
      targetType: "user",
      targetId: req.params.id,
      metadata: data,
      ip: req.ip,
    });
    res.json(serializeReseller(updated));
  }),
);

router.delete(
  "/resellers/:id",
  requirePermission("resellers", "delete"),
  asyncHandler(async (req, res) => {
    // Tenant-scoped for the same reason as the PATCH above — a brand admin must
    // not be able to delete another brand's reseller by guessing an id.
    const exists = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { id: req.params.id, role: "RESELLER" },
    });
    if (!exists) throw notFound("Reseller not found");
    await (await planeOf(req.user!.brandId ?? null)).user.delete({ where: { id: req.params.id } });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "reseller.delete",
      targetType: "user",
      targetId: req.params.id,
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

/* ------------- Stripe product/price sync (plans & add-ons) --------- */
/** Sync a plan/add-on to Stripe. No-op when Stripe isn't configured (row saved without ids); 502 if a configured call fails. */
async function syncStripe(opts: {
  existingProductId: string | null;
  existingPriceId: string | null;
  name: string;
  description: string;
  amountCents: number;
  currency: string;
  interval: StripeInterval;
  /** Units per cycle (Stripe interval_count); 1 = a plain one-unit cycle. */
  intervalCount: number;
  active: boolean;
  priceChanged: boolean;
}): Promise<{ stripeProductId?: string; stripePriceId?: string }> {
  if (!isStripeConfigured()) return {};
  try {
    if (!opts.existingProductId) {
      const { productId, priceId } = await createStripeProductPrice({
        name: opts.name,
        description: opts.description,
        amountCents: opts.amountCents,
        currency: opts.currency,
        interval: opts.interval,
        intervalCount: opts.intervalCount,
      });
      return { stripeProductId: productId, stripePriceId: priceId };
    }
    await updateStripeProduct(opts.existingProductId, {
      name: opts.name,
      description: opts.description,
      active: opts.active,
    });
    if (opts.priceChanged) {
      const priceId = await createStripePrice(
        opts.existingProductId,
        opts.amountCents,
        opts.currency,
        opts.interval,
        opts.intervalCount,
      );
      if (opts.existingPriceId) await archiveStripePrice(opts.existingPriceId);
      return { stripePriceId: priceId };
    }
    return {};
  } catch (e) {
    throw new HttpError(502, `Stripe sync failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

/* ----------------------------- Plans ------------------------------- */
const planInput = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().optional(),
  // Cycle length is intervalCount; a literal so a stray "year" can't pair with a count Stripe rejects.
  interval: z.literal("month").optional(),
  // Stripe caps a cycle at one year. Refused here rather than as a Stripe error after the row is written.
  intervalCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_MONTHLY_INTERVAL_COUNT, `A billing cycle can't be longer than ${MAX_MONTHLY_INTERVAL_COUNT} months.`)
    .optional(),
  includedMinutes: z.number().int().nonnegative().optional(),
  features: z.array(z.string()).optional(),
  smsEnabled: z.boolean().optional(),
  smsToCallerEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  customCrmEnabled: z.boolean().optional(),
  multilingualEnabled: z.boolean().optional(),
  transcriptsEnabled: z.boolean().optional(),
  callTransferEnabled: z.boolean().optional(),
  // 0 = unlimited (same convention as includedMinutes). Capped at
  // MAX_DEPARTMENTS so a plan can't promise more than the tool supports.
  callTransferLimit: z.number().int().min(0).max(MAX_DEPARTMENTS).optional(),
  allowedVoices: z.array(z.string()).optional(), // deprecated — kept for back-compat
  // Voice Bank category this plan unlocks (empty string → null = no picker).
  voiceCategoryId: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().nullable().optional(),
  ),
  active: z.boolean().optional(),
  // Non-negative only — negatives (e.g. -2) confuse admins and aren't needed;
  // 0,1,2… is enough to order plans (lower = shown first).
  sortOrder: z.number().int().min(0, "Sort order must be 0 or a positive number").optional(),
  recommended: z.boolean().optional(),
  // Pre-selected plan on the onboarding subscribe page (only one may be default).
  isDefault: z.boolean().optional(),
});

/** Subscription statuses that count as a "live" subscriber holding a plan. */
const LIVE_SUB_STATUSES = ["trialing", "active", "past_due"];

/** How many users are actively on a given plan (live subscribers). */
async function planSubscriberCount(planId: string): Promise<number> {
  let total = 0;
  for (const { db } of await allTenants()) {
    total += await db.profile.count({
      where: { subscriptionPlanId: planId, subscriptionStatus: { in: LIVE_SUB_STATUSES } },
    });
  }
  return total;
}

/** Live subscribers per plan, summed over every brand's database — the plan
 *  is the platform's, its subscribers are everywhere. */
async function liveSubscribersByPlan(): Promise<Map<string | null, number>> {
  const countById = new Map<string | null, number>();
  for (const { db } of await allTenants()) {
    const counts = await db.profile.groupBy({
      by: ["subscriptionPlanId"],
      where: { subscriptionStatus: { in: LIVE_SUB_STATUSES }, subscriptionPlanId: { not: null } },
      _count: { _all: true },
    });
    for (const c of counts) countById.set(c.subscriptionPlanId, (countById.get(c.subscriptionPlanId) ?? 0) + c._count._all);
  }
  return countById;
}

router.get(
  "/plans",
  requirePermission("plans"),
  asyncHandler(async (req, res) => {
    // A brand's people see only the plans the platform lets that brand sell (its planIds; empty = every
    // plan). The platform's own people have no brand and see them all.
    const allowed = brandPlanIds(cachedBrand(req.user!.brandId));
    const plans = await prisma.subscriptionPlan.findMany({
      ...(allowed.length ? { where: { id: { in: allowed } } } : {}),
      // sortOrder first; ties broken by price, then creation time — so plans with
      // the same sort order always come out in a stable, predictable order.
      orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { createdAt: "asc" }],
    });
    // Annotate each plan with its live subscriber count + legacy flag so the
    // admin UI can lock pricing edits / deletes and badge legacy plans.
    const countById = await liveSubscribersByPlan();
    res.json(
      plans.map((p) => {
        const subscriberCount = countById.get(p.id) ?? 0;
        return { ...p, subscriberCount, legacy: !p.active && subscriberCount > 0 };
      }),
    );
  }),
);

// Plans are the platform's defaults: only the super admin creates, edits, deletes or syncs them.
// A brand admin reads them (GET above) and prices on top via the brand pricing addon.
router.post(
  "/plans",
  requireSuperAdmin,
  requirePermission("plans", "create"),
  asyncHandler(async (req, res) => {
    const data = planInput.parse(req.body);
    const currency = data.currency ?? "usd";
    const interval = (data.interval ?? "month") as StripeInterval;
    const intervalCount = data.intervalCount ?? 1;
    // The subscribe page only lists active plans, so an inactive default would silently do nothing while clearing the real one.
    if (data.isDefault && data.active === false) {
      throw badRequest("An inactive plan can't be the default plan. Activate it first.");
    }
    const stripeIds = await syncStripe({
      existingProductId: null,
      existingPriceId: null,
      name: data.displayName,
      description: data.description ?? "",
      amountCents: data.priceCents,
      currency,
      interval,
      intervalCount,
      active: data.active ?? true,
      priceChanged: true,
    });
    // One default only. Clear + create in one transaction so a failed create can't leave zero defaults.
    const plan = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.subscriptionPlan.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.subscriptionPlan.create({
        data: { ...data, currency, interval, intervalCount, features: data.features ?? [], ...stripeIds },
      });
    });
    res.status(201).json(plan);
  }),
);

router.patch(
  "/plans/:id",
  requireSuperAdmin,
  requirePermission("plans", "edit"),
  asyncHandler(async (req, res) => {
    const data = planInput.partial().parse(req.body);
    const exists = await prisma.subscriptionPlan.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Plan not found");

    // A plan with live subscribers: pricing/interval/minutes are locked (they'd alter existing Stripe subs). Deactivate and create a new one instead.
    const subscriberCount = await planSubscriberCount(req.params.id);
    if (subscriberCount > 0) {
      const changesPrice = data.priceCents !== undefined && data.priceCents !== exists.priceCents;
      const changesInterval =
        (data.interval !== undefined && data.interval !== exists.interval) ||
        (data.intervalCount !== undefined && data.intervalCount !== exists.intervalCount);
      const changesMinutes =
        data.includedMinutes !== undefined && data.includedMinutes !== exists.includedMinutes;
      if (changesPrice || changesInterval || changesMinutes) {
        throw badRequest(
          `This plan has ${subscriberCount} active subscriber(s), so price, interval and included minutes are locked. Deactivate it (existing users keep it as a legacy plan) and create a new plan to change pricing.`,
        );
      }
    }

    const currency = data.currency ?? exists.currency;
    const interval = (data.interval ?? exists.interval) as StripeInterval;
    const intervalCount = data.intervalCount ?? exists.intervalCount;
    const amountCents = data.priceCents ?? exists.priceCents;
    // Cycle length is baked into the Stripe price, so changing it needs a new one
    // just as much as changing the amount does.
    const priceChanged =
      amountCents !== exists.priceCents ||
      currency !== exists.currency ||
      interval !== exists.interval ||
      intervalCount !== exists.intervalCount;

    // The default plan is pre-selected on the subscribe page, which only lists
    // active plans — so the plan can't end up both default and inactive.
    const willBeActive = data.active ?? exists.active;
    if (data.isDefault && !willBeActive) {
      throw badRequest("An inactive plan can't be the default plan. Activate it first.");
    }
    // Deactivating the current default would leave a phantom default the subscribe
    // page can never show — drop the flag when that happens.
    const clearsOwnDefault = data.active === false && exists.isDefault;

    const stripeIds = await syncStripe({
      existingProductId: exists.stripeProductId,
      existingPriceId: exists.stripePriceId,
      name: data.displayName ?? exists.displayName,
      description: data.description ?? exists.description,
      amountCents,
      currency,
      interval,
      intervalCount,
      active: data.active ?? exists.active,
      priceChanged,
    });

    // One default only. Clear + update in one transaction so a failed update can't leave zero defaults.
    const plan = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.subscriptionPlan.updateMany({
          where: { isDefault: true, id: { not: req.params.id } },
          data: { isDefault: false },
        });
      }
      return tx.subscriptionPlan.update({
        where: { id: req.params.id },
        data: { ...data, ...stripeIds, ...(clearsOwnDefault ? { isDefault: false } : {}) },
      });
    });
    // A new base means new brand Prices (base + addon). Rebuilt in the background — the save must not hang on N Stripe calls.
    if (priceChanged) {
      void refreshBrandPricesForPlan(plan.id).catch(() => undefined);
    }
    res.json(plan);
  }),
);

router.delete(
  "/plans/:id",
  requireSuperAdmin,
  requirePermission("plans", "delete"),
  asyncHandler(async (req, res) => {
    const exists = await prisma.subscriptionPlan.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Plan not found");

    // Never orphan live subscribers — block delete, point the admin at deactivation.
    const subscriberCount = await planSubscriberCount(req.params.id);
    if (subscriberCount > 0) {
      throw new HttpError(
        409,
        `Can't delete a plan with ${subscriberCount} active subscriber(s). Deactivate it instead — current users keep it as a legacy plan and new users won't see it.`,
      );
    }

    if (isStripeConfigured() && exists.stripeProductId) {
      try {
        await archiveStripeProduct(exists.stripeProductId);
      } catch {
        /* best-effort — still remove locally */
      }
    }
    await prisma.subscriptionPlan.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

/** Bulk-sync all local plans to Stripe (creates missing products/prices, updates existing). */
router.post(
  "/plans/sync-stripe",
  requireSuperAdmin,
  requirePermission("plans", "edit"),
  asyncHandler(async (_req, res) => {
    if (!isStripeConfigured()) throw badRequest("Stripe is not configured");
    const plans = await prisma.subscriptionPlan.findMany();
    const results: Array<{ id: string; name: string; synced: boolean; error?: string }> = [];
    for (const plan of plans) {
      try {
        const stripeIds = await syncStripe({
          existingProductId: plan.stripeProductId,
          existingPriceId: plan.stripePriceId,
          name: plan.displayName,
          description: plan.description,
          amountCents: plan.priceCents,
          currency: plan.currency,
          intervalCount: plan.intervalCount,
          interval: plan.interval as StripeInterval,
          active: plan.active,
          priceChanged: !plan.stripePriceId,
        });
        if (stripeIds.stripeProductId || stripeIds.stripePriceId) {
          await prisma.subscriptionPlan.update({
            where: { id: plan.id },
            data: stripeIds,
          });
        }
        results.push({ id: plan.id, name: plan.displayName, synced: true });
      } catch (e) {
        results.push({
          id: plan.id,
          name: plan.displayName,
          synced: false,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }
    res.json({ results });
  }),
);

/* ----------------------------- Coupons ----------------------------- */
const couponBase = z.object({
  code: z.string().min(3).max(40),
  displayName: z.string().min(1),
  description: z.string().optional(),
  // At least one of these must be set — checked in the refine below, since zod
  // can't express "either field, but not neither" as clearly as an explicit test.
  percentOff: z.number().int().min(1).max(100).nullable().optional(),
  bonusMinutes: z.number().int().min(1).nullable().optional(),
  durationCycles: z.number().int().min(1).max(60).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  newCustomersOnly: z.boolean().optional(),
  planIds: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

const couponInput = couponBase
  .refine((c) => c.percentOff != null || c.bonusMinutes != null, {
    message: "A coupon must give a percentage discount, bonus minutes, or both.",
  })
  // Every NEW coupon needs an expiry or it's claimable forever. Create only — older coupons legitimately have
  // none and must stay editable (PATCH blocks clearing an existing date instead).
  .refine((c) => c.expiresAt != null, {
    message: "Pick a 'Redeemable until' date — every coupon needs one.",
    path: ["expiresAt"],
  })
  .refine((c) => !c.startsAt || !c.expiresAt || new Date(c.startsAt) < new Date(c.expiresAt), {
    message: "The start date must be before the expiry date.",
  })
  // A coupon born already expired can never be redeemed — it's always a mistake.
  // (Stopping a LIVE coupon is what the `active` toggle is for.)
  .refine((c) => !c.expiresAt || new Date(c.expiresAt) > new Date(), {
    message: "The expiry date can't be in the past.",
  })
  // A backdated start is just "start now" spelled confusingly; blank already means that.
  .refine((c) => !c.startsAt || new Date(c.startsAt) >= earliestAllowedStart(), {
    message: "The start date can't be in the past — leave it blank to start straight away.",
  });

/** Earliest accepted startsAt: 24h ago. A tolerance, not server midnight — the client sends LOCAL midnight, which can sit 14h either side, so Sydney picking "today" must pass. */
function earliestAllowedStart(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

// A patch carries only the fields being changed, so the cross-field rules can't
// be expressed here — they're checked against the MERGED result in the handler.
const couponPatchInput = couponBase.partial();

/** May a coupon's terms still change? `locked` includes live checkouts (the customer has already SEEN the terms), not stale reservations (the sweep is about to delete them). */
async function couponUsage(couponId: string): Promise<{
  redeemed: number;
  livePending: number;
  locked: boolean;
}> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
  // A coupon is the platform's; its redemptions are in every brand's database.
  let redeemed = 0;
  let livePending = 0;
  for (const { db } of await allTenants()) {
    const [r, p] = await Promise.all([
      db.couponRedemption.count({ where: { couponId, status: { in: ["active", "exhausted", "revoked"] } } }),
      db.couponRedemption.count({ where: { couponId, status: "pending", reservedAt: { gt: cutoff } } }),
    ]);
    redeemed += r;
    livePending += p;
  }
  return { redeemed, livePending, locked: redeemed + livePending > 0 };
}

/** Why a coupon's terms can't be edited right now, phrased for the admin. */
function couponLockMessage(redeemed: number): string {
  return redeemed > 0
    ? `This coupon has been redeemed ${redeemed} time(s), so its code, discount and duration are locked — changing them would alter discounts already running. Deactivate it and create a new code instead.`
    : "Someone is checking out with this coupon right now, so its code, discount and duration are locked for a few minutes — they've already been shown these terms. Try again shortly, or deactivate it to stop new redemptions.";
}

router.get(
  "/coupons",
  requirePermission("coupons"),
  asyncHandler(async (_req, res) => {
    const coupons = await prisma.coupon.findMany({ orderBy: [{ createdAt: "desc" }] });
    // Annotate with live redemption counts so the UI can lock edits + show supply.
    // Redemptions live in every brand's database: one pass gathers them all.
    const byCoupon = new Map<string, { active: number; total: number }>();
    const livePendingById = new Map<string, number>();
    const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
    for (const { db } of await allTenants()) {
      const [counts, livePendingRows] = await Promise.all([
        db.couponRedemption.groupBy({ by: ["couponId", "status"], _count: { _all: true } }),
        db.couponRedemption.groupBy({
          by: ["couponId"],
          where: { status: "pending", reservedAt: { gt: cutoff } },
          _count: { _all: true },
        }),
      ]);
      for (const c of counts) {
        const entry = byCoupon.get(c.couponId) ?? { active: 0, total: 0 };
        if (c.status === "active") entry.active += c._count._all;
        if (c.status !== "pending") entry.total += c._count._all;
        byCoupon.set(c.couponId, entry);
      }
      for (const r of livePendingRows) {
        livePendingById.set(r.couponId, (livePendingById.get(r.couponId) ?? 0) + r._count._all);
      }
    }
    res.json(
      coupons.map((c) => {
        const entry = byCoupon.get(c.id) ?? { active: 0, total: 0 };
        const livePending = livePendingById.get(c.id) ?? 0;
        return {
          ...c,
          activeRedemptions: entry.active,
          totalRedemptions: entry.total,
          livePending,
          /** Terms frozen — someone has redeemed it, or is checking out with it. */
          locked: entry.total + livePending > 0,
          // "Spent" = the supply cap is used up. Distinct from `active: false`.
          soldOut: c.maxRedemptions != null && c.redeemedCount >= c.maxRedemptions,
        };
      }),
    );
  }),
);

router.get(
  "/coupons/:id/redemptions",
  requirePermission("coupons"),
  asyncHandler(async (req, res) => {
    // From every brand's database, newest first, each row naming its brand.
    const redemptions = (
      await Promise.all(
        (await allTenants()).map(async ({ brandId, db }) =>
          (
            await db.couponRedemption.findMany({
              where: { couponId: req.params.id },
              orderBy: { reservedAt: "desc" },
              take: 200,
              include: { user: { select: { id: true, email: true, fullName: true } } },
            })
          ).map((r) => ({ ...r, brandId })),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.reservedAt.getTime() - a.reservedAt.getTime())
      .slice(0, 200);
    res.json(redemptions);
  }),
);

router.post(
  "/coupons",
  requirePermission("coupons", "create"),
  asyncHandler(async (req, res) => {
    const data = couponInput.parse(req.body);
    const code = normalizeCode(data.code);

    const clash = await prisma.coupon.findUnique({ where: { code } });
    if (clash) throw badRequest(`The code ${code} is already in use.`);
    // Coupon and referral codes share one namespace to the customer, so a collision is ambiguous at redemption.
    const referralClash = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { referralCode: code },
      select: { id: true },
    });
    if (referralClash) throw badRequest(`${code} is already a reseller referral code.`);

    const durationCycles = data.durationCycles ?? 1;
    const { stripeCouponId } = await syncStripeCoupon({
      code,
      displayName: data.displayName,
      percentOff: data.percentOff ?? null,
      durationCycles,
      stripeCouponId: null,
    });

    const coupon = await prisma.coupon.create({
      data: {
        code,
        displayName: data.displayName,
        description: data.description ?? "",
        percentOff: data.percentOff ?? null,
        bonusMinutes: data.bonusMinutes ?? null,
        durationCycles,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        maxRedemptions: data.maxRedemptions ?? null,
        newCustomersOnly: data.newCustomersOnly ?? true,
        planIds: data.planIds ?? [],
        active: data.active ?? true,
        stripeCouponId,
      },
    });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "coupons.create",
      targetType: "coupon",
      targetId: coupon.id,
      metadata: { code, percentOff: coupon.percentOff, bonusMinutes: coupon.bonusMinutes, durationCycles },
      ip: req.ip,
    });
    res.status(201).json(coupon);
  }),
);

router.patch(
  "/coupons/:id",
  requirePermission("coupons", "edit"),
  asyncHandler(async (req, res) => {
    const data = couponPatchInput.parse(req.body);
    const exists = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Coupon not found");

    // Cross-field rules, checked against the MERGED coupon: a patch that only
    // moves `expiresAt` must still not land it before the existing `startsAt`.
    const mergedStartsAt =
      data.startsAt !== undefined ? (data.startsAt ? new Date(data.startsAt) : null) : exists.startsAt;
    const mergedExpiresAt =
      data.expiresAt !== undefined ? (data.expiresAt ? new Date(data.expiresAt) : null) : exists.expiresAt;
    if (mergedStartsAt && mergedExpiresAt && mergedStartsAt >= mergedExpiresAt) {
      throw badRequest("The start date must be before the expiry date.");
    }
    // An existing expiry can be MOVED but never cleared, or the create-time rule is trivially bypassed.
    // Coupons that never had one predate the rule and are left alone.
    if (exists.expiresAt && mergedExpiresAt === null) {
      throw badRequest(
        "A coupon can't have its 'Redeemable until' date removed — move it instead, or turn Active off to stop it now.",
      );
    }
    // Guard only dates the admin MOVED — compare to the STORED value, not payload presence. The form submits every
    // field on every save, so "present = changed" made an expired coupon uneditable.
    const sameInstant = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);

    if (
      !sameInstant(mergedExpiresAt, exists.expiresAt) &&
      mergedExpiresAt &&
      mergedExpiresAt <= new Date()
    ) {
      throw badRequest(
        "The expiry date can't be in the past. To stop this coupon now, turn Active off instead.",
      );
    }
    if (
      !sameInstant(mergedStartsAt, exists.startsAt) &&
      mergedStartsAt &&
      mergedStartsAt < earliestAllowedStart()
    ) {
      throw badRequest(
        "The start date can't be in the past — leave it blank to start straight away.",
      );
    }

    // Like in-use plans: once anyone has seen the terms (redeemed or mid-checkout) they're locked. Deactivate and make a new code.
    const { redeemed, locked } = await couponUsage(req.params.id);
    if (locked) {
      const changesValue =
        (data.percentOff !== undefined && data.percentOff !== exists.percentOff) ||
        (data.bonusMinutes !== undefined && data.bonusMinutes !== exists.bonusMinutes) ||
        (data.durationCycles !== undefined && data.durationCycles !== exists.durationCycles) ||
        (data.code !== undefined && normalizeCode(data.code) !== exists.code);
      if (changesValue) throw badRequest(couponLockMessage(redeemed));
    }

    // The coupon as it will be AFTER this patch; terms collapse to the stored value when locked.
    const nextCode = data.code !== undefined ? normalizeCode(data.code) : exists.code;
    const nextDisplayName = data.displayName ?? exists.displayName;
    const nextPercentOff =
      !locked && data.percentOff !== undefined ? data.percentOff ?? null : exists.percentOff;
    const nextBonusMinutes =
      !locked && data.bonusMinutes !== undefined ? data.bonusMinutes ?? null : exists.bonusMinutes;
    const nextDurationCycles =
      !locked && data.durationCycles !== undefined ? data.durationCycles : exists.durationCycles;

    if (nextPercentOff == null && nextBonusMinutes == null) {
      throw badRequest("A coupon must give a percentage discount, bonus minutes, or both.");
    }

    // Renaming the code has to pass the same namespace checks as creating one.
    if (nextCode !== exists.code) {
      const clash = await prisma.coupon.findUnique({ where: { code: nextCode } });
      if (clash) throw badRequest(`The code ${nextCode} is already in use.`);
      const referralClash = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
        where: { referralCode: nextCode },
        select: { id: true },
      });
      if (referralClash) throw badRequest(`${nextCode} is already a reseller referral code.`);
    }

    // Stripe coupons are IMMUTABLE: a changed percentage/duration needs a fresh one, or Stripe keeps billing the old rate.
    let stripeCouponId = exists.stripeCouponId;
    const termsChanged =
      nextPercentOff !== exists.percentOff || nextDurationCycles !== exists.durationCycles;
    if (termsChanged) {
      if (exists.stripeCouponId) await deleteStripeCoupon(exists.stripeCouponId);
      ({ stripeCouponId } = await syncStripeCoupon({
        code: nextCode,
        displayName: nextDisplayName,
        percentOff: nextPercentOff,
        durationCycles: nextDurationCycles,
        stripeCouponId: null,
      }));
    }

    const coupon = await prisma.coupon.update({
      where: { id: req.params.id },
      data: {
        code: nextCode,
        percentOff: nextPercentOff,
        bonusMinutes: nextBonusMinutes,
        durationCycles: nextDurationCycles,
        stripeCouponId,
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.startsAt !== undefined
          ? { startsAt: data.startsAt ? new Date(data.startsAt) : null }
          : {}),
        ...(data.expiresAt !== undefined
          ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null }
          : {}),
        ...(data.maxRedemptions !== undefined ? { maxRedemptions: data.maxRedemptions ?? null } : {}),
        ...(data.newCustomersOnly !== undefined ? { newCustomersOnly: data.newCustomersOnly } : {}),
        ...(data.planIds !== undefined ? { planIds: data.planIds } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "coupons.update",
      targetType: "coupon",
      targetId: coupon.id,
      metadata: { code: coupon.code, fields: Object.keys(data) },
      ip: req.ip,
    });
    res.json(coupon);
  }),
);

router.delete(
  "/coupons/:id",
  requirePermission("coupons", "delete"),
  asyncHandler(async (req, res) => {
    const exists = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Coupon not found");

    // Deleting cascades the redemption rows that stop double-redemption, and strands a mid-payment reservation. Deactivate instead.
    const { redeemed, locked } = await couponUsage(req.params.id);
    if (locked) {
      throw new HttpError(
        409,
        redeemed > 0
          ? `Can't delete a coupon that's been redeemed ${redeemed} time(s) — it would erase the record that stops those customers redeeming it again. Deactivate it instead: no new redemptions, existing discounts unaffected.`
          : "Someone is checking out with this coupon right now, so it can't be deleted. Try again in a few minutes, or deactivate it to stop new redemptions.",
      );
    }

    if (exists.stripeCouponId) await deleteStripeCoupon(exists.stripeCouponId);
    await prisma.coupon.delete({ where: { id: req.params.id } });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "coupons.delete",
      targetType: "coupon",
      targetId: req.params.id,
      metadata: { code: exists.code },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

/** The customer's Discount card in one call. Gated on `coupons`, not `customers`, so view-only customer staff never load it. */
router.get(
  "/customers/:id/coupon",
  requirePermission("coupons"),
  asyncHandler(async (req, res) => {
    const user = await (await planeOf(req.user!.brandId ?? null)).user.findUnique({
      where: { id: req.params.id },
      select: { id: true, role: true },
    });
    if (!user) throw notFound("Customer not found");
    if (isAdminTeamRole(user.role))
      throw badRequest("This endpoint is for customers only.");

    const live = await getActiveRedemption(user.id);
    res.json({
      discount: live
        ? {
            code: live.coupon.code,
            displayName: live.coupon.displayName,
            percentOff: live.coupon.percentOff,
            bonusMinutes: live.coupon.bonusMinutes,
            cyclesUsed: live.cyclesUsed,
            durationCycles: live.coupon.durationCycles,
            cyclesLeft: Math.max(0, live.coupon.durationCycles - live.cyclesUsed),
            grantedByAdmin: !!live.grantedBy,
            appliedAt: live.appliedAt?.toISOString() ?? null,
          }
        : null,
      coupons: await grantableCoupons(user.id),
    });
  }),
);

/** Grant a coupon to one customer (retention / comp) — no code typed by them. */
router.post(
  "/customers/:id/coupon",
  requirePermission("coupons", "edit"),
  asyncHandler(async (req, res) => {
    const { couponId, override } = z
      .object({
        couponId: z.string().min(1),
        // Granting past the window/plan restriction is allowed but never implicit — and audited.
        override: z.boolean().optional(),
      })
      .parse(req.body);
    const user = await (await planeOf(req.user!.brandId ?? null)).user.findUnique({
      where: { id: req.params.id },
      select: { id: true, role: true },
    });
    if (!user) throw notFound("Customer not found");
    // Staff/admins don't hold subscriptions, so a coupon on one is meaningless.
    if (isAdminTeamRole(user.role))
      throw badRequest("Coupons can only be granted to customers.");

    const result = await grantCoupon(user.id, couponId, req.user!.sub, {
      override: override === true,
    });
    if (!result.ok) throw badRequest(GRANT_REJECTION_MESSAGE[result.reason]);

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "coupons.grant",
      targetType: "user",
      targetId: user.id,
      // The override is what's worth looking up later — who granted an ended campaign, and when.
      metadata: override === true ? { couponId, override: true } : { couponId },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

/** Remove a live discount. `releaseSlot=true` deletes the redemption so the code can be used again (undo for a mistaken grant); default keeps it spent. */
router.delete(
  "/customers/:id/coupon",
  requirePermission("coupons", "edit"),
  asyncHandler(async (req, res) => {
    const releaseSlot = req.query.releaseSlot === "true";
    const user = await (await planeOf(req.user!.brandId ?? null)).user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!user) throw notFound("Customer not found");

    const removed = await revokeRedemption(user.id, {
      releaseSlot,
      reason: releaseSlot
        ? "Coupon removed by an admin — the customer can redeem this code again"
        : "Coupon removed by an admin",
    });
    if (!removed) throw badRequest("This customer has no active discount to remove.");

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "coupons.revoke",
      targetType: "user",
      targetId: user.id,
      metadata: { releaseSlot },
      ip: req.ip,
    });
    res.json({ ok: true, releaseSlot });
  }),
);

/* ------------------- Global trial length (days) -------------------- */
const TRIAL_DAYS_KEY = "trial.days";
const DEFAULT_TRIAL_DAYS = 14;

router.get(
  "/trial-days",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_DAYS_KEY } });
    const days = row ? Number(row.value) || DEFAULT_TRIAL_DAYS : DEFAULT_TRIAL_DAYS;
    res.json({ days });
  }),
);

router.put(
  "/trial-days",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { days } = z.object({ days: z.number().int().min(1).max(365) }).parse(req.body);
    await prisma.platformSetting.upsert({
      where: { key: TRIAL_DAYS_KEY },
      update: { value: String(days), isSecret: false },
      create: { key: TRIAL_DAYS_KEY, value: String(days), isSecret: false },
    });
    res.json({ days });
  }),
);

// Reporting FX rates (→ USD). Set by hand, not fetched live — a dashboard that restates last month's MRR because the market moved is worse.
router.get(
  "/fx-rates",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    // Every non-USD currency a plan is priced in, so the UI can show exactly what's missing.
    const plans = await prisma.subscriptionPlan.findMany({ select: { currency: true } });
    const needed = [
      ...new Set(
        plans
          .map((p) => (p.currency || REPORTING_CURRENCY).toLowerCase())
          .filter((c) => c !== REPORTING_CURRENCY),
      ),
    ].sort();
    res.json({ base: REPORTING_CURRENCY, rates: await getFxRates(), needed, defaults: DEFAULT_FX_RATES });
  }),
);

router.put(
  "/fx-rates",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { rates } = z
      .object({
        rates: z.record(
          z.string().trim().toLowerCase().length(3),
          // Positive and finite only: a zero rate would erase that currency's
          // revenue from every report, silently and without an error anywhere.
          z.number().positive().finite(),
        ),
      })
      .parse(req.body);
    await prisma.platformSetting.upsert({
      where: { key: FX_RATES_KEY },
      update: { value: JSON.stringify(rates), isSecret: false },
      create: { key: FX_RATES_KEY, value: JSON.stringify(rates), isSecret: false },
    });
    // Reporting rates move every revenue number on the dashboard, so who
    // changed them and to what is worth keeping.
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "settings.fx_rates.update",
      targetType: "settings",
      targetId: FX_RATES_KEY,
      metadata: { rates },
      ip: req.ip,
    });
    res.json({ base: REPORTING_CURRENCY, rates: await getFxRates() });
  }),
);

// Global master-prompt template. Empty = built-in default; changes reach live assistants on their next AI Brain save/sync.
router.get(
  "/prompt-template",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const template = getPromptTemplate();
    // Compile a sample so the admin can see the effect against real defaults.
    const sample: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      identity: { ...DEFAULT_AGENT_CONFIG.identity, businessName: "Acme Plumbing" },
    };
    res.json({
      template, // "" → using the built-in default
      default: DEFAULT_PROMPT_TEMPLATE,
      isDefault: !template.trim(),
      preview: compileMasterPrompt(sample, template),
    });
  }),
);

router.put(
  "/prompt-template",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { template } = z.object({ template: z.string().max(20000) }).parse(req.body);
    // A non-empty template MUST keep all three placeholders or names/knowledge silently vanish from every prompt. Empty resets to default.
    const incoming = template.trim();
    if (incoming) {
      const missing: string[] = [];
      if (!/\{\{\s*assistantName\s*\}\}/i.test(incoming)) missing.push("{{assistantName}}");
      if (!/\{\{\s*businessName\s*\}\}/i.test(incoming)) missing.push("{{businessName}}");
      if (!/\{\{\s*sections\s*\}\}/i.test(incoming)) missing.push("{{sections}}");
      if (missing.length) {
        const label = missing.join(" and ");
        throw badRequest(
          `The template must include ${label}. ${label} ${missing.length > 1 ? "are" : "is"} required so each customer's assistant name, business name and knowledge get inserted. Add ${missing.length > 1 ? "them" : "it"} back, or use Reset to restore the default.`,
        );
      }
    }
    await setPromptTemplate(template, req.user!.email);
    const saved = getPromptTemplate();
    const sample: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      identity: { ...DEFAULT_AGENT_CONFIG.identity, businessName: "Acme Plumbing" },
    };
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "prompt-template.save",
      targetType: "settings",
      metadata: { length: saved.length, reset: !saved.trim() },
      ip: req.ip,
    });
    res.json({
      template: saved,
      default: DEFAULT_PROMPT_TEMPLATE,
      isDefault: !saved.trim(),
      preview: compileMasterPrompt(sample, saved),
    });
  }),
);

// Per-country regional styles — the persona block that makes an assistant sound local.
router.get(
  "/country-styles",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    // Effective = built-in defaults with admin overrides applied. `builtins` lets
    // the UI show a per-country "modified" badge and a reset-to-default action.
    res.json({
      styles: getEffectiveCountryStyles(),
      builtins: BUILTIN_COUNTRY_STYLES,
    });
  }),
);

router.put(
  "/country-styles",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // A map of ISO country → style text. Only entries differing from the built-in
    // are stored (setCountryStyles handles that); a blank entry disables a country.
    const { styles } = z
      .object({ styles: z.record(z.string(), z.string().max(4000)) })
      .parse(req.body);
    await setCountryStyles(styles, req.user!.email);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "country-styles.save",
      targetType: "settings",
      metadata: { countries: Object.keys(styles).length },
      ip: req.ip,
    });
    res.json({ styles: getEffectiveCountryStyles(), builtins: BUILTIN_COUNTRY_STYLES });
  }),
);

// Industry suggestions review. Customer proposals wait here until approved (joins the public list) or rejected.
router.get(
  "/industries",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(getIndustryAdminView());
  }),
);

router.post(
  "/industries/approve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Re-sanitize even though it was cleaned on submit — defence in depth.
    const result = sanitizeIndustry((req.body as { value?: unknown })?.value);
    if ("error" in result) throw badRequest(result.error);
    await approveIndustry(result.value);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "industry.approve",
      targetType: "settings",
      metadata: { value: result.value },
      ip: req.ip,
    });
    res.json(getIndustryAdminView());
  }),
);

router.post(
  "/industries/reject",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { value } = z.object({ value: z.string().min(1).max(80) }).parse(req.body);
    await rejectIndustry(value);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "industry.reject",
      targetType: "settings",
      metadata: { value },
      ip: req.ip,
    });
    res.json(getIndustryAdminView());
  }),
);

router.delete(
  "/industries",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { value } = z.object({ value: z.string().min(1).max(80) }).parse(req.body);
    await removeApprovedIndustry(value);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "industry.remove",
      targetType: "settings",
      metadata: { value },
      ip: req.ip,
    });
    res.json(getIndustryAdminView());
  }),
);

// Admin-managed custom scripts (GA, GTM, pixels) the frontend injects into head/body/footer without a deploy.
router.get(
  "/seo",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ scripts: await getSeoScripts() });
  }),
);

router.put(
  "/seo",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { scripts } = z
      .object({
        scripts: z.object({
          head: z.string().max(20000),
          body: z.string().max(20000),
          footer: z.string().max(20000),
        }),
      })
      .parse(req.body);
    const saved = await setSeoScripts(scripts);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "seo.scripts.save",
      targetType: "settings",
      metadata: { head: saved.head.length, body: saved.body.length, footer: saved.footer.length },
      ip: req.ip,
    });
    res.json({ scripts: saved });
  }),
);

/** Version trail of the master-prompt template — every save/reset pushes the
 *  replaced version here, so an accidental "Reset to default" is recoverable. */
router.get(
  "/prompt-template/history",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      versions: getPromptTemplateHistory().map((v, i) => ({
        id: i,
        template: v.template, // "" = the built-in default was in use
        isDefault: !v.template.trim(),
        chars: (v.template.trim() || DEFAULT_PROMPT_TEMPLATE).length,
        replacedAt: v.replacedAt,
        replacedBy: v.replacedBy,
      })),
    });
  }),
);

// Gender-matched default assistant names, applied at onboarding by voice gender. Admin-editable.
router.get(
  "/agent-default-names",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(getAgentDefaultNames());
  }),
);

router.put(
  "/agent-default-names",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { male, female } = z
      .object({ male: z.string().max(NAME_MAX), female: z.string().max(NAME_MAX) })
      .parse(req.body);
    await setAgentDefaultNames(male, female);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "agent-default-names.save",
      targetType: "settings",
      metadata: getAgentDefaultNames(),
      ip: req.ip,
    });
    res.json(getAgentDefaultNames());
  }),
);

// Global default agent LLM. Fixed catalogue (AGENT_LLM_OPTIONS) so only Vapi-valid ids are stored; rolls out on next AI Brain save/sync.
router.get(
  "/agent-llm",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Providers + models are fetched live from Vapi (cached); `?refresh=true`
    // forces a fresh pull. cost/latency are merged from the bundled snapshot.
    const force = req.query.refresh === "true" || req.query.refresh === "1";
    const options = await getAgentLlmOptions(force);
    res.json({ ...getAgentLlm(), options, default: DEFAULT_AGENT_LLM });
  }),
);

router.put(
  "/agent-llm",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider, model } = z
      .object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) })
      .parse(req.body);
    // Validate against Vapi's live catalogue — a bad id would 400 every new agent.
    if (!(await isKnownAgentLlm(provider, model)))
      throw badRequest("Unknown model — pick one from the list.");
    await setAgentLlm(provider, model);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "agent-llm.save",
      targetType: "settings",
      metadata: { provider, model },
      ip: req.ip,
    });
    res.json({ ...getAgentLlm(), options: await getAgentLlmOptions(), default: DEFAULT_AGENT_LLM });
  }),
);

// Transcriber (STT) fallback. Primary stays auto-chosen by language; only backups that can hear the agent's language
// are applied (buildTranscriberFallbackPlan). Rolls out on next AI Brain save/sync.
router.get(
  "/transcriber-fallback",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Provider/model list is refreshed live from Vapi (cached); `?refresh=true` forces it.
    const force = req.query.refresh === "true" || req.query.refresh === "1";
    const options = await getTranscriberOptions(force);
    res.json({ ...getTranscriberFallback(), options });
  }),
);

router.put(
  "/transcriber-fallback",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { autoFallback, provider, model } = z
      .object({
        autoFallback: z.boolean(),
        provider: z.string().trim(),
        model: z.string().trim(),
      })
      .parse(req.body);
    // A preferred provider is optional, but when set it must be a known one — a bad
    // id would 400 every assistant sync that tries to graft it on.
    if (provider) {
      const options = await getTranscriberOptions();
      if (!isKnownTranscriber(options, provider, model))
        throw badRequest("Unknown transcriber — pick one from the list.");
    }
    await setTranscriberFallback({ autoFallback, provider, model });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "transcriber-fallback.save",
      targetType: "settings",
      metadata: { autoFallback, provider, model },
      ip: req.ip,
    });
    res.json({ ...getTranscriberFallback(), options: await getTranscriberOptions() });
  }),
);

// Onboarding card wall. Snapshotted per account at signup, so flipping it only affects the NEXT signup.
// Audited — "when was this flipped?" is the only way to explain why two customers behave differently.
router.get(
  "/onboarding",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ cardRequired: await getOnboardingCardRequired() });
  }),
);

router.put(
  "/onboarding",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { cardRequired } = z.object({ cardRequired: z.boolean() }).parse(req.body);
    // ON without Stripe would brick signup (the card screen needs a SetupIntent). OFF is always allowed — it's the way out.
    if (cardRequired && !isStripeConfigured()) {
      throw badRequest(
        "Stripe isn't configured, so new customers couldn't add a card — they'd be stuck. Configure Stripe first.",
      );
    }
    await setOnboardingCardRequired(cardRequired);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "onboarding.card-required.save",
      targetType: "settings",
      metadata: { cardRequired },
      ip: req.ip,
    });
    res.json({ cardRequired: await getOnboardingCardRequired() });
  }),
);

// Global trial minute quota. The trial ends when EITHER limit (days or minutes) hits first.
router.get(
  "/trial-minutes",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_MINUTES_KEY } });
    const minutes = row ? Number(row.value) || DEFAULT_TRIAL_MINUTES : DEFAULT_TRIAL_MINUTES;
    res.json({ minutes });
  }),
);

router.put(
  "/trial-minutes",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { minutes } = z.object({ minutes: z.number().int().min(1).max(100000) }).parse(req.body);
    await prisma.platformSetting.upsert({
      where: { key: TRIAL_MINUTES_KEY },
      update: { value: String(minutes), isSecret: false },
      create: { key: TRIAL_MINUTES_KEY, value: String(minutes), isSecret: false },
    });
    res.json({ minutes });
  }),
);

// Global per-call duration ceiling (abuse control). Saving re-stamps every live assistant so it applies immediately.
router.get(
  "/call-duration-cap",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getCallDurationCapSetting());
  }),
);

router.put(
  "/call-duration-cap",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { enabled, seconds } = z
      .object({
        enabled: z.boolean(),
        seconds: z.number().int().min(MIN_MAX_CALL_SECONDS).max(MAX_MAX_CALL_SECONDS),
      })
      .parse(req.body);
    const saved = await setCallDurationCapSetting({ enabled, seconds });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "call-duration-cap.save",
      targetType: "settings",
      metadata: { enabled, seconds: saved.seconds },
      ip: req.ip,
    });
    // Push the new ceiling to live assistants in the background — a sweep over
    // every customer can take a while and the admin shouldn't wait on it.
    void resyncAllCallCaps();
    res.json(saved);
  }),
);

// One-time assistant re-sync: re-pushes every assistant so it carries the current server.secret (pre-secret assistants
// 401 on real calls until rebuilt). Harmless to re-run. ADMIN-only; runs to completion and returns the count.
router.post(
  "/resync-assistants",
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!integrationsStatus().vapi) throw badRequest("Configure Vapi in Settings first.");
    const result = await resyncAllAssistants();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "assistants.resync",
      targetType: "settings",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

// Post-trial grace period: a lapsed trial's number is held for `days` before the hourly sweep releases it.
router.get(
  "/grace-period",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getGraceConfig());
  }),
);

router.put(
  "/grace-period",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { enabled, days } = z
      .object({ enabled: z.boolean(), days: z.number().int().min(1).max(90) })
      .parse(req.body);
    await prisma.platformSetting.upsert({
      where: { key: GRACE_ENABLED_KEY },
      update: { value: String(enabled), isSecret: false },
      create: { key: GRACE_ENABLED_KEY, value: String(enabled), isSecret: false },
    });
    await prisma.platformSetting.upsert({
      where: { key: GRACE_DAYS_KEY },
      update: { value: String(days), isSecret: false },
      create: { key: GRACE_DAYS_KEY, value: String(days), isSecret: false },
    });
    res.json({ enabled, days });
  }),
);

/* ----------------------------- Audit log --------------------------- */
router.get(
  "/audit",
  requirePermission("audit"),
  asyncHandler(async (req, res) => {
    const action = typeof req.query.action === "string" && req.query.action.trim() ? req.query.action.trim() : undefined;
    const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 25), 200);

    const parseDate = (v: unknown): Date | undefined => {
      if (typeof v !== "string" || !v.trim()) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    // A brand admin sees their OWN team's actions (actorBrandId is a column); platform people pass undefined and see everything.
    const scoped = tenantScope(req.user);
    const actorBrandId = scoped.brandId ?? undefined;

    const [result, actions] = await Promise.all([
      listAudit({ action, search, from, to, page, pageSize, actorBrandId }),
      listAuditActions(actorBrandId),
    ]);
    const brandIds = [...new Set(result.rows.map((r) => r.actorBrandId).filter((id): id is string => !!id))];
    const brands = brandIds.length
      ? await prisma.brand.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(brands.map((b) => [b.id, b.name]));
    res.json({
      ...result,
      rows: result.rows.map((r) => ({ ...r, actorBrandName: r.actorBrandId ? (nameOf.get(r.actorBrandId) ?? "") : "" })),
      actions,
    });
  }),
);

/* ----------------------- Webhook delivery logs --------------------- */
router.get(
  "/webhook-deliveries",
  requirePermission("webhooks"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const where =
      status === "success" ? { success: true } : status === "failed" ? { success: false } : undefined;

    // Deliveries live in each brand's database: a brand admin's own, or every
    // brand's for the platform — merged, newest first, cut to `limit`.
    const rows = (
      await Promise.all(
        (await tenantsFor(req.user?.brandId)).map(({ db }) =>
          db.webhookDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    res.json(
      rows.map((d) => ({
        id: d.id,
        provider: d.provider,
        url: d.url,
        status: d.status,
        success: d.success,
        responseBody: d.responseBody.slice(0, 1000),
        errorMessage: d.errorMessage,
        durationMs: d.durationMs,
        callLogId: d.callLogId,
        createdAt: d.createdAt,
      })),
    );
  }),
);

router.post(
  "/webhook-deliveries/:id/retry",
  requirePermission("webhooks"),
  asyncHandler(async (req, res) => {
    const result = await retryDelivery(req.params.id, req.user?.brandId);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "webhook.retry",
      targetType: "webhookDelivery",
      targetId: req.params.id,
      metadata: { success: result.success, status: result.status },
      ip: req.ip,
    });
    res.json(result);
  }),
);

/* --------------------------- System health ------------------------- */
router.get(
  "/system-health",
  requirePermission("health"),
  asyncHandler(async (req, res) => {
    const integrations = integrationsStatus();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Accounts and agents are in the brands' databases: one brand's for a
    // brand admin, every brand's for the platform's own people.
    const tenants = await tenantsFor(req.user?.brandId);
    const sumOver = async (count: (db: TenantClient) => Promise<number>) =>
      (await Promise.all(tenants.map(({ db }) => count(db)))).reduce((a, b) => a + b, 0);
    const [stats, totalUsers, totalCalls, callsLast24h, pendingApprovals, recentErrors] = await Promise.all([
      webhookStats(req.user?.brandId),
      sumOver((db) => db.user.count()),
      countCalls(req.user?.brandId),
      countCalls(req.user?.brandId, { createdAt: { gte: since } }),
      sumOver((db) => db.conversion.count({ where: { status: "pending" } })),
      // The delivery log is per brand: the newest failures across whichever
      // brands this admin can see.
      tenantsFor(req.user?.brandId).then((tenants) =>
        Promise.all(
          tenants.map(({ db }) =>
            db.webhookDelivery.findMany({
              where: { success: false },
              orderBy: { createdAt: "desc" },
              take: 10,
              select: { provider: true, errorMessage: true, status: true, createdAt: true },
            }),
          ),
        ).then((lists) =>
          lists
            .flat()
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 10),
        ),
      ),
    ]);

    res.json({
      integrations,
      webhooks: stats,
      counts: { totalUsers, totalCalls, callsLast24h, pendingApprovals },
      recentErrors,
    });
  }),
);

/* --------------------- Customer deep dive -------------------------- */
router.get(
  "/customers/:id/detail",
  requirePermission("customers"),
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const found = await db.user.findUnique({
      where: { id: req.params.id },
      include: { profile: true, conversion: true },
    });
    if (!found) throw notFound("Customer not found");
    if (isAdminTeamRole(found.role))
      throw badRequest("This endpoint is for customers only.");
    // The plan's name from the catalogue, and the newest calls from the
    // brand's call table — neither is a relation any more.
    const recentCalls = found.conversion
      ? await db.callLog.findMany({
          where: { conversionId: found.conversion.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            type: true,
            callerName: true,
            callerNumber: true,
            outcome: true,
            durationSec: true,
            createdAt: true,
          },
        })
      : [];
    const user = {
      ...found,
      brandId: req.user!.brandId!,
      profile: await withPlan(found.profile),
      conversion: found.conversion ? { ...found.conversion, callLogs: recentCalls } : null,
    };

    const detailLifecycle = deriveCustomerLifecycle(user.profile, await loadTrialCtx());

    const conv = user.conversion;
    // Every call, each rounded up to a full minute (matches the entitlement counter). Aggregated in Postgres, not Node.
    const [callsHandled, billedMinutes] = conv
      ? await Promise.all([
          countCalls(user.brandId, { conversionId: conv.id }),
          billedMinutesFor(db, conv.id),
        ])
      : [0, 0];

    res.json({
      customer: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        businessName: user.profile?.businessName ?? "",
        plan: user.profile?.plan ?? "free",
        numberActivated: user.profile?.numberActivated ?? false,
        mobile: user.profile?.mobile ?? "",
        website: user.profile?.website ?? "",
        subscriptionStatus: user.profile?.subscriptionStatus ?? "none",
        trialEndsAt: user.profile?.trialEndsAt ?? null,
        receptionistNumber: user.profile?.receptionistNumber ?? "",
        emailOptOutAt: user.emailOptOutAt ?? null,
        createdAt: user.createdAt,
      },
      agent: conv
        ? {
            name: (conv.agentConfig as unknown as AgentConfig)?.identity?.assistantName ?? "",
            status: conv.status,
            vapiAssistantId: conv.vapiAssistantId,
            agentConfig: conv.agentConfig,
          }
        : null,
      calls: conv?.callLogs ?? [],
      usage: {
        callsHandled: callsHandled,
        minutesUsed: billedMinutes,
      },
      billing: {
        plan: user.profile?.plan ?? "free",
        // The subscribed plan's display name ("Standard") — shown in preference to
        // the free/premium flag, which reads "Free" during a trial on a paid plan.
        planName: user.profile?.subscriptionPlan?.displayName ?? null,
        subscriptionStatus: user.profile?.subscriptionStatus ?? "none",
        // Same rule as the customer-list `onboarding` flag.
        onboarding: detailLifecycle.onboarding,
        // Completed onboarding, no plan, still inside the card-less free trial.
        freeTrial: detailLifecycle.freeTrial,
        // True only for an admin account lock (vs grace-lapsed billing suspension).
        suspended: !!user.profile?.suspendedAt,
        stripeCustomerId: user.profile?.stripeCustomerId ?? null,
        trialEndsAt: user.profile?.trialEndsAt ?? null,
        // The card rule THIS account signed up under — the only way support can explain two customers behaving differently.
        cardRequiredAtSignup: user.profile?.cardRequiredAtSignup ?? false,
        // When their first card landed; null = never. Paired with the flag above
        // it identifies a customer stuck at the card wall.
        cardConfirmedAt: user.profile?.cardConfirmedAt ?? null,
      },
    });
  }),
);

/* --------------------------- Scheduled reports --------------------- */
router.post(
  "/reports/send-digests",
  // Platform-wide broadcast: this emails EVERY customer of EVERY brand, so it
  // isn't something one brand's admin gets to trigger.
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const result = await sendDigests();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "reports.send-digests",
      targetType: "reports",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.get(
  "/reports/last-run",
  requirePermission("reports"),
  asyncHandler(async (_req, res) => {
    const lastRunAt = await getLastDigestRun();
    res.json({ lastRunAt });
  }),
);

router.get(
  "/reports/preview/:userId",
  requirePermission("reports"),
  asyncHandler(async (req, res) => {
    // A digest is call history in miniature — check the customer is inside the caller's tenant first. Platform people may preview anyone's.
    const target = req.user!.brandId
      ? await (await requestTenant(req)).user.findUnique({ where: { id: req.params.userId }, select: { id: true } })
      : await prisma.customerDirectory.findFirst({ where: { userId: req.params.userId }, select: { userId: true } });
    if (!target) throw notFound("No digest available for this user");
    const digest = await buildUserDigest(req.params.userId);
    if (!digest) throw notFound("No digest available for this user");
    res.json(digest);
  }),
);

/* ----------------------- Reseller commission payouts --------------------- */
router.get(
  "/commissions",
  requirePermission("resellers"),
  asyncHandler(async (req, res) => {
    // Commissions live in the brand DB — a brand admin sees their own, platform people every brand's.
    const tenants = await tenantsFor(req.user?.brandId);
    const commissions = (
      await Promise.all(
        tenants.map(async ({ brandId, db }) =>
          (
            await db.commission.findMany({
              orderBy: { createdAt: "desc" },
              include: {
                reseller: { select: { id: true, email: true, fullName: true } },
                customer: { select: { id: true, email: true, fullName: true } },
              },
            })
          ).map((c) => ({ ...c, brandId })),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json(commissions);
  }),
);

router.post(
  "/commissions/:id/pay",
  requirePermission("resellers", "edit"),
  asyncHandler(async (req, res) => {
    // Marking a commission paid is a payout decision: it stays the owning
    // brand's, which is the database it is found in.
    for (const { db } of await tenantsFor(req.user?.brandId)) {
      const existing = await db.commission.findUnique({ where: { id: req.params.id } });
      if (!existing) continue;
      const updated = await db.commission.update({ where: { id: req.params.id }, data: { status: "paid" } });
      res.json(updated);
      return;
    }
    throw notFound("Commission not found");
  }),
);

/* ----------------------------- Staff emails -------------------------------- */

/** Build a human-readable summary of permission keys (e.g. "Customers (View, Edit)"). */
function formatPermissionSummary(permissions: string[]): string {
  const grouped = new Map<string, string[]>();
  for (const p of permissions) {
    const [section, cap] = p.split(".");
    if (!section || !cap) continue;
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section)!.push(cap);
  }
  const lines: string[] = [];
  for (const s of SECTIONS) {
    const caps = grouped.get(s.key);
    if (!caps?.length) continue;
    const capLabels = caps.map((c) => CAPABILITY_LABELS[c as keyof typeof CAPABILITY_LABELS] ?? c);
    lines.push(`${s.label} (${capLabels.join(", ")})`);
  }
  return lines.length > 0 ? lines.join(", ") : "No permissions";
}

async function emailStaffWelcome(opts: {
  email: string;
  fullName: string;
  password: string;
  permissions: string[];
}): Promise<void> {
  if (!integrationsStatus().email) return;
  await sendTemplate("staff_welcome", opts.email, {
    user_name: opts.fullName,
    user_email: opts.email,
    password: opts.password,
    permissions: formatPermissionSummary(opts.permissions),
    login_url: brandAppUrl("/login"),
  });
}

async function emailStaffPermissionsUpdated(opts: {
  email: string;
  fullName: string;
  oldRole: string;
  newRole: string;
  permissions: string[];
}): Promise<void> {
  if (!integrationsStatus().email) return;
  await sendTemplate("staff_permissions_updated", opts.email, {
    user_name: opts.fullName,
    old_role: opts.oldRole,
    new_role: opts.newRole,
    permissions: formatPermissionSummary(opts.permissions),
    login_url: brandAppUrl("/login"),
  });
}

async function emailStaffAccessRevoked(opts: {
  email: string;
  fullName: string;
}): Promise<void> {
  if (!integrationsStatus().email) return;
  await sendTemplate("staff_access_revoked", opts.email, {
    user_name: opts.fullName,
  });
}

/** Notify one member that the ROLE they belong to had its permissions edited
 *  (the role itself is unchanged — its permission set changed). */
async function emailStaffRolePermissionsUpdated(opts: {
  email: string;
  fullName: string;
  roleName: string;
  permissions: string[];
}): Promise<void> {
  if (!integrationsStatus().email) return;
  await sendTemplate("staff_role_permissions_updated", opts.email, {
    user_name: opts.fullName,
    role_name: opts.roleName,
    permissions: formatPermissionSummary(opts.permissions),
    login_url: brandAppUrl("/login"),
  });
}

// Staff management. Full ADMINs only — STAFF cannot access these routes.

router.get(
  "/permissions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Mirror requirePermission so the matrix never OFFERS a box that would be refused when ticked. A brand admin
    // sees only brand sections, the platform only its own — never a brand's day-to-day.
    const hidden = req.user!.brandId
      ? new Set([...PLATFORM_TEAM_SECTIONS, ...PLATFORM_ONLY_SECTIONS])
      : BRAND_SCOPED_SECTIONS;
    res.json({
      sections: SECTIONS.filter((s) => !hidden.has(s.key)).map((s) => ({
        key: s.key,
        label: s.label,
        ...(s.hint ? { hint: s.hint } : {}),
        capabilities: [...s.capabilities],
        fields: (s.fields ?? []).map((f) => ({ key: f.key, label: f.label })),
      })),
      capabilities: CAPABILITIES.map((c) => ({ key: c, label: CAPABILITY_LABELS[c] })),
    });
  }),
);

/** A staff member's role, as the staff screens show it. */
interface RoleInfo {
  name: string;
  ticketDepartments: { id: string; name: string }[];
}

/** Roles named by staff rows, looked up (not joined) in the plane they live in — brand roles are in the brand DB. */
async function staffRolesFor(
  rows: { staffRoleId: string | null }[],
  brandId: string | null,
): Promise<Map<string, RoleInfo>> {
  const ids = [...new Set(rows.map((r) => r.staffRoleId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const db = await planeOf(brandId);
  const roles = await db.staffRole.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      ticketDepartments: { select: { id: true, name: true }, orderBy: { name: "asc" } },
    },
  });
  return new Map(roles.map((r) => [r.id, { name: r.name, ticketDepartments: r.ticketDepartments }]));
}

function serializeStaff(
  u: {
    id: string;
    email: string;
    fullName: string;
    permissions: string[];
    createdAt: Date;
    staffRoleId: string | null;
    ticketDepartments: { id: string; name: string }[];
  },
  role: RoleInfo | null,
) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    permissions: u.permissions,
    createdAt: u.createdAt,
    roleId: u.staffRoleId,
    roleName: role?.name ?? null,
    // Kept separate: roleDepartments is inherited and read-only here — merged, an admin could "untick" a grant this form can't revoke.
    departments: u.ticketDepartments,
    roleDepartments: role?.ticketDepartments ?? [],
  };
}

const staffSelect = {
  id: true,
  email: true,
  fullName: true,
  permissions: true,
  createdAt: true,
  staffRoleId: true,
  ticketDepartments: { select: { id: true, name: true }, orderBy: { name: "asc" } },
} as const;

/** Keeps only queue ids this admin may grant — scoped to their tenant so no cross-brand (or platform) grants. Stale ids are dropped, not fatal. */
async function validTicketDepartmentIds(
  db: TenantClient,
  ids: string[],
  brandId: string | null,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.ticketDepartment.findMany({
    where: {
      id: { in: ids },
      // Brand staff work the brand's queues; platform staff the platform inbox. Never the other's.
      lane: brandId ? "support" : "brand",
      brandId,
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

router.get(
  "/staff",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await (await planeOf(req.user!.brandId ?? null)).user.findMany({
      where: { role: "STAFF" },
      select: staffSelect,
      orderBy: { createdAt: "desc" },
    });
    const roles = await staffRolesFor(rows, req.user!.brandId ?? null);
    res.json(rows.map((u) => serializeStaff(u, u.staffRoleId ? (roles.get(u.staffRoleId) ?? null) : null)));
  }),
);

router.get(
  "/staff/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { id: req.params.id, role: "STAFF" },
      select: staffSelect,
    });
    if (!user) throw notFound("Staff member not found");
    const roles = await staffRolesFor([user], req.user!.brandId ?? null);
    res.json(serializeStaff(user, user.staffRoleId ? (roles.get(user.staffRoleId) ?? null) : null));
  }),
);

router.post(
  "/staff",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        email: z.string().email(),
        fullName: z.string().min(2),
        password: z
          .string()
          .min(8, "Password must be at least 8 characters")
          .regex(/[a-z]/, "Password must include a lowercase letter")
          .regex(/[A-Z]/, "Password must include an uppercase letter")
          .regex(/[^A-Za-z0-9]/, "Password must include a special character"),
        // A staff member is assigned a role (source of truth). `permissions` is
        // kept for backward-compat / custom one-off grants when no role is set.
        roleId: z.string().optional(),
        permissions: z.array(z.string()).default([]),
        // Support queues granted to this person directly, on top of whatever
        // their role holds. Effective access is the union of the two.
        ticketDepartmentIds: z.array(z.string()).max(200).default([]),
      })
      .parse(req.body);

    // The admin's own plane: a brand's staff in the brand's database, the
    // platform's in the control plane.
    const plane = await planeOf(req.user!.brandId ?? null);
    const existing = await plane.user.findUnique({ where: { email: data.email } });
    if (existing) throw new HttpError(409, "Email already registered");

    const { permissions: valid, staffRoleId } = await resolveStaffPermissions(
      data.roleId,
      data.permissions,
      req.user!.brandId ?? null,
    );

    // Staff join their creator's tenant. The super admin's staff are the platform team — the only other
    // account kind allowed no brand (migration 0057).
    const brandId = req.user!.brandId ?? null;
    const departmentIds = await validTicketDepartmentIds(
      await planeOf(brandId),
      data.ticketDepartmentIds,
      brandId,
    );
    const passwordHash = await hashPassword(data.password);
    const staff = await plane.user.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        passwordHash,
        role: "STAFF",
        permissions: valid,
        staffRoleId,
        ticketDepartments: { connect: departmentIds.map((id) => ({ id })) },
      },
      select: staffSelect,
    });

    void emailStaffWelcome({
      email: data.email,
      fullName: data.fullName,
      password: data.password,
      permissions: valid,
    }).catch(() => {});

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "staff.create",
      targetType: "user",
      targetId: staff.id,
      metadata: { email: staff.email, permissions: valid },
      ip: req.ip,
    });

    const roles = await staffRolesFor([staff], brandId);
    res.status(201).json(serializeStaff(staff, staff.staffRoleId ? (roles.get(staff.staffRoleId) ?? null) : null));
  }),
);

router.patch(
  "/staff/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fullName: z.string().min(1).optional(),
        // `roleId: null` clears the role (custom/no permissions). Omit to leave
        // the current role untouched.
        roleId: z.string().nullable().optional(),
        permissions: z.array(z.string()).optional(),
        // Omit to leave the personal grants untouched; send the full list
        // (possibly empty) to replace them.
        ticketDepartmentIds: z.array(z.string()).max(200).optional(),
      })
      .parse(req.body);

    const exists = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { id: req.params.id, role: "STAFF" },
      // Capture the role BEFORE the update so the notification email can show the
      // "from <old> to <new>" transition.
      select: { id: true, staffRoleId: true },
    });
    if (!exists) throw notFound("Staff member not found");

    const update: {
      fullName?: string;
      permissions?: string[];
      staffRoleId?: string | null;
      ticketDepartments?: { set: { id: string }[] };
    } = {};
    if (data.fullName) update.fullName = data.fullName;
    if (data.ticketDepartmentIds) {
      // `set`, not `connect` — the form posts the whole list, so unticking one
      // has to actually revoke it.
      const departmentIds = await validTicketDepartmentIds(
        await planeOf(req.user!.brandId),
        data.ticketDepartmentIds,
        req.user!.brandId ?? null,
      );
      update.ticketDepartments = { set: departmentIds.map((id) => ({ id })) };
    }
    // Role assignment wins: when a role is (re)assigned, its permissions become
    // the staff member's effective permissions.
    if (data.roleId !== undefined) {
      const resolved = await resolveStaffPermissions(
        data.roleId ?? undefined,
        data.permissions,
        req.user!.brandId ?? null,
      );
      update.staffRoleId = resolved.staffRoleId;
      update.permissions = resolved.permissions;
    } else if (data.permissions) {
      // Custom permission edit with no role — detach from any role.
      update.permissions = scopePermissionsToTenant(
        data.permissions.filter((p) => ALL_PERMISSION_KEYS.includes(p)),
        req.user!.brandId ?? null,
      );
      update.staffRoleId = null;
    }

    const updated = await (await planeOf(req.user!.brandId ?? null)).user.update({
      where: { id: req.params.id },
      data: update,
      select: staffSelect,
    });
    // Their next request must see the new grants, not the copy cached a few
    // seconds ago.
    if (data.ticketDepartmentIds) forgetDepartmentScopes();

    const roles = await staffRolesFor([exists, updated], req.user!.brandId ?? null);
    const roleName = (id: string | null) => (id ? (roles.get(id)?.name ?? null) : null);
    if (update.permissions) {
      // A staff member with no assigned role runs on custom permissions — label
      // both sides so the email reads sensibly in every case.
      void emailStaffPermissionsUpdated({
        email: updated.email,
        fullName: updated.fullName,
        oldRole: roleName(exists.staffRoleId) ?? "Custom permissions",
        newRole: roleName(updated.staffRoleId) ?? "Custom permissions",
        permissions: updated.permissions,
      }).catch(() => {});
    }

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "staff.update",
      targetType: "user",
      targetId: req.params.id,
      metadata: update,
      ip: req.ip,
    });

    res.json(serializeStaff(updated, updated.staffRoleId ? (roles.get(updated.staffRoleId) ?? null) : null));
  }),
);

router.delete(
  "/staff/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exists = await (await planeOf(req.user!.brandId ?? null)).user.findFirst({
      where: { id: req.params.id, role: "STAFF" },
      select: { email: true, fullName: true },
    });
    if (!exists) throw notFound("Staff member not found");

    await (await planeOf(req.user!.brandId ?? null)).user.delete({ where: { id: req.params.id } });

    void emailStaffAccessRevoked({
      email: exists.email,
      fullName: exists.fullName,
    }).catch(() => {});

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "staff.delete",
      targetType: "user",
      targetId: req.params.id,
      ip: req.ip,
    });

    res.json({ ok: true });
  }),
);

// Staff roles (RBAC). Editing a role re-syncs every member's denormalized `permissions`. Full ADMINs only.

/** Effective permissions: the role's when roleId is given, else the explicit (custom) list. */
async function resolveStaffPermissions(
  roleId: string | undefined,
  explicit: string[] | undefined,
  /** The creating admin's brand — null for the platform's own staff. Decides
   *  which side of the support ladder the keys may name. */
  brandId: string | null,
): Promise<{ permissions: string[]; staffRoleId: string | null }> {
  const scoped = (keys: string[]) =>
    scopePermissionsToTenant(keys.filter((p) => ALL_PERMISSION_KEYS.includes(p)), brandId);
  if (roleId) {
    // The role lives in the admin's own plane: a brand's roles in its database,
    // the platform's in the control plane.
    const role = await (await planeOf(brandId)).staffRole.findUnique({
      where: { id: roleId },
      select: { permissions: true },
    });
    if (!role) throw notFound("Role not found");
    return { permissions: scoped(role.permissions), staffRoleId: roleId };
  }
  return { permissions: scoped(explicit ?? []), staffRoleId: null };
}

function serializeRole(
  r: {
    id: string;
    name: string;
    description: string;
    permissions: string[];
    createdAt: Date;
    ticketDepartments?: { id: string; name: string }[];
  },
  memberCount: number,
) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    memberCount,
    // Which support queues this role works. Holding `tickets.*` says what the
    // role may DO; these say which tickets it may do it to.
    departments: r.ticketDepartments ?? [],
    createdAt: r.createdAt,
  };
}

/** Shared include for every role read and write, so all of them return the
 *  same shape and the departments block never silently disappears. */
const roleInclude = {
  ticketDepartments: { select: { id: true, name: true }, orderBy: { name: "asc" } },
} as const;

/** Staff per role, counted where the roles live (brand staff are mirrored into the brand DB with their role id). */
async function roleMemberCounts(db: TenantClient, roleIds: string[]): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map();
  const rows = await db.user.groupBy({
    by: ["staffRoleId"],
    where: { staffRoleId: { in: roleIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.staffRoleId as string, r._count._all]));
}

router.get(
  "/roles",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Roles live in the admin's own plane (phase 4): a brand's in its own
    // database, the platform's in the control plane.
    const db = await planeOf(req.user!.brandId);
    const rows = await db.staffRole.findMany({
      orderBy: { name: "asc" },
      include: roleInclude,
    });
    const counts = await roleMemberCounts(
      db,
      rows.map((r) => r.id),
    );
    res.json(rows.map((r) => serializeRole(r, counts.get(r.id) ?? 0)));
  }),
);

router.get(
  "/roles/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = await planeOf(req.user!.brandId);
    const role = await db.staffRole.findUnique({
      where: { id: req.params.id },
      include: roleInclude,
    });
    if (!role) throw notFound("Role not found");
    res.json(serializeRole(role, (await roleMemberCounts(db, [role.id])).get(role.id) ?? 0));
  }),
);

router.post(
  "/roles",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(2, "Role title must be at least 2 characters").max(60),
        description: z.string().max(200).optional(),
        permissions: z.array(z.string()).default([]),
        departmentIds: z.array(z.string()).max(200).default([]),
      })
      .parse(req.body);

    const db = await planeOf(req.user!.brandId);
    const dup = await db.staffRole.findUnique({ where: { name: data.name } });
    if (dup) throw new HttpError(409, "A role with that name already exists");

    const valid = scopePermissionsToTenant(
      data.permissions.filter((p) => ALL_PERMISSION_KEYS.includes(p)),
      req.user!.brandId ?? null,
    );
    const departmentIds = await validTicketDepartmentIds(db, data.departmentIds, req.user!.brandId ?? null);
    const role = await db.staffRole.create({
      data: {
        name: data.name,
        description: data.description ?? "",
        permissions: valid,
        ticketDepartments: { connect: departmentIds.map((id) => ({ id })) },
      },
      include: roleInclude,
    });
    if (departmentIds.length > 0) forgetDepartmentScopes();

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "role.create",
      targetType: "staffRole",
      targetId: role.id,
      metadata: { name: role.name, permissions: valid, departmentIds },
      ip: req.ip,
    });

    res.status(201).json(serializeRole(role, 0));
  }),
);

router.patch(
  "/roles/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(2).max(60).optional(),
        description: z.string().max(200).optional(),
        permissions: z.array(z.string()).optional(),
        departmentIds: z.array(z.string()).max(200).optional(),
      })
      .parse(req.body);

    const db = await planeOf(req.user!.brandId);
    const exists = await db.staffRole.findUnique({ where: { id: req.params.id } });
    if (!exists) throw notFound("Role not found");

    if (data.name && data.name !== exists.name) {
      const dup = await db.staffRole.findUnique({ where: { name: data.name } });
      if (dup) throw new HttpError(409, "A role with that name already exists");
    }

    const update: {
      name?: string;
      description?: string;
      permissions?: string[];
      ticketDepartments?: { set: { id: string }[] };
    } = {};
    if (data.name) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    // Held separately from `update` so the member re-sync below has a plain
    // string[] to write, not Prisma's list-update shape.
    const nextPermissions = data.permissions
      ? scopePermissionsToTenant(
          data.permissions.filter((p) => ALL_PERMISSION_KEYS.includes(p)),
          req.user!.brandId ?? null,
        )
      : undefined;
    if (nextPermissions) update.permissions = nextPermissions;
    if (data.departmentIds) {
      // `set`, not `connect`, so unticking a department actually revokes it —
      // this is the line that takes a staff member off a ticket queue.
      const departmentIds = await validTicketDepartmentIds(db, data.departmentIds, req.user!.brandId ?? null);
      update.ticketDepartments = { set: departmentIds.map((id) => ({ id })) };
    }

    const role = await db.staffRole.update({
      where: { id: req.params.id },
      data: update,
      include: roleInclude,
    });
    // Every member's cached grants came from this role — none may outlive the edit.
    if (data.departmentIds) forgetDepartmentScopes();

    // Re-sync every member's denormalized permissions so an edit to the role
    // propagates to all assigned staff immediately.
    if (nextPermissions) {
      const perms = nextPermissions;
      await (await planeOf(req.user!.brandId ?? null)).user.updateMany({
        where: { staffRoleId: role.id },
        data: { permissions: perms },
      });

      // Notify every affected member that their role's permissions changed.
      // Fire-and-forget so a slow/broken mailer never fails the role save.
      const members = await (await planeOf(req.user!.brandId ?? null)).user.findMany({
        where: { staffRoleId: role.id },
        select: { email: true, fullName: true },
      });
      for (const m of members) {
        void emailStaffRolePermissionsUpdated({
          email: m.email,
          fullName: m.fullName,
          roleName: role.name,
          permissions: perms,
        }).catch(() => {});
      }
    }

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "role.update",
      targetType: "staffRole",
      targetId: role.id,
      metadata: update,
      ip: req.ip,
    });

    res.json(serializeRole(role, (await roleMemberCounts(db, [role.id])).get(role.id) ?? 0));
  }),
);

router.delete(
  "/roles/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = await planeOf(req.user!.brandId);
    const role = await db.staffRole.findUnique({
      where: { id: req.params.id },
      include: roleInclude,
    });
    if (!role) throw notFound("Role not found");
    const members = (await roleMemberCounts(db, [role.id])).get(role.id) ?? 0;
    if (members > 0) {
      throw new HttpError(
        409,
        `This role is assigned to ${members} staff member${
          members === 1 ? "" : "s"
        }. Reassign them before deleting it.`,
      );
    }

    await db.staffRole.delete({ where: { id: req.params.id } });

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "role.delete",
      targetType: "staffRole",
      targetId: req.params.id,
      metadata: { name: role.name },
      ip: req.ip,
    });

    res.json({ ok: true });
  }),
);

// System email templates. Subject/body/enabled per template; header/footer/from-name are branding-wide.

/** Representative sample values so admins can preview/test any template. */
function sampleEmailVars(recipient: string): Record<string, string> {
  return {
    user_name: "Sanant",
    user_email: recipient,
    code: "123456",
    expiry_minutes: "10",
    number: "+1 (555) 010-0100",
    number_plain: "+15550100100",
    business_suffix: " for Acme Plumbing",
    trial_minutes: "60",
    trial_days: "14",
    grace_days: "7",
    grace_until: "Jul 15, 2026",
    days_remaining: "3",
    window: "3 days",
    plan_name: "Premium",
    included_minutes: "Unlimited minutes",
    number_line: "AI number: +15550100100\n",
    renewal_line: "Renews: Aug 1, 2026",
    threshold: "80",
    lead: "You've used 80% of your plan call minutes.",
    minutes_used: "48",
    minutes_allocated: "60",
    minutes_remaining: "12",
    cta: "Top up or upgrade your plan to keep your AI receptionist answering.",
    caller_name: "John Carter",
    summary_block: "AI summary\nCaller asked about weekend availability and left a callback number.",
    recording_block: "Recording: https://app.hello22.ai/recording/sample",
    transcript_block: "Transcript\nAI: Thanks for calling. How can I help?\nCaller: I'd like to book a job.",
    password: "Temp1234!",
    permissions: "Customers (View, Edit), Calls (View)",
    login_url: brandAppUrl("/login"),
    forwarding_url: brandAppUrl("/dashboard/settings"),
    reason: "Reason: repeated policy violations",
  };
}

router.get(
  "/emails",
  requirePermission("emails", "view"),
  asyncHandler(async (_req, res) => {
    const templates = await prisma.emailTemplate.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    const branding = await getEmailBranding();
    res.json({ templates, branding });
  }),
);

router.patch(
  "/emails/:key",
  requirePermission("emails", "edit"),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        subject: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const existing = await prisma.emailTemplate.findUnique({ where: { key: req.params.key } });
    if (!existing) throw notFound("Email template not found");

    const updated = await prisma.emailTemplate.update({
      where: { key: req.params.key },
      data: {
        ...(data.subject !== undefined ? { subject: data.subject } : {}),
        ...(data.body !== undefined ? { body: data.body } : {}),
        // alwaysOn templates (verification codes) can never be disabled.
        ...(data.enabled !== undefined && !existing.alwaysOn ? { enabled: data.enabled } : {}),
      },
    });
    res.json(updated);
  }),
);

router.put(
  "/email-branding",
  requirePermission("emails", "edit"),
  asyncHandler(async (req, res) => {
    const patch = z
      .object({
        header: z.string().optional(),
        footer: z.string().optional(),
        fromName: z.string().optional(),
      })
      .parse(req.body ?? {});
    await setEmailBranding(patch);
    res.json(await getEmailBranding());
  }),
);

/** Preview a template rendered with sample data (no email sent). */
router.get(
  "/emails/:key/preview",
  requirePermission("emails", "view"),
  asyncHandler(async (req, res) => {
    // Show the unsubscribe footer on notification templates so admins can see it
    // in the preview (sample link — no real opt-out token).
    const unsubscribeUrl = isUnsubscribable(req.params.key)
      ? `${publicApiBaseUrl}/api/unsubscribe?token=sample`
      : undefined;
    const rendered = await renderEmail(req.params.key, sampleEmailVars(req.user!.email), { unsubscribeUrl });
    if (!rendered) throw notFound("Email template not found");
    res.json(rendered);
  }),
);

/** Send a test copy of a template (sample data) to the admin or a chosen address. */
router.post(
  "/emails/:key/test",
  requirePermission("emails", "edit"),
  asyncHandler(async (req, res) => {
    const { to } = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
    const recipient = to?.trim() || req.user!.email;
    const unsubscribeUrl = isUnsubscribable(req.params.key)
      ? `${publicApiBaseUrl}/api/unsubscribe?token=sample`
      : undefined;
    const rendered = await renderEmail(req.params.key, sampleEmailVars(recipient), { unsubscribeUrl });
    if (!rendered) throw notFound("Email template not found");
    try {
      await sendEmail({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      res.json({ success: true, to: recipient });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : "Failed to send test email");
    }
  }),
);

export default router;
