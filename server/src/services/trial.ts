import { tenantForUser, type TenantClient } from "./tenantDb.js";
import { withPlan } from "./planLookup.js";
import { getTrialDays, getTrialMinutes } from "./billing.js";
import {
  endTrialNow,
  getSubscription,
  getSubscriptionAutoRenew,
  setSubscriptionAutoRenew,
  getLatestPaidInvoice,
  renewSubscriptionNow,
  isStripeConfigured,
} from "./stripe.js";
import { badRequest } from "../lib/http.js";
import { formatDateDMY } from "../lib/date.js";
import { MAX_DEPARTMENTS, transferDepartmentAllowance } from "../lib/transfer.js";
import { integrationsStatus } from "./settings.js";
import { applyCallDurationCap, getCallDurationCapSetting } from "./callDurationCap.js";
import { planActivatedEmail, usageThresholdEmail } from "./email.js";
import { notify } from "./notifications.js";
import { accrueCommissionForInvoice } from "./commission.js";
import { recordPaidInvoice } from "./platformLedger.js";
import { recordPlanEvent } from "./planHistory.js";
import { consumeCycle, effectiveIncludedMinutes, healDiscountDrift } from "./coupons.js";
import { isAdminRole } from "../lib/roles.js";

/** Tells the user their trial converted to a paid plan. Only on the trial->active transition, not renewals. Best-effort. */
export async function notifyPlanActivated(
  userId: string,
  opts: { number?: string } = {},
): Promise<void> {
  try {
    const profile = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
      where: { userId },
      select: {
        currentPeriodEnd: true,
        receptionistNumber: true,
        subscriptionPlanId: true, 
        user: { select: { email: true, fullName: true } } } }));
    if (!profile?.user?.email) return;

    void notify(userId, {
      type: "billing",
      title: "Your plan is now active 🎉",
      message: "Your free trial ended and your paid plan is now active.",
      link: "/dashboard/settings",
    });

    if (!integrationsStatus().email) return;
    await planActivatedEmail({
      ownerEmail: profile.user.email,
      fullName: profile.user.fullName,
      planName: profile.subscriptionPlan?.displayName ?? "subscription",
      includedMinutes: profile.subscriptionPlan?.includedMinutes ?? 0,
      // Prefer the number being assigned in this go-live flow (passed in before the
      // profile row is updated); fall back to the stored one for other callers.
      number: (opts.number ?? profile.receptionistNumber) || undefined,
      renewalDate: formatDateDMY(profile.currentPeriodEnd) || undefined,
    });
  } catch {
    /* best-effort — never block activation on the email */
  }
}

// Entitlement: the single source of truth for whether a user can make AI calls and how
// many minutes are left. A trial ends on minutes OR date (minutes wins); a plan blocks on minutes.

export type TrialStatus = "active" | "expired_minutes" | "expired_date";

export const TRIAL_STATUS = {
  ACTIVE: "active",
  EXPIRED_BY_MINUTES: "expired_minutes",
  EXPIRED_BY_DATE: "expired_date",
} as const;

export type EntitlementPhase = "trial" | "active" | "none";
export type EntitlementStatus =
  | "active"
  | "expired_minutes"
  | "expired_date"
  | "past_due"
  | "no_subscription";

/** API error codes + user-facing messages for blocked states. */
export const ENTITLEMENT_ERRORS: Record<
  Exclude<EntitlementStatus, "active">,
  { code: string; message: string }
> = {
  expired_minutes: {
    code: "TRIAL_EXPIRED_MINUTES",
    message: "Your free trial has ended because all trial minutes have been used.",
  },
  expired_date: {
    code: "TRIAL_EXPIRED_DATE",
    message: "Your free trial has ended because the trial period has expired.",
  },
  past_due: {
    code: "SUBSCRIPTION_PAST_DUE",
    message: "Your last payment failed. Update your card to keep using AI calls.",
  },
  no_subscription: {
    code: "NO_SUBSCRIPTION",
    message: "Choose a plan to start using AI calls.",
  },
};

/** Plan-minutes-exhausted is its own message (the trial code wouldn't fit). */
const PLAN_EXHAUSTED_ERROR = {
  code: "PLAN_MINUTES_EXHAUSTED",
  message: "You've used all the call minutes included in your plan for this billing period.",
};

/** Paid plan whose billing period ended without renewing (auto-renew off) — expired
 *  by date even if minutes remained. The trial "expired_date" copy wouldn't fit. */
const PLAN_EXPIRED_ERROR = {
  code: "PLAN_EXPIRED",
  message: "Your plan's billing period has ended. Renew your plan to keep using AI calls.",
};

export interface TrialEvaluationInput {
  minutesUsed: number;
  minutesAllocated: number;
  endsAt: Date | null;
  now: Date;
}

/** Pure trial status calc — minutes exhaustion wins when both limits hit. */
export function evaluateTrialStatus(input: TrialEvaluationInput): TrialStatus {
  const { minutesUsed, minutesAllocated, endsAt, now } = input;
  if (minutesUsed >= minutesAllocated) return TRIAL_STATUS.EXPIRED_BY_MINUTES;
  if (endsAt && now.getTime() >= endsAt.getTime()) return TRIAL_STATUS.EXPIRED_BY_DATE;
  return TRIAL_STATUS.ACTIVE;
}

/** Whole days left until a date (0 once reached). */
export function daysRemaining(endsAt: Date | null, now: Date): number {
  if (!endsAt) return 0;
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Minutes left in a quota, never negative, rounded to one decimal. */
export function minutesRemaining(minutesUsed: number, minutesAllocated: number): number {
  return Math.max(0, Math.round((minutesAllocated - minutesUsed) * 10) / 10);
}

export interface EntitlementState {
  phase: EntitlementPhase;
  status: EntitlementStatus;
  isTrial: boolean;
  unlimited: boolean;
  /** Call minutes available this cycle (the plan/trial allowance). */
  minutesAllocated: number;
  minutesUsed: number;
  minutesRemaining: number;
  /** Same as minutesAllocated — kept for the dashboard usage gauge. */
  planMinutes: number;
  daysRemaining: number;
  /** Admin-configured total trial length (the "you get N days" allowance), not a
   *  countdown. 0 when the user isn't on a trial. */
  trialDays: number;
  trialEndsAt: string | null;
  periodEnd: string | null;
  blocked: boolean;
  /** Has a paid plan to renew now (vs picking one fresh). Drives the "Renew plan" CTA. */
  canRenew: boolean;
  /** Auto-charges on exhaustion. With this ON a live call isn't hard-cut at the remaining minutes. */
  autoRenew: boolean;
  /** Human-readable plan label for the dashboard badge ("Free Trial", "Starter", …). */
  planName: string | null;
  /** Post-trial grace window: the user is blocked but their number is still held
   *  (not yet released) until graceEndsAt. Drives the "keep your number" banner. */
  graceActive: boolean;
  graceEndsAt: string | null;
  graceDaysRemaining: number;
  /** Account fully suspended (grace lapsed without renewal): number released and
   *  the whole dashboard is locked behind the reactivation (pick-a-plan) screen. */
  suspended: boolean;
  /** Admin hard-lock. Unlike `suspended` (billing lapse, self-recoverable), only an admin can lift it. */
  adminSuspended: boolean;
}

type EntitlementProfile = {
  subscriptionStatus: string;
  /** Whether a card was required when THIS account signed up. false (the default,
   *  and every pre-existing row) means the card-less free trial applies. */
  cardRequiredAtSignup: boolean;
  /** When the first card was confirmed; null = none ever has been. */
  cardConfirmedAt: Date | null;
  suspendedAt: Date | null;
  createdAt: Date;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialMinutesAllocated: number | null;
  trialSecondsUsed: number;
  planMinutesAllocated: number | null;
  planSecondsUsed: number;
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  graceStartedAt: Date | null;
  graceEndsAt: Date | null;
  graceConsumedAt: Date | null;
  subscriptionPlan: {
    includedMinutes: number;
    displayName: string;
  } | null;
  user: { role: string } | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

// Admins aren't customers but need the AI to support the product: always-on, unlimited.
function adminEntitlement(): EntitlementState {
  return {
    phase: "active",
    status: "active",
    isTrial: false,
    unlimited: true,
    minutesAllocated: 0,
    minutesUsed: 0,
    minutesRemaining: 0,
    planMinutes: 0,
    daysRemaining: 0,
    trialDays: 0,
    trialEndsAt: null,
    periodEnd: null,
    blocked: false,
    canRenew: false,
    autoRenew: true,
    planName: "Admin",
    graceActive: false,
    graceEndsAt: null,
    graceDaysRemaining: 0,
    suspended: false,
    adminSuspended: false,
  };
}

/** The user's live entitlement, resolved from the profile and its plan. */
export async function getEntitlement(userId: string, now = new Date()): Promise<EntitlementState> {
  const profile = (await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: {
      subscriptionStatus: true,
      cardRequiredAtSignup: true,
      cardConfirmedAt: true,
      suspendedAt: true,
      createdAt: true,
      trialStartedAt: true,
      trialEndsAt: true,
      trialMinutesAllocated: true,
      trialSecondsUsed: true,
      planMinutesAllocated: true,
      planSecondsUsed: true,
      currentPeriodEnd: true,
      autoRenew: true,
      graceStartedAt: true,
      graceEndsAt: true,
      graceConsumedAt: true,
      subscriptionPlanId: true, 
      user: { select: { role: true } } } }))) as EntitlementProfile | null;

  if (isAdminRole(profile?.user?.role)) return adminEntitlement();

  const sub = profile?.subscriptionStatus ?? "none";

  const graceActive =
    !!profile?.graceEndsAt && !profile.graceConsumedAt && now.getTime() < profile.graceEndsAt.getTime();
  const grace = {
    graceActive,
    graceEndsAt: graceActive ? profile!.graceEndsAt!.toISOString() : null,
    graceDaysRemaining: graceActive ? daysRemaining(profile!.graceEndsAt, now) : 0,
    suspended: sub === "suspended",
    adminSuspended: !!profile?.suspendedAt,
  };

  // THE CARD WALL: a card-required signup has no entitlement until its card is confirmed,
  // whatever subscriptionStatus says — Stripe writes "trialing" before any card exists, so
  // a status-keyed wall would hand out free trials. Keyed on the row's own flags only.
  if (profile && profile.cardRequiredAtSignup && !profile.cardConfirmedAt) {
    return {
      phase: "none",
      status: "no_subscription",
      isTrial: false,
      unlimited: false,
      minutesAllocated: 0,
      minutesUsed: 0,
      minutesRemaining: 0,
      planMinutes: 0,
      daysRemaining: 0,
      trialDays: 0,
      trialEndsAt: null,
      periodEnd: null,
      blocked: true,
      // Nothing to renew — they have never had a plan. They must add a card.
      canRenew: false,
      autoRenew: false,
      planName: null,
      ...grace,
    };
  }

  if (profile && sub === "trialing") {
    const planMinutes = profile.trialMinutesAllocated ?? (await getTrialMinutes());
    const trialDays = await getTrialDays();
    const minutesAllocated = planMinutes;
    const minutesUsed = round1(profile.trialSecondsUsed / 60);
    const status = evaluateTrialStatus({
      minutesUsed,
      minutesAllocated,
      endsAt: profile.trialEndsAt,
      now,
    });
    return {
      phase: "trial",
      status,
      isTrial: true,
      unlimited: false,
      minutesAllocated,
      minutesUsed,
      minutesRemaining: minutesRemaining(minutesUsed, minutesAllocated),
      planMinutes,
      daysRemaining: daysRemaining(profile.trialEndsAt, now),
      trialDays,
      trialEndsAt: profile.trialEndsAt?.toISOString() ?? null,
      periodEnd: null,
      blocked: status !== TRIAL_STATUS.ACTIVE,
      // A blocked trial (auto-renew off, or not yet auto-converted) → the user can
      // renew now: end the trial + charge the saved card to start the paid plan.
      canRenew: status !== TRIAL_STATUS.ACTIVE,
      autoRenew: profile.autoRenew,
      planName: profile.subscriptionPlan?.displayName ?? "Free Trial",
      ...grace,
    };
  }

  if (profile && sub === "active") {
    const planMinutes = profile.planMinutesAllocated ?? profile.subscriptionPlan?.includedMinutes ?? 0;
    const unlimited = planMinutes <= 0;
    const minutesAllocated = planMinutes;
    const rawUsed = round1(profile.planSecondsUsed / 60);

    const exhausted = !unlimited && rawUsed >= minutesAllocated;
    // Auto-renew OFF + period ended = expired even with minutes left (the plan was sold
    // for one period). Auto-renew ON is excluded — a past period end there is webhook lag.
    const periodEnded =
      !!profile.currentPeriodEnd && now.getTime() >= profile.currentPeriodEnd.getTime();
    const dateExpired = periodEnded && !profile.autoRenew;
    // An exhausted auto-renew plan isn't really blocked — show the projected post-renewal
    // numbers so the dashboard doesn't flicker to "6/5, calls paused" mid-renewal.
    const willAutoRenew = exhausted && profile.autoRenew;
    const minutesUsed = willAutoRenew
      ? Math.min(round1(rawUsed - minutesAllocated), Math.max(0, minutesAllocated - 1))
      : rawUsed;
    // Either limit blocks the plan. Minutes-exhaustion keeps its own code/message;
    // a pure date expiry (minutes left but the paid month is over) reports expired_date.
    const status: EntitlementStatus =
      exhausted && !willAutoRenew ? "expired_minutes" : dateExpired ? "expired_date" : "active";
    return {
      phase: "active",
      status,
      isTrial: false,
      unlimited,
      minutesAllocated,
      minutesUsed,
      minutesRemaining: unlimited ? 0 : minutesRemaining(minutesUsed, minutesAllocated),
      planMinutes,
      daysRemaining: daysRemaining(profile.currentPeriodEnd, now),
      trialDays: 0,
      trialEndsAt: null,
      periodEnd: profile.currentPeriodEnd?.toISOString() ?? null,
      blocked: status !== "active",
      // Active plan that's blocked (minutes used up, auto-renew off) → renewable now.
      canRenew: status !== "active",
      autoRenew: profile.autoRenew,
      planName: profile.subscriptionPlan?.displayName ?? "Plan",
      ...grace,
    };
  }

  // Never subscribed = card-less free trial from account creation, same limits as the paid trial.
  // The platform toggle is never read here, so flipping it can't change the answer for existing signups.
  if (profile && sub === "none") {
    const minutesAllocated = await getTrialMinutes();
    const trialDays = await getTrialDays();
    const startedAt = profile.trialStartedAt ?? profile.createdAt ?? now;
    const endsAt = new Date(startedAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
    const minutesUsed = round1(profile.trialSecondsUsed / 60);
    const status = evaluateTrialStatus({ minutesUsed, minutesAllocated, endsAt, now });
    return {
      phase: "trial",
      status,
      isTrial: true,
      unlimited: false,
      minutesAllocated,
      minutesUsed,
      minutesRemaining: minutesRemaining(minutesUsed, minutesAllocated),
      planMinutes: minutesAllocated,
      daysRemaining: daysRemaining(endsAt, now),
      trialDays,
      trialEndsAt: endsAt.toISOString(),
      periodEnd: null,
      blocked: status !== TRIAL_STATUS.ACTIVE,
      // No plan to "renew" — they start one via the number wizard / plans page.
      canRenew: false,
      // No card = can never auto-renew, so force false or the per-call cap grants
      // headroom and a call overshoots the allowance.
      autoRenew: false,
      planName: "Free Trial",
      ...grace,
    };
  }

  const status: EntitlementStatus = sub === "past_due" ? "past_due" : "no_subscription";
  return {
    phase: sub === "past_due" ? "active" : "none",
    status,
    isTrial: false,
    unlimited: false,
    minutesAllocated: 0,
    minutesUsed: 0,
    minutesRemaining: 0,
    planMinutes: 0,
    daysRemaining: 0,
    trialDays: 0,
    trialEndsAt: null,
    periodEnd: profile?.currentPeriodEnd?.toISOString() ?? null,
    blocked: true,
    // past_due = card failed on an existing plan → renewable. none/canceled =
    // no plan to renew → must pick one (/subscribe).
    canRenew: sub === "past_due",
    autoRenew: profile?.autoRenew ?? false,
    planName: sub === "past_due" ? "Past due" : null,
    ...grace,
  };
}

/** Per-plan feature entitlements (real gates, not marketing bullets). */
export interface PlanFeatures {
  sms: boolean;
  /** "SMS to Caller" — the AI texts a caller details they ask for mid-call.
   *  Separate from `sms` (owner summaries) so the two can be sold apart. */
  smsToCaller: boolean;
  whatsapp: boolean;
  customCrm: boolean;
  multilingual: boolean;
  /** Transfer departments allowed; 0 = no transfer. Pre-resolved because in the raw enabled/limit pair 0 means "unlimited" or "off" depending on the flag. */
  callTransferDepartments: number;
}

const ALL_FEATURES: PlanFeatures = {
  sms: true,
  smsToCaller: true,
  whatsapp: true,
  customCrm: true,
  multilingual: true,
  callTransferDepartments: MAX_DEPARTMENTS,
};

const NO_FEATURES: PlanFeatures = {
  sms: false,
  smsToCaller: false,
  whatsapp: false,
  customCrm: false,
  multilingual: false,
  callTransferDepartments: 0,
};

/** Add-on features the plan grants now. Gated on PAYMENT, not on going live: trial is wide open, and a lapsed sub is still judged by its plan (nobody gains features by not paying). */
export async function getPlanFeatures(userId: string): Promise<PlanFeatures> {
  const profile = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: {
      subscriptionStatus: true,
      cardRequiredAtSignup: true,
      cardConfirmedAt: true,
      user: { select: { role: true } },
      subscriptionPlanId: true } }));
  if (isAdminRole(profile?.user?.role)) return ALL_FEATURES;
  // Trial (even card-required, card pending) is wide open: features are a PLAN concern.
  // The card wall lives in getEntitlement, never in quietly stripped features here.
  const status = profile?.subscriptionStatus ?? "none";
  if (status === "none" || status === "trialing") {
    return {
      ...ALL_FEATURES,
      // Counts are the exception: departments are real state, and 20 unlocked on a
      // 2-department plan get orphaned at conversion. So the trial previews the plan's count.
      callTransferDepartments: profile?.subscriptionPlan
        ? transferDepartmentAllowance(profile.subscriptionPlan)
        : MAX_DEPARTMENTS,
    };
  }
  // Paid (or previously paid): the plan decides, effective immediately.
  if (!profile?.subscriptionPlan) return NO_FEATURES;
  return {
    sms: profile.subscriptionPlan.smsEnabled,
    smsToCaller: profile.subscriptionPlan.smsToCallerEnabled,
    whatsapp: profile.subscriptionPlan.whatsappEnabled,
    customCrm: profile.subscriptionPlan.customCrmEnabled,
    multilingual: profile.subscriptionPlan.multilingualEnabled,
    callTransferDepartments: transferDepartmentAllowance(profile.subscriptionPlan),
  };
}

export type PlanChangeDirection = "upgrade" | "downgrade" | "same";

export interface ProrationResult {
  direction: PlanChangeDirection;
  /** Credit (cents) for the current plan's unused minutes. */
  creditCents: number;
  /** What the user pays now (upgrades only; downgrades = 0, billed next cycle). */
  amountDueCents: number;
}

/** Minutes-based proration: credit = unused fraction x price paid. Upgrade pays newPrice - credit now; downgrade pays nothing now. Pure. */
export function computeProration(input: {
  currentPriceCents: number;
  newPriceCents: number;
  minutesAllocated: number;
  minutesRemaining: number;
  /** What was ACTUALLY paid for the cycle. Credit must be a share of real money — list price over-refunded discounted customers. Undefined falls back to list price. */
  paidCents?: number;
}): ProrationResult {
  const { currentPriceCents, newPriceCents, minutesAllocated, minutesRemaining } = input;
  const ratio = minutesAllocated > 0 ? Math.min(1, Math.max(0, minutesRemaining / minutesAllocated)) : 0;
  // Never credit more than the plan is worth, and never more than was paid.
  const creditBase = Math.max(0, Math.min(input.paidCents ?? currentPriceCents, currentPriceCents));
  const creditCents = Math.round(ratio * creditBase);
  // Direction is a comparison of PLANS, so it stays on list prices: a discounted
  // $50 plan (paid $25) moving to a $30 plan is still a downgrade.
  const direction: PlanChangeDirection =
    newPriceCents > currentPriceCents ? "upgrade" : newPriceCents < currentPriceCents ? "downgrade" : "same";
  const amountDueCents = direction === "upgrade" ? Math.max(0, newPriceCents - creditCents) : 0;
  return { direction, creditCents, amountDueCents };
}

/** Vapi accepts a per-call `maxDurationSeconds` in [10, 43200]. */
export const VAPI_MIN_CALL_SECONDS = 10;
export const VAPI_MAX_CALL_SECONDS = 43200;

/** Clamp a desired cap into Vapi's allowed range. */
export function clampCallSeconds(seconds: number): number {
  return Math.min(VAPI_MAX_CALL_SECONDS, Math.max(VAPI_MIN_CALL_SECONDS, Math.floor(seconds)));
}

/** Per-call cap in seconds; null = unlimited, minimum when blocked. An auto-renew plan/trial gets remaining + one full allowance of headroom so a live call isn't dropped mid-conversation — settlement renews afterwards. */
export function remainingCallSeconds(state: EntitlementState): number | null {
  if (state.unlimited) return null;
  if (
    state.autoRenew &&
    state.minutesAllocated > 0 &&
    (state.phase === "active" || state.phase === "trial")
  ) {
    return clampCallSeconds((state.minutesRemaining + state.minutesAllocated) * 60);
  }
  if (state.blocked) return VAPI_MIN_CALL_SECONDS;
  return clampCallSeconds(state.minutesRemaining * 60);
}

/** Per-call cap lowered to the platform ceiling. Every path stamping maxDurationSeconds goes through here so the ceiling can't be missed. */
export async function getCallDurationCap(
  userId: string,
  now = new Date(),
): Promise<number | null> {
  const state = await getEntitlement(userId, now);
  return applyCallDurationCap(remainingCallSeconds(state), await getCallDurationCapSetting());
}

/** Resolve the {code,message} for a blocked entitlement. */
export function entitlementError(state: EntitlementState): { code: string; message: string } {
  if (state.phase === "active" && state.status === "expired_minutes") return PLAN_EXHAUSTED_ERROR;
  if (state.phase === "active" && state.status === "expired_date") return PLAN_EXPIRED_ERROR;
  if (state.status === "active") return PLAN_EXHAUSTED_ERROR; // unreachable; keeps types total
  return ENTITLEMENT_ERRORS[state.status];
}

/** Profile fields to set when a trial begins (called from the subscribe flow). */
export async function buildTrialStartData(now = new Date()): Promise<{
  trialStartedAt: Date;
  trialMinutesAllocated: number;
  trialSecondsUsed: number;
  trialStatus: TrialStatus;
  usageAlertsSent: string;
}> {
  const minutes = await getTrialMinutes();
  return {
    trialStartedAt: now,
    trialMinutesAllocated: minutes,
    trialSecondsUsed: 0,
    trialStatus: TRIAL_STATUS.ACTIVE,
    usageAlertsSent: "",
  };
}

/** Days the trial should run (for the Stripe trial_period_days). */
export async function getTrialDurationDays(): Promise<number> {
  return getTrialDays();
}

/** Snapshots a plan's allowance and resets per-cycle usage. Idempotent per period; `resetUsage` forces the reset for an upgrade that keeps its billing date (they paid for a full new allowance). */
export async function applyActivePlanMinutes(
  userId: string,
  opts: {
    includedMinutes: number;
    periodEnd: Date | null;
    resetUsage?: boolean;
    /** Overage from a source other than the plan counter (trial->paid: it sits in trialSecondsUsed). Overrides the derived overage. */
    carryOverSeconds?: number;
  },
): Promise<void> {
  const profile = await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: { currentPeriodEnd: true, planSecondsUsed: true, planMinutesAllocated: true },
  });
  const oldAllocatedSec = (profile?.planMinutesAllocated ?? 0) * 60;
  const usedSec = profile?.planSecondsUsed ?? 0;
  const storedEnd = profile?.currentPeriodEnd ?? null;

  // IDEMPOTENT by design (the renewal path and its webhook both land here): only an explicit reset or a
  // period end moved > 1h counts. A null stored end and exhaustion are NOT boundaries — both used to wipe usage.
  const PERIOD_ADVANCE_MS = 60 * 60 * 1000; // 1h: far below a real cycle, far above a re-applied tick
  const periodAdvanced =
    opts.periodEnd != null &&
    storedEnd != null &&
    opts.periodEnd.getTime() - storedEnd.getTime() > PERIOD_ADVANCE_MS;
  const isNewPeriod = opts.resetUsage === true || periodAdvanced;

  // Carry overage from an auto-renew call into the new cycle so it isn't free, capped to
  // leave at least one minute so a huge overrun can't trigger a second renewal at once.
  const planOverageSec = oldAllocatedSec > 0 ? Math.max(0, usedSec - oldAllocatedSec) : 0;
  const overageSec = opts.carryOverSeconds != null ? Math.max(0, opts.carryOverSeconds) : planOverageSec;
  const carriedOverageSec = Math.min(overageSec, Math.max(0, opts.includedMinutes * 60 - 60));

  await (await tenantForUser(userId)).profile.update({
    where: { userId },
    data: {
      planMinutesAllocated: opts.includedMinutes,
      // Never write null over a known period end — it blanked "Renews" and used to
      // put the profile in a permanent reset-on-every-call state.
      ...(opts.periodEnd != null ? { currentPeriodEnd: opts.periodEnd } : {}),
      // A fresh period resets usage to just the carried-over overage (usually 0)
      // and clears the alert flags so 50/80/90% emails fire for the new allowance.
      ...(isNewPeriod ? { planSecondsUsed: carriedOverageSec, usageAlertsSent: "" } : {}),
      // Paying lifts any post-trial number-hold immediately (don't wait for the sweep).
      graceStartedAt: null,
      graceEndsAt: null,
      graceNotifyStage: null,
    },
  });

  // Re-push the assistant: entitlements decide which tools are attached, and the
  // payload is frozen on Vapi until the next push.
  void syncEntitlementsToAssistant(userId);
}

/** Re-pushes the live assistant so entitlements apply now. Not awaited — a Vapi hiccup must never fail a payment that already went through. */
export async function syncEntitlementsToAssistant(userId: string): Promise<void> {
  try {
    const conv = await (await tenantForUser(userId)).conversion.findUnique({
      where: { userId },
      select: { vapiAssistantId: true, agentConfig: true },
    });
    if (!conv?.vapiAssistantId) return; // never provisioned — nothing live to correct
    // Dynamic import on purpose: services/vapi.ts imports getPlanFeatures from
    // this module, so importing it at the top would close the cycle.
    const { upsertAssistant } = await import("./vapi.js");
    await upsertAssistant(conv.agentConfig as never, conv.vapiAssistantId, { ownerId: userId });
  } catch (e) {
    console.warn(`[entitlements] assistant resync failed for ${userId}:`, e);
  }
}

/** Round a call's real duration up to whole billable minutes: any started
 *  minute counts in full, so even a 1–2s call is billed as 1 minute. */
export function billableSeconds(seconds: number): number {
  return Math.ceil(seconds / 60) * 60;
}

/** Total billed minutes on a conversion, summed in Postgres. Rounding is PER CALL (sixty 5s calls = 60 minutes), which Prisma's _sum can't do — hence raw SQL. */
export async function billedMinutesFor(db: TenantClient, conversionId: string): Promise<number> {
  const rows = await db.$queryRaw<{ minutes: bigint | null }[]>`
    SELECT COALESCE(SUM(CEIL("durationSec"::numeric / 60)), 0)::bigint AS minutes
    FROM "call_logs"
    WHERE "conversionId" = ${conversionId}
  `;
  return Number(rows[0]?.minutes ?? 0);
}

/** Records call usage against the active quota with one atomic increment (concurrent calls can't lose updates). Rounded up to a full minute; the CallLog keeps the real duration. */
export async function recordUsage(
  userId: string,
  seconds: number,
  now = new Date(),
): Promise<EntitlementState | null> {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const billed = billableSeconds(seconds);

  const profile = await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: { subscriptionStatus: true },
  });
  if (!profile) return null;

  if (profile.subscriptionStatus === "trialing") {
    const updated = await (await tenantForUser(userId)).profile.update({
      where: { userId },
      data: { trialSecondsUsed: { increment: billed } },
      select: {
        trialEndsAt: true,
        trialMinutesAllocated: true,
        trialSecondsUsed: true,
      },
    });
    const minutesAllocated = updated.trialMinutesAllocated ?? (await getTrialMinutes());
    const minutesUsed = round1(updated.trialSecondsUsed / 60);
    const status = evaluateTrialStatus({
      minutesAllocated,
      minutesUsed,
      endsAt: updated.trialEndsAt,
      now,
    });
    await (await tenantForUser(userId)).profile.update({ where: { userId }, data: { trialStatus: status } });
    const state = await getEntitlement(userId, now);
    void maybeSendUsageAlerts(userId, state);
    return state;
  }

  if (profile.subscriptionStatus === "active") {
    await (await tenantForUser(userId)).profile.update({
      where: { userId },
      data: { planSecondsUsed: { increment: billed } },
    });
    const state = await getEntitlement(userId, now);
    void maybeSendUsageAlerts(userId, state);
    return state;
  }

  // Card-less trial shares the trialSecondsUsed counter; reset when a paid trial starts.
  if (profile.subscriptionStatus === "none") {
    await (await tenantForUser(userId)).profile.update({
      where: { userId },
      data: { trialSecondsUsed: { increment: billed } },
    });
    const state = await getEntitlement(userId, now);
    void maybeSendUsageAlerts(userId, state);
    return state;
  }

  return null;
}

/** Usage-alert thresholds (percent of the cycle's allowance) we email the owner at. */
const USAGE_ALERT_THRESHOLDS = [50, 80, 90] as const;

function parseUsageAlerts(s: string | null | undefined): number[] {
  return (s ?? "")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
}

// Emails each newly crossed 50/80/90% threshold once per cycle (usageAlertsSent). A
// threshold is marked sent only after its email succeeds so a blip retries next call.
async function maybeSendUsageAlerts(
  userId: string,
  state: EntitlementState | null,
): Promise<void> {
  try {
    // Only meaningful for a finite, metered allowance; unlimited plans never alert.
    if (!state || state.unlimited || state.minutesAllocated <= 0) return;
    if (!integrationsStatus().email) return;

    const pct = (state.minutesUsed / state.minutesAllocated) * 100;
    const crossed = USAGE_ALERT_THRESHOLDS.filter((t) => pct >= t);
    if (!crossed.length) return;

    const profile = await (await tenantForUser(userId)).profile.findUnique({
      where: { userId },
      select: { usageAlertsSent: true, user: { select: { email: true, fullName: true } } },
    });
    const email = profile?.user?.email;
    if (!email) return;

    const already = parseUsageAlerts(profile.usageAlertsSent);
    const due = crossed.filter((t) => !already.includes(t)).sort((a, b) => a - b);
    if (!due.length) return;

    // Every crossed threshold, lowest first, each showing its own minutes so the
    // headline and figures agree.
    const sent: number[] = [];
    for (const threshold of due) {
      try {
        const thresholdUsed = (threshold / 100) * state.minutesAllocated;
        await usageThresholdEmail({
          ownerEmail: email,
          fullName: profile.user!.fullName,
          threshold,
          minutesUsed: thresholdUsed,
          minutesAllocated: state.minutesAllocated,
          minutesRemaining: state.minutesAllocated - thresholdUsed,
          isTrial: state.isTrial,
        });
        sent.push(threshold);
      } catch {
        /* leave this threshold unsent so the next call retries it */
      }
    }
    if (!sent.length) return;

    // Record only the thresholds whose email actually sent.
    const merged = Array.from(new Set([...already, ...sent])).sort((a, b) => a - b);
    await (await tenantForUser(userId)).profile.update({ where: { userId }, data: { usageAlertsSent: merged.join(",") } });
  } catch {
    /* best-effort: an alert failure must never disrupt usage recording */
  }
}

// Early renewal for an exhausted active plan: charge a full period, reset the counter.
// A declined card flips to past_due. Never throws.
async function renewActivePlanIfExhausted(
  userId: string,
  stripeSubscriptionId: string,
  plan: { includedMinutes: number; displayName: string } | null,
  autoRenew: boolean,
  _now: Date,
): Promise<void> {
  // Auto-renew off = never auto-charge; Stripe cancels at period end.
  if (!autoRenew) return;
  // Check RAW usage from the profile (not getEntitlement, which masks an exhausted
  // auto-renew plan as "active" for display) so the renewal still fires.
  const fresh = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: {
      subscriptionStatus: true,
      subscriptionPlanId: true, // for the renewal's plan-history row
      planMinutesAllocated: true,
      planSecondsUsed: true } }));
  if (!fresh || fresh.subscriptionStatus !== "active") return;
  const allocatedMin = fresh.planMinutesAllocated ?? fresh.subscriptionPlan?.includedMinutes ?? 0;
  if (allocatedMin <= 0) return; // unlimited plan — never exhausts
  if (fresh.planSecondsUsed / 60 < allocatedMin) return; // not exhausted yet

  // A portal cancel's webhook can lag (or never reach dev), so check Stripe's live
  // cancel state before charging.
  try {
    const stillAutoRenews = await getSubscriptionAutoRenew(stripeSubscriptionId);
    if (!stillAutoRenews) {
      await (await tenantForUser(userId)).profile
        .update({ where: { userId }, data: { autoRenew: false } })
        .catch(() => {});
      return;
    }
  } catch {
    // Couldn't reach Stripe to confirm — fall through to the existing behaviour
    // rather than blocking a legitimate renewal on a transient read failure.
  }

  // CLAIM before charging — parallel requests each saw "exhausted" and double-charged. The `gte`
  // is re-evaluated under the row lock so one caller wins; zeroing is safe since a failed charge flips to past_due.
  const allocatedSec = allocatedMin * 60;
  const claim = await (await tenantForUser(userId)).profile.updateMany({
    where: { userId, planSecondsUsed: { gte: allocatedSec } },
    data: { planSecondsUsed: 0 },
  });
  if (claim.count === 0) return; // another request already claimed this renewal
  // Overage from the cycle we just claimed — the counter is zeroed above, so this
  // has to be carried into applyActivePlanMinutes explicitly.
  const overageSec = Math.max(0, fresh.planSecondsUsed - allocatedSec);

  try {
    const { currentPeriodEnd, active, releasedScheduleId } =
      // Automatic path → dedupe, so a request that slipped past the claim above
      // still can't turn into a second charge.
      await renewSubscriptionNow(stripeSubscriptionId, { dedupeConcurrent: true });
    // The renewal released the downgrade schedule; drop our mirror or the UI shows a
    // plan change that will never happen.
    if (releasedScheduleId) {
      await (await tenantForUser(userId)).profile
        .update({
          where: { userId },
          data: { scheduledPlanId: null, scheduledPlanEffectiveAt: null, stripeScheduleId: null },
        })
        .catch(() => {});
    }
    if (!active) {
      await (await tenantForUser(userId)).profile.update({
        where: { userId },
        data: { subscriptionStatus: "past_due", plan: "free" },
      });
      return;
    }
    await applyActivePlanMinutes(userId, {
      includedMinutes: await effectiveIncludedMinutes(userId, plan?.includedMinutes ?? 0),
      periodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      // The claim zeroed the counter, so pass the real overage explicitly.
      resetUsage: true,
      ...(overageSec > 0 ? { carryOverSeconds: overageSec } : {}),
    });
    // Read the invoice first so consumeCycle can key on its id — two early renewals in
    // one day have period ends minutes apart, and the window alone would dedupe them.
    const inv = await getLatestPaidInvoice(stripeSubscriptionId);
    // The cycle just paid for is one the coupon covered, so count it only now —
    // after its discount and bonus minutes have both been applied.
    await consumeCycle(
      userId,
      stripeSubscriptionId,
      currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      inv?.id ?? null,
    );
    void notify(userId, {
      type: "billing",
      title: "Your plan renewed early ↻",
      message: `You used all the call minutes in your ${plan?.displayName ?? "plan"}, so it renewed for a fresh period and your minutes are topped up.`,
      link: "/dashboard/plans",
    });
    // Accrue the reseller's commission for the renewal charge (idempotent on the
    // invoice id, so the Stripe webhook won't double-count in production).
    if (inv) {
      await accrueCommissionForInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
      });
      await recordPaidInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
        priceId: inv.priceId,
        source: "renewal",
      });
    }
    // Admin timeline — without it "why was I charged three times?" was only answerable in Stripe.
    void recordPlanEvent({
      userId,
      type: "renewed",
      fromPlanId: fresh.subscriptionPlanId,
      toPlanId: fresh.subscriptionPlanId,
      amountCents: inv?.amountPaidCents ?? 0,
      note: `Included minutes ran out — plan renewed early for a fresh ${plan?.includedMinutes ?? 0}-minute cycle`,
    });
  } catch {
    // Charge failed (declined card, etc.) → reflect a blocked, past_due state.
    await (await tenantForUser(userId)).profile
      .update({ where: { userId }, data: { subscriptionStatus: "past_due", plan: "free" } })
      .catch(() => {});
  }
}

// Hosted-portal cancel mirror: the webhook can lag and never reaches local dev, so
// reconcile polls the live sub (once per user per interval) and mirrors the cancel state.
const PORTAL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const lastPortalSyncAt = new Map<string, number>();

// Mirrors Stripe's live cancel state onto the profile; returns the local snapshot when throttled/failed.
async function syncPortalCancelState(
  userId: string,
  profile: {
    subscriptionStatus: string;
    stripeSubscriptionId: string;
    autoRenew: boolean;
    subscriptionPlanId: string | null;
  },
  now: Date,
  force: boolean,
): Promise<{ status: string; autoRenew: boolean }> {
  const local = { status: profile.subscriptionStatus, autoRenew: profile.autoRenew };
  const last = lastPortalSyncAt.get(userId) ?? 0;
  if (!force && now.getTime() - last < PORTAL_SYNC_INTERVAL_MS) return local;
  lastPortalSyncAt.set(userId, now.getTime());
  try {
    const sub = await getSubscription(profile.stripeSubscriptionId);
    // Immediate cancel (or the sub expired) → the subscription is gone.
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      await (await tenantForUser(userId)).profile.update({
        where: { userId },
        data: { subscriptionStatus: "canceled", plan: "free", autoRenew: false },
      });
      if (profile.subscriptionStatus !== "canceled") {
        void recordPlanEvent({
          userId,
          type: "canceled",
          fromPlanId: profile.subscriptionPlanId,
          note: "Subscription canceled in the Stripe billing portal",
        });
      }
      return { status: "canceled", autoRenew: false };
    }
    // Cancel-at-period-end (portal "Cancel plan") ↔ auto-renew, both directions:
    // the portal's "Renew plan" un-cancel must flip it back on too.
    const liveAutoRenew = !sub.cancelAtPeriodEnd;
    if (liveAutoRenew !== profile.autoRenew) {
      await (await tenantForUser(userId)).profile.update({ where: { userId }, data: { autoRenew: liveAutoRenew } });
      void recordPlanEvent({
        userId,
        type: liveAutoRenew ? "auto_renew_on" : "auto_renew_off",
        fromPlanId: profile.subscriptionPlanId,
        note: liveAutoRenew
          ? "Auto-renew turned back on in the Stripe billing portal"
          : "Canceled in the Stripe billing portal — plan stays live until the period ends, then no further charge",
      });
    }
    return { status: profile.subscriptionStatus, autoRenew: liveAutoRenew };
  } catch {
    /* best-effort — the webhook or the next sync will catch up */
    return local;
  }
}

/** Converts a trialing user to paid NOW (going live commits them). THROWS 400 on a charge failure so the number isn't assigned; no-op for anyone not trialing with a live sub, so a later number change never re-charges. Off-session, so 3DS cards fail here. */
export async function chargeTrialAndActivateNow(
  userId: string,
  opts: { number?: string } = {},
): Promise<{
  converted: boolean;
  planName: string | null;
  amountCents: number | null;
}> {
  const none = { converted: false, planName: null, amountCents: null };
  if (!isStripeConfigured()) return none;

  const profile = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: {
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      subscriptionPlanId: true,
      trialSecondsUsed: true,
      trialMinutesAllocated: true } }));
  // Only a trialing user with a live subscription (i.e. a card on file) converts.
  if (
    !profile ||
    profile.subscriptionStatus !== "trialing" ||
    !profile.stripeSubscriptionId ||
    !profile.subscriptionPlanId
  ) {
    return none;
  }

  const planName = profile.subscriptionPlan?.displayName ?? null;
  try {
    // Clear any pending trial-end cancel, then end the trial so Stripe charges the
    // saved card now and moves the subscription to active.
    await setSubscriptionAutoRenew(profile.stripeSubscriptionId, true);
    let sub = await getSubscription(profile.stripeSubscriptionId);
    if (sub.status === "trialing") {
      // Atomic: a decline throws and LEAVES the trial intact instead of stranding
      // the account in past_due.
      await endTrialNow(profile.stripeSubscriptionId, { errorIfIncomplete: true });
      sub = await getSubscription(profile.stripeSubscriptionId);
    }
    if (sub.status !== "active") throw new Error(`subscription not active after ending trial (${sub.status})`);

    // Carry any trial overage (minutes used beyond the trial allowance) into the
    // new paid cycle — it lives in the trial counter, not the plan counter.
    const trialAllocSec = (profile.trialMinutesAllocated ?? (await getTrialMinutes())) * 60;
    const trialOverageSec = trialAllocSec > 0 ? Math.max(0, profile.trialSecondsUsed - trialAllocSec) : 0;

    await (await tenantForUser(userId)).profile.update({
      where: { userId },
      data: { subscriptionStatus: "active", plan: "premium" },
    });
    const activatedPeriodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null;
    await applyActivePlanMinutes(userId, {
      includedMinutes: await effectiveIncludedMinutes(
        userId,
        profile.subscriptionPlan?.includedMinutes ?? 0,
      ),
      periodEnd: activatedPeriodEnd,
      resetUsage: true,
      ...(trialOverageSec > 0 ? { carryOverSeconds: trialOverageSec } : {}),
    });
    // The invoice this conversion settled — read first so the coupon cycle can
    // key on it rather than on the period end alone.
    const inv = await getLatestPaidInvoice(profile.stripeSubscriptionId);
    // The trial was just charged into a paid cycle — spend one coupon cycle.
    await consumeCycle(userId, profile.stripeSubscriptionId, activatedPeriodEnd, inv?.id ?? null);
    void notifyPlanActivated(userId, { number: opts.number });

    // Accrue the reseller's commission now (covers local dev where Stripe's invoice
    // webhook never reaches us). Idempotent on the invoice id.
    if (inv) {
      await accrueCommissionForInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
      });
      await recordPaidInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
        priceId: inv.priceId,
        source: "go_live",
      });
    }
    return { converted: true, planName, amountCents: inv?.amountPaidCents ?? null };
  } catch (e) {
    console.error(
      `[trial] go-live conversion failed for user ${userId}:`,
      e instanceof Error ? e.message : e,
    );
    // Stay trialing — flipping to past_due would freeze a user who still has trial left.
    throw badRequest(
      e instanceof Error && /card|declined|payment|incomplete|authentication/i.test(e.message)
        ? "We couldn't charge your saved card to activate your plan. Update your card and try again."
        : "We couldn't activate your plan right now. Please try again.",
    );
  }
}

/** Reconciles with Stripe: mirrors portal cancels, renews an exhausted plan early, and converts a lapsed trial (the webhook never reaches local dev). Best-effort, never throws. */
export async function reconcileSubscription(
  userId: string,
  now = new Date(),
  opts: {
    /** Skip the portal-sync throttle — for billing pages the user lands on
     *  right after the Stripe hosted portal, where staleness is visible. */
    forcePortalSync?: boolean;
  } = {},
): Promise<void> {
  if (!isStripeConfigured()) return;
  const profile = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: {
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      subscriptionPlanId: true,
      autoRenew: true,
      trialSecondsUsed: true,
      trialMinutesAllocated: true } }));
  if (!profile?.stripeSubscriptionId) return;

  // Mirror a hosted-portal cancel first, so everything below gates on the
  // post-sync truth (e.g. a portal cancel must block the early renewal).
  if (["active", "trialing", "past_due"].includes(profile.subscriptionStatus)) {
    const synced = await syncPortalCancelState(
      userId,
      {
        subscriptionStatus: profile.subscriptionStatus,
        stripeSubscriptionId: profile.stripeSubscriptionId,
        autoRenew: profile.autoRenew,
        subscriptionPlanId: profile.subscriptionPlanId ?? null,
      },
      now,
      opts.forcePortalSync ?? false,
    );
    if (synced.status === "canceled") return;
    profile.autoRenew = synced.autoRenew;
  }

  // Minutes ran out before the date -> renew now. The date is Stripe's job.
  if (profile.subscriptionStatus === "active") {
    // A discount that outlived its cycle budget (failed detach, missed webhook) would
    // otherwise discount forever. Fail-open.
    await healDiscountDrift(userId, profile.stripeSubscriptionId);
    await renewActivePlanIfExhausted(
      userId,
      profile.stripeSubscriptionId,
      profile.subscriptionPlan,
      profile.autoRenew,
      now,
    );
    return;
  }

  if (profile.subscriptionStatus !== "trialing" && profile.subscriptionStatus !== "past_due") return;

  // Auto-renew off = no auto-charge; the trial lapses and Stripe cancels at trial end.
  if (!profile.autoRenew) return;

  // For a trialing user, only act once the trial is actually over (date or minutes).
  if (profile.subscriptionStatus === "trialing") {
    const ent = await getEntitlement(userId, now);
    if (!(ent.phase === "trial" && ent.blocked)) return;
  }

  try {
    let sub = await getSubscription(profile.stripeSubscriptionId);
    // Trial lapsed by minutes before Stripe's date → end it now so the card is charged.
    if (sub.status === "trialing") {
      await endTrialNow(profile.stripeSubscriptionId);
      sub = await getSubscription(profile.stripeSubscriptionId);
    }
    if (sub.status === "active") {
      // Trial overage lives in the trial counter, not the plan counter — carry it explicitly.
      const trialAllocSec = (profile.trialMinutesAllocated ?? (await getTrialMinutes())) * 60;
      const trialOverageSec =
        profile.subscriptionStatus === "trialing" && trialAllocSec > 0
          ? Math.max(0, profile.trialSecondsUsed - trialAllocSec)
          : 0;
      await (await tenantForUser(userId)).profile.update({
        where: { userId },
        data: { subscriptionStatus: "active", plan: "premium" },
      });
      await applyActivePlanMinutes(userId, {
        includedMinutes: await effectiveIncludedMinutes(
          userId,
          profile.subscriptionPlan?.includedMinutes ?? 0,
        ),
        periodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
        // A real new paid cycle, whatever period end Stripe gave us.
        resetUsage: true,
        ...(trialOverageSec > 0 ? { carryOverSeconds: trialOverageSec } : {}),
      });
      // The invoice this conversion settled — read first so the coupon cycle can
      // key on it rather than on the period end alone.
      const inv = await getLatestPaidInvoice(profile.stripeSubscriptionId);
      // The trial just converted, so the card was charged — count that cycle
      // against any live coupon, after its discount and bonus minutes applied.
      await consumeCycle(
        userId,
        profile.stripeSubscriptionId,
        sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
        inv?.id ?? null,
      );
      // Reaching here means a trialing/past_due account just went active — tell them.
      void notifyPlanActivated(userId);
      // Commission and the brand-wallet ledger row now (the invoice webhook never reaches local dev); both idempotent on invoice id.
      if (inv) {
        await accrueCommissionForInvoice({
          invoiceId: inv.id,
          customerId: inv.customerId,
          amountPaidCents: inv.amountPaidCents,
        });
        await recordPaidInvoice({
          invoiceId: inv.id,
          customerId: inv.customerId,
          amountPaidCents: inv.amountPaidCents,
          priceId: inv.priceId,
          source: "reconcile",
        });
      }
    } else {
      // canceled / incomplete_expired / past_due → reflect Stripe's truth.
      await (await tenantForUser(userId)).profile.update({
        where: { userId },
        data: {
          subscriptionStatus: sub.status,
          plan: sub.status === "trialing" ? "premium" : "free",
        },
      });
    }
  } catch {
    /* best-effort — the webhook or a later load will retry */
  }
}
