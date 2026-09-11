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

/**
 * Best-effort: email + in-app notify the user that their free trial converted to
 * a paid plan. Call ONLY on the trial→active transition (not on renewals).
 */
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

/**
 * Entitlement service — the single source of truth for whether a user can use
 * paid (AI-call) functionality right now, and how many call minutes they have
 * left. It spans the whole lifecycle:
 *
 *   trialing  → free trial: global trial minutes + a trial end date.
 *   active    → paid plan: the plan's `includedMinutes`, reset every renewal.
 *   past_due / none / canceled → blocked (must (re)subscribe / fix payment).
 *
 * A trial ends when EITHER the allocated minutes run out OR the end date passes
 * (minutes exhaustion takes precedence). A paid plan only blocks when the
 * period's minutes are exhausted; usage resets on the next renewal.
 */

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
  /** True when the user has an existing paid plan they can renew now (blocked
   *  active plan / past_due) — vs needing to pick a plan fresh. Drives the
   *  "Renew plan" CTA instead of sending them to /subscribe. */
  canRenew: boolean;
  /** Whether the plan auto-renews + auto-charges the saved card on exhaustion.
   *  Drives the per-call cap: an active plan with this ON isn't hard-cut at its
   *  remaining minutes — the call runs into the next cycle and the renewal tops
   *  up + charges after it ends (so a live call is never interrupted). */
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
  /** Account locked by an admin (manual suspend). Unlike `suspended` (billing
   *  lapse, self-recoverable via /subscribe), this hard-locks the account — the
   *  frontend force-logs-out to /login; only an admin can lift it. */
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

/**
 * Platform admins aren't customers — they have no subscription/onboarding but
 * still need to exercise the AI (test calls, the assistant) to support the
 * product. Treat them as an always-on, unlimited entitlement so every gate
 * (the trial middleware, the per-call cap, the frontend test button) clears.
 */
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

/**
 * Compute the user's live entitlement. Reads the profile + the chosen plan's
 * included minutes and resolves trial vs paid limits.
 */
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

  // THE CARD WALL. An account that signed up while `onboarding.cardRequired` was
  // ON has no entitlement of any kind until its first card is confirmed —
  // whatever subscriptionStatus happens to say.
  //
  // Checked here, above every status branch, and keyed on cardConfirmedAt rather
  // than on the status string, because the status is written from several places
  // this module doesn't control: /subscribe opens a REAL Stripe trial
  // subscription before any card exists, so Stripe reports "trialing" and the
  // billing webhook mirrors it — a user who picks a plan and closes the tab would
  // otherwise be handed the full trial with no card. /billing/renew's failure
  // path writes "past_due", and an abandoned trial is cancelled to "canceled".
  // A positive, locally-owned flag can't be moved by any of them.
  //
  // Grandfathered accounts are untouched: cardRequiredAtSignup is false for every
  // row that existed before this shipped, so this never fires for them.
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
    // A non-renewing plan (auto-renew OFF) whose billing period has ended is expired
    // even if minutes remain: the plan was sold for that ONE period (e.g. a month),
    // so once the period is over and it won't renew, entitlement stops — leftover
    // minutes don't extend it past the date it was paid for. Auto-renew ON is
    // excluded: that plan renews at the boundary (Stripe pushes currentPeriodEnd
    // forward), so a momentarily-past period end is just webhook lag, not an expiry.
    const periodEnded =
      !!profile.currentPeriodEnd && now.getTime() >= profile.currentPeriodEnd.getTime();
    const dateExpired = periodEnded && !profile.autoRenew;
    // Auto-renew tops the plan up the instant minutes run out, so an exhausted
    // auto-renew plan is never really "blocked". Present the PROJECTED
    // post-renewal numbers (the overage carried into a fresh cycle) so the
    // dashboard shows e.g. 1/5 immediately instead of flickering to "6/5 — minutes
    // used up / calls paused" while the background renewal completes. The renewal
    // itself fires off RAW usage (renewActivePlanIfExhausted), not this status.
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

  // Fresh account that never subscribed → a CARD-LESS free trial so they can test
  // the assistant (web calls) on a limited allowance without a card. They stay
  // subscriptionStatus="none" — the dashboard is reachable and plan + card are
  // only collected in the "tap to set up" number wizard when they claim a number.
  // The trial runs from account creation, capped by the same minutes/days as the
  // paid trial; usage accrues in trialSecondsUsed (reset when a paid trial starts).
  //
  // A card-required account never reaches here — the card wall above returns
  // first until its card is confirmed. The flag it reads comes from THIS ROW only;
  // the platform setting is deliberately never consulted in this module, so
  // flipping the admin toggle can't change the answer for anyone already signed up.
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
      // A card-less trial can NEVER auto-renew/auto-convert (no card on file), so
      // it must be false regardless of the profile flag — otherwise the per-call
      // cap grants "auto-renew headroom" and a call runs past the last minute,
      // overshooting the allowance (e.g. showing 6/5 minutes used).
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
  /**
   * Human Call Transfer, already resolved to a single number of departments:
   * 0 = the plan excludes transfer entirely. Deliberately not the raw
   * `callTransferEnabled` / `callTransferLimit` pair — there 0 means both
   * "unlimited" and "off" depending on the flag, which is easy to read
   * backwards. See transferDepartmentAllowance().
   */
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

/**
 * Which add-on features the user's plan grants right now.
 *
 * The gate is PAYMENT, not going live. Signup and the free trial stay wide open
 * so people can try every add-on before they buy; the moment a payment lands
 * (`subscriptionStatus` = "active") the chosen plan's flags apply, whether or not
 * a receptionist number has been claimed yet.
 *
 * This used to hinge on having a number, which meant a paying customer on a
 * cheaper plan kept every premium add-on until they finished the number wizard.
 *
 * A lapsed subscription (past_due / suspended / canceled) keeps being judged by
 * its plan rather than falling back open — nobody should gain features by not
 * paying. Whether they can take calls at all is decided separately (see
 * `blockedCopy` / the trial middleware).
 */
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
  // Signup + free trial: everything unlocked, so an add-on can be tried before
  // it's paid for. Nothing has been charged yet, so there is nothing to enforce.
  //
  // This stays deliberately wide open for signup AND the whole trial, including a
  // card-required account still waiting on its card. Feature restriction is a
  // PLAN concern: nothing is restricted until a plan activates, and then only to
  // what that plan includes. Whether an account may use the service at all is a
  // separate question answered by getEntitlement — so the card wall is enforced
  // there (and at each route that spends money), never by quietly stripping
  // features here.
  const status = profile?.subscriptionStatus ?? "none";
  if (status === "none" || status === "trialing") {
    return {
      ...ALL_FEATURES,
      // COUNTS are the one exception to "everything unlocked during the trial".
      //
      // A boolean add-on can be handed out freely and simply flips off at
      // conversion — nothing is left behind. A department is real state the
      // customer created: unlock 20 on a 2-department plan and, the moment the
      // trial converts, the extras are orphaned. They stay configured, the
      // assistant silently stops offering them, and the next plan change is
      // refused over departments the customer never knew were surplus.
      //
      // So the trial previews the number they actually bought. Before a plan is
      // picked there is nothing to preview, and nothing has been sold, so the
      // hard ceiling stands.
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

/**
 * Minutes-based proration credit for a plan change. The unused portion of the
 * current plan's minutes is credited against the new plan's price:
 *   credit = (remainingMinutes / allocatedMinutes) × currentPriceCents
 * Upgrade → pay max(0, newPrice − credit) now. Downgrade → pay nothing now (the
 * lower price simply applies next cycle). Pure function (easy to unit-test).
 */
export function computeProration(input: {
  currentPriceCents: number;
  newPriceCents: number;
  minutesAllocated: number;
  minutesRemaining: number;
  /**
   * What the customer ACTUALLY paid toward the cycle being replaced, when we can
   * establish it. Credit is a refund of unused time, so it can only ever be a
   * share of money that changed hands — the plan's list price is the wrong base
   * the moment a discount exists. A 50%-off customer on a $20 plan paid $10; on
   * an untouched allowance the list price handed them $20 back, so upgrading to
   * $50 cost $30 instead of $40 and we lost the discount twice over.
   *
   * Left undefined when it can't be determined (no charge yet, Stripe
   * unreachable) — the list price is then the best estimate available, which is
   * also the long-standing behaviour for the undiscounted majority.
   */
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

/**
 * Seconds a single call may run, given the user's live entitlement:
 *   - `null`  → no cap (unlimited plan).
 *   - clamped seconds remaining otherwise.
 * A blocked user gets the minimum so any connected call is cut almost immediately.
 *
 * Exception: an auto-renew plan/trial isn't hard-cut at its remaining minutes.
 * The moment minutes run out it auto-renews (active plan → charges the saved card
 * + tops minutes up) OR auto-converts the trial to the paid plan (charges the
 * card saved at signup), so a live call must be free to run on instead of being
 * dropped mid-conversation. We grant the remaining minutes PLUS one full
 * allowance of headroom; the post-call settlement performs the renewal/conversion.
 * This also covers an already-exhausted allowance (minutesRemaining ≈ 0 → a full
 * cycle of headroom).
 */
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

/** Convenience: compute a user's per-call cap from their stored entitlement,
 *  then lower it to the platform's per-call ceiling when the admin has one set.
 *  Every path that stamps `maxDurationSeconds` onto an assistant goes through
 *  here, so the ceiling can't be missed by one of them. */
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

/**
 * Snapshot a newly-active (or renewed) plan's minute allowance and reset the
 * per-cycle usage counter. Idempotent per billing period: pass the period end
 * and we only reset when it actually advances.
 *
 * `resetUsage` forces the usage counter to zero even when the period end is
 * unchanged. An immediate upgrade keeps the same billing date (we swap the
 * Stripe price with `proration_behavior: 'none'`), but the user has paid the
 * full new-plan price minus a credit for their *unused* old-plan minutes — so
 * the new plan must grant its full allowance. Without this, minutes already
 * used on the cheaper plan would carry over and silently shrink the upgraded
 * allowance (e.g. 3 min used on a 100-min plan → only 197 of a new 200).
 */
export async function applyActivePlanMinutes(
  userId: string,
  opts: {
    includedMinutes: number;
    periodEnd: Date | null;
    resetUsage?: boolean;
    /** Seconds of overage to carry into the new cycle from a source OTHER than the
     *  plan counter — used on a trial→paid conversion, where the overage sits in
     *  `trialSecondsUsed` (the plan counter is still 0). Overrides the plan-derived
     *  overage when set. */
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

  // Is this a genuinely NEW billing period? This must be IDEMPOTENT: an early
  // auto-renew applies the new period itself (renewActivePlanIfExhausted) AND
  // the `customer.subscription.updated` webhook it triggers applies it again. If
  // both counted as "new", the second one would recompute the overage against
  // the already-reset usage (now below the allowance) and wipe the carried
  // overage back to 0 (the "shows 0/5 instead of 1/5" bug). So we only treat it
  // as new when there's a real boundary: forced; OR usage hit the old allowance
  // (early renewal); OR the period jumped forward by a real cycle (> 1 hour) vs
  // what we already stored. A re-application of the SAME renewal sees usage
  // already below the allowance and a near-identical period end → no-op.
  // A missing stored period end proves NOTHING about a boundary — it just means we
  // never learned one (Stripe sent no `current_period_end`, or a webhook hasn't
  // landed). Treating it as "new period" made EVERY call here wipe usage, so a mere
  // auto-renew toggle or downgrade — which fire `customer.subscription.updated` —
  // reset a user's 100/200 back to 0/200. A real boundary is: an explicit reset, a
  // cycle that ran out of minutes, or a period end that actually moved forward.
  // Exhaustion is deliberately NOT a boundary. Running out of minutes is a state
  // the user sits in until something actually charges them — it is not, by itself,
  // evidence that a new cycle was paid for. Every caller that has taken money says
  // so explicitly with `resetUsage: true` (renewal, trial conversion, upgrade,
  // /renew), and the early-renewal path zeroes the counter before calling anyway.
  // So inferring a reset from "usage >= allowance" only ever fired on the one
  // caller that doesn't pass the flag — the customer.subscription.updated webhook,
  // which also fires for edits that move no money at all (toggling auto-renew,
  // scheduling a downgrade, a price swap). A customer with auto-renew OFF who had
  // spent their allowance was handed a fresh one, free, the next time any of those
  // happened.
  const PERIOD_ADVANCE_MS = 60 * 60 * 1000; // 1h: far below a real cycle, far above a re-applied tick
  const periodAdvanced =
    opts.periodEnd != null &&
    storedEnd != null &&
    opts.periodEnd.getTime() - storedEnd.getTime() > PERIOD_ADVANCE_MS;
  const isNewPeriod = opts.resetUsage === true || periodAdvanced;

  // Carry forward any OVERAGE into the new cycle: when an auto-renew call runs
  // past the old cycle's allowance (the call isn't cut mid-conversation), the
  // seconds used beyond that allowance are counted against the renewed cycle so
  // they aren't given away free (e.g. a 1:15 call with 1 min left → 1 min carried
  // → new cycle shows 1/5, not 0/5). Usually 0 → a clean reset. Capped to leave
  // at least one minute in the new cycle so a huge overrun can't immediately
  // re-exhaust it and trigger a second renewal/charge.
  // Overage source: an explicit carry-over (trial→paid, overage lives in the trial
  // counter) when given, otherwise the plan counter's own overage (active renewal).
  const planOverageSec = oldAllocatedSec > 0 ? Math.max(0, usedSec - oldAllocatedSec) : 0;
  const overageSec = opts.carryOverSeconds != null ? Math.max(0, opts.carryOverSeconds) : planOverageSec;
  const carriedOverageSec = Math.min(overageSec, Math.max(0, opts.includedMinutes * 60 - 60));

  await (await tenantForUser(userId)).profile.update({
    where: { userId },
    data: {
      planMinutesAllocated: opts.includedMinutes,
      // Only write a period end we actually know. Writing `null` over a good value
      // (a caller that couldn't read one from Stripe) blanked "Renews —" on the
      // billing page and, before the guard above, left the profile permanently in
      // the state where every later call reset usage.
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

  // The plan just took effect, so re-push the live assistant. Entitlement checks
  // shape the assistant PAYLOAD (which tools are attached — info-SMS, booking,
  // transfer), and that payload is frozen on Vapi at the last push. Without this
  // a customer who paid for a cheaper plan kept using the premium tools on real
  // calls until something unrelated happened to re-sync them.
  void syncEntitlementsToAssistant(userId);
}

/**
 * Re-push a user's live assistant so plan entitlements apply to calls now.
 *
 * Best-effort and deliberately not awaited by callers: a Vapi hiccup must never
 * fail a payment that already succeeded. The next save or resync would fix it
 * anyway — this just removes the window where the UI says "not in your plan"
 * while the agent still offers it.
 */
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

/**
 * Total billed minutes across every call on a conversion, summed in Postgres.
 *
 * The rounding has to happen PER CALL — `billableSeconds` charges each started
 * minute in full, so summing raw seconds and rounding once at the end
 * undercounts badly (sixty 5-second calls are 60 billed minutes, not 5). That
 * per-row `ceil` is why this is raw SQL: Prisma's `_sum` can only add the column
 * as stored, so both call sites used to fetch every row and fold them in
 * JavaScript instead — an unbounded read that grew with the customer's history
 * every time an admin opened their page.
 *
 * `CEIL(durationSec / 60)` is exactly `billableSeconds(s) / 60`, so this returns
 * whole minutes directly and the two agree row for row.
 */
export async function billedMinutesFor(db: TenantClient, conversionId: string): Promise<number> {
  const rows = await db.$queryRaw<{ minutes: bigint | null }[]>`
    SELECT COALESCE(SUM(CEIL("durationSec"::numeric / 60)), 0)::bigint AS minutes
    FROM "call_logs"
    WHERE "conversionId" = ${conversionId}
  `;
  return Number(rows[0]?.minutes ?? 0);
}

/**
 * Record call usage against whichever quota is active (trial or plan) and
 * recompute the cached trial status. The seconds increment is a single atomic
 * DB op so concurrent calls can't lose updates. No-op for unentitled users.
 *
 * Billing rounds each call up to a full minute (`billableSeconds`) — the real
 * call duration is still stored verbatim on the CallLog for display.
 */
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

  // Card-less free trial (never subscribed) — accrue usage against the same
  // trialSecondsUsed counter so the free web-call allowance depletes and blocks
  // once exhausted. Reset to 0 when a paid trial later starts (buildTrialStartData).
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

/**
 * After usage is recorded, email the owner the first time their usage crosses
 * 50%, 80%, or 90% of the cycle's allowance. Emails EVERY newly-crossed
 * threshold (so a single big call that jumps past several still sends each one,
 * not just the highest) and de-dupes via Profile.usageAlertsSent so a threshold
 * is never emailed twice in the same cycle. Marks a threshold sent only AFTER its
 * email succeeds, so a transient failure retries on the next call.
 * Best-effort — never throws into the call path.
 */
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

    // Email EVERY newly-crossed threshold, lowest first — if a single big call
    // jumps past several at once (e.g. 40% → 80%), the owner still gets the 50%
    // AND 80% alerts, not just the highest. Each email shows that threshold's own
    // minutes (e.g. 50% of a 5-min plan = 2.5 used) so its headline and figures
    // stay consistent. Mark a threshold sent only after its email succeeds, so a
    // transient failure retries it on the next call.
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

/**
 * For an ACTIVE paid plan whose included minutes are exhausted, renew the billing
 * cycle immediately: charge a fresh full period on the saved card, reset the
 * per-cycle minute counter, and restart the clock. A declined card flips the user
 * to past_due (blocked) until they fix payment. Best-effort, never throws.
 */
async function renewActivePlanIfExhausted(
  userId: string,
  stripeSubscriptionId: string,
  plan: { includedMinutes: number; displayName: string } | null,
  autoRenew: boolean,
  _now: Date,
): Promise<void> {
  // Auto-renew off → never auto-charge. The user stays blocked on exhausted
  // minutes (calls frozen) for the rest of the period; at period end Stripe
  // cancels the subscription (cancel_at_period_end) and they must pick a plan.
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

  // Safety net against a stale local flag: if the user cancelled in the Stripe
  // hosted portal but that webhook hasn't landed yet (it never reaches a local
  // dev server, and can lag in prod), the DB may still say autoRenew=true. Read
  // the live cancel state straight from Stripe before charging; if it's set to
  // cancel, honour that — sync the flag off and don't charge a cancelled card.
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

  // CLAIM the renewal before charging. `reconcileSubscription` runs from five
  // places — including `validateTrial`, which fires on EVERY gated API request —
  // so a dashboard load issuing parallel requests had several of them read
  // "minutes exhausted" at once and each call Stripe. That double-charged the
  // customer's card (observed: two renewals in the same minute).
  //
  // This UPDATE is atomic in Postgres: the `gte` predicate is re-evaluated after
  // the row lock, so exactly ONE concurrent caller matches and proceeds; the rest
  // see count 0 and bail. Usage is zeroed here rather than after the charge — a
  // failed charge flips the account to past_due (blocked) below, so a zeroed
  // counter can't hand out free minutes.
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
    // The early renewal consumed the cycle boundary the downgrade was pinned to,
    // so Stripe no longer holds it — drop our mirror of it too, or the UI keeps
    // showing a plan change that will never happen.
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
      // The claim above already zeroed the counter, so the usual "derive overage
      // from the stored usage" path would see 0. Pass the real overage across
      // explicitly, and state the reset — a paid renewal is always a new cycle.
      resetUsage: true,
      ...(overageSec > 0 ? { carryOverSeconds: overageSec } : {}),
    });
    // The invoice this renewal just settled. Read BEFORE the coupon cycle is
    // counted so it can key on the invoice id: this path anchors the new cycle at
    // "now", so a customer who burns their minutes twice in a day produces period
    // ends minutes apart, and the period-end window alone would discard the
    // second charge as a duplicate and never spend the discount's budget.
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
    // History for the admin timeline. Without this an early renewal left no trace
    // anywhere in the app — the only record was in Stripe, so a support question
    // like "why was I charged three times?" could not be answered from the admin
    // panel at all.
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

/* ------------------- Hosted-portal cancel mirror ------------------- *
 *  A cancel done in the Stripe hosted portal ("Manage billing") only touches
 *  Stripe: it sets cancel_at_period_end (the sub stays "active" until the
 *  period ends) or, for an immediate cancel, deletes the sub. The webhook
 *  mirrors both in production, but it can lag and NEVER reaches a local dev
 *  server — leaving the app showing auto-renew "On" and the admin panel
 *  showing a live subscription the user has already cancelled. So reconcile
 *  polls the live subscription (at most once per user per interval) and
 *  mirrors the cancel state onto the profile + plan history.                 */
const PORTAL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const lastPortalSyncAt = new Map<string, number>();

/**
 * Mirror the live Stripe cancel state onto the local profile. Returns the
 * fresh { status, autoRenew } (or the local snapshot when throttled/failed)
 * so the caller can gate on post-sync truth. Best-effort — never throws.
 */
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

/**
 * Reconcile a user's subscription with Stripe and auto-activate the paid plan
 * once their trial has ended. In local dev the Stripe webhook can't reach the
 * server, so an ended trial (date OR minutes) that should auto-charge the card
 * saved at signup isn't reflected — leaving the user wrongly blocked / sent
 * back to /subscribe. Here we read the live Stripe status: if the trial lapsed
 * we charge now and flip them to active (snapshotting the plan's minutes).
 * Best-effort, never throws. A no-op unless the local state is likely stale.
 */
/**
 * Convert a TRIALING user to their paid plan RIGHT NOW: end the Stripe trial so
 * the saved card is charged immediately, then flip the profile to the active plan
 * with a fresh full allowance. Used when a trial user goes live by claiming their
 * number — going live commits them to the plan they picked at onboarding, instead
 * of letting the trial run its course.
 *
 * Unlike reconcileSubscription (best-effort, silent), this THROWS a 400 on a
 * charge failure so the caller can refuse to assign the number and tell the user
 * to fix their card. A no-op — returns { converted: false } — for anyone who
 * isn't a trialing user with a live subscription (already active, past_due, no
 * sub, or a card-less trial), so a later number change never re-charges.
 *
 * Note: the charge is off-session. A card that needs authentication (3DS) fails
 * here; that surfaces as the card error and the number isn't assigned. A proper
 * on-session 3DS flow is a separate follow-up.
 */
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
      // Atomic: a declined / 3DS card throws here and LEAVES the trial intact, so
      // the user keeps their trial and can retry after fixing their card — instead
      // of the trial being destroyed and the account stranded in past_due.
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
    // Leave the account trialing on a charge failure — do NOT flip to past_due,
    // or a transient decline would freeze a user who still has trial left. The
    // number simply isn't assigned; they can fix their card and retry going live.
    throw badRequest(
      e instanceof Error && /card|declined|payment|incomplete|authentication/i.test(e.message)
        ? "We couldn't charge your saved card to activate your plan. Update your card and try again."
        : "We couldn't activate your plan right now. Please try again.",
    );
  }
}

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

  // Active plan that's burned through its included minutes before the period
  // date → renew the cycle NOW (charge a fresh full period, reset minutes) so the
  // user is never blocked. "Whichever limit hits first" — minutes here, the date
  // via Stripe's natural renewal webhook. Auto-renew off short-circuits this.
  if (profile.subscriptionStatus === "active") {
    // Safety net: a discount that outlived its cycle budget (a failed detach, or
    // a renewal webhook that never landed) would otherwise keep discounting
    // forever. Fail-open and best-effort, like the portal-cancel sync above.
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

  // Auto-renew off → don't convert the trial to a paid plan. The trial just lapses
  // (calls frozen); Stripe cancels at trial end (cancel_at_period_end) and the user
  // must pick a plan to unfreeze. No auto-charge.
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
      // Carry the trial OVERAGE (minutes used past the trial allowance, e.g. a
      // last call that ran on after auto-renew converted the trial) into the new
      // paid cycle — it lives in the trial counter, not the plan counter.
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
        // Reached only when a trialing/past_due account just went active — a real
        // new paid cycle, so grant the full allowance regardless of what period end
        // Stripe gave us.
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
      // Accrue the reseller's commission for the charge now (covers local dev,
      // where Stripe's invoice webhook never reaches us). Idempotent on the
      // invoice id, so the webhook won't double-count in production.
      if (inv) {
        await accrueCommissionForInvoice({
          invoiceId: inv.id,
          customerId: inv.customerId,
          amountPaidCents: inv.amountPaidCents,
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
