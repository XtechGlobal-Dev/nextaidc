import type { TrialState, TrialStatus } from "@/types";

/** Semantic tone for a trial badge, mapped to the design tokens in index.css. */
export type TrialTone = "green" | "orange" | "red";

export interface BadgeContent {
  text: string;
  tone: TrialTone;
}

/** Tailwind classes (tint background + solid text) for each tone. */
export const TONE_CLASSES: Record<TrialTone, string> = {
  green: "bg-success-tint text-success",
  orange: "bg-warning-tint text-warning",
  red: "bg-danger-tint text-danger",
};

/** Solid fill color per tone — for dots and progress bars. */
export const TONE_FILL: Record<TrialTone, string> = {
  green: "bg-success",
  orange: "bg-warning",
  red: "bg-danger",
};

/** Solid text color per tone. */
export const TONE_TEXT: Record<TrialTone, string> = {
  green: "text-success",
  orange: "text-warning",
  red: "text-danger",
};

/**
 * Days-remaining badge. >5 days green, ≤5 orange, exactly 1 red, expired red.
 * `expired` short-circuits regardless of the day count.
 */
export function daysBadge(daysRemaining: number, expired: boolean): BadgeContent {
  if (expired || daysRemaining <= 0) return { text: "Trial Expired", tone: "red" };
  if (daysRemaining === 1) return { text: "Valid for 1 day", tone: "red" };
  const tone: TrialTone = daysRemaining > 5 ? "green" : "orange";
  return { text: `Valid for ${daysRemaining} days`, tone };
}

/**
 * Minutes-remaining badge by percent of quota left: >50% green, 25–50% orange,
 * <25% red, 0 shows "Trial Minutes Exhausted".
 */
export function minutesBadge(minutesRemaining: number, minutesAllocated: number): BadgeContent {
  if (minutesRemaining <= 0) return { text: "Trial Minutes Exhausted", tone: "red" };

  const pct = minutesAllocated > 0 ? (minutesRemaining / minutesAllocated) * 100 : 0;
  const tone: TrialTone = pct > 50 ? "green" : pct >= 25 ? "orange" : "red";
  const rounded = Math.round(minutesRemaining * 10) / 10;
  const unit = rounded === 1 ? "Minute" : "Minutes";
  return { text: `${rounded} ${unit} Left`, tone };
}

export const isTrialExpired = (status: TrialStatus): boolean => status !== "active";

export interface BlockedCopy {
  title: string;
  reason: string;
  cta: string;
}

/**
 * Headline + sub-line + CTA for a blocked entitlement, covering trial expiry,
 * plan-minute exhaustion, payment failure, and no-subscription. Returns null
 * when the user is not blocked.
 */
export function blockedCopy(state: TrialState): BlockedCopy | null {
  if (!state.blocked) return null;

  // During the post-trial grace window the number is still reserved — lead with
  // the "recharge to keep your number" urgency instead of the generic expiry copy.
  if (state.graceActive) {
    const d = state.graceDaysRemaining;
    const left = d <= 1 ? "less than a day" : `${d} days`;
    return {
      title: "Grace Period",
      reason: `${left} left to keep your number — recharge now or it'll be released`,
      cta: "Keep My Number",
    };
  }

  switch (state.status) {
    case "expired_minutes":
      return state.phase === "active"
        ? {
            title: "Plan Minutes Used Up",
            reason: "You've used all your plan minutes for this period",
            cta: "Renew Plan",
          }
        : { title: "Trial Expired", reason: "All trial minutes used", cta: "Renew Required" };
    case "expired_date":
      return state.phase === "active"
        ? {
            title: "Plan Expired",
            reason: "Your plan's billing period has ended",
            cta: "Renew Plan",
          }
        : { title: "Trial Expired", reason: "Trial Period Ended", cta: "Renew Required" };
    case "past_due":
      return { title: "Payment Failed", reason: "Update your card to continue", cta: "Fix Payment" };
    case "no_subscription":
      return { title: "No Active Plan", reason: "Choose a plan to start", cta: "Choose Plan" };
    default:
      return null;
  }
}

/** Convenience: derive both badges from a TrialState in one call. */
export function trialBadges(state: TrialState): { days: BadgeContent; minutes: BadgeContent } {
  return {
    days: daysBadge(state.daysRemaining, state.blocked),
    minutes: minutesBadge(state.minutesRemaining, state.minutesAllocated),
  };
}
