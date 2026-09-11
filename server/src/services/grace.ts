import { daysRemaining } from "./trial.js";

/* Post-trial grace period — the pure decision layer. `runGraceSweep` in
 * scheduler.ts owns the side effects (DB writes, emails, number release); this
 * module decides *what* should happen for one customer at one point in time, so
 * the rules can be unit-tested without mocking Stripe/Vapi/SMTP. */

const DAY_MS = 24 * 60 * 60 * 1000;

// Send the "nearing end" reminder once this many days are left (the final 24h
// warning is separate). For a 7-day window this lands ~5 days in.
export const GRACE_REMINDER_DAYS_BEFORE = 2;

// Monotonic email progression — a higher rank is "further along", so the sweep
// never re-sends an earlier nudge.
export const STAGE_RANK: Record<string, number> = { granted: 1, reminder: 2, final: 3 };
export const stageRank = (s: string | null): number => (s ? STAGE_RANK[s] ?? 0 : 0);

export type GraceAction =
  | { type: "noop" }
  /** Recharged / un-blocked while holding grace state → wipe it. */
  | { type: "clear" }
  /** A lapsed trial with a held number → open the grace window. */
  | { type: "start"; graceEndsAt: Date }
  /** Nearing the end → send the reminder email (once). */
  | { type: "reminder" }
  /** Inside the last 24h → send the final warning (once). */
  | { type: "final" }
  /** Window lapsed → release the number back to the pool. */
  | { type: "release" };

export interface GraceDecisionInput {
  /** Feature toggle (grace.enabled). */
  enabled: boolean;
  /** Configured grace length in days (grace.days). */
  days: number;
  /** Live entitlement: is the user blocked, and is the block a *trial* expiry? */
  blocked: boolean;
  isTrial: boolean;
  /** The paid plan has actually ENDED (canceled / period expired) — not merely
   *  run out of minutes mid-period. Lets grace cover paid churn, not just trials.
   *  Always false for a trial (that case is driven by `isTrial`). */
  planLapsed: boolean;
  /** Does the user currently hold a number worth reserving? */
  hasNumber: boolean;
  graceStartedAt: Date | null;
  graceEndsAt: Date | null;
  graceNotifyStage: string | null;
  now: Date;
}

/**
 * Decide the single action to take for one customer this sweep tick. Pure: same
 * inputs → same action. Mirrors the lifecycle — start → reminder → final →
 * release — and short-circuits to `clear` the moment the user is no longer
 * blocked (e.g. they paid).
 */
export function decideGraceAction(i: GraceDecisionInput): GraceAction {
  if (!i.enabled) return { type: "noop" };

  // No longer blocked (recharged / converted) → drop any in-flight grace state.
  if (!i.blocked) {
    return i.graceStartedAt || i.graceEndsAt ? { type: "clear" } : { type: "noop" };
  }

  // Not yet in grace → open it for any blocked account still holding a number:
  // a lapsed trial, OR a paid plan that has actually ended (canceled / expired).
  // A paid plan that only ran out of minutes mid-period is NOT lapsed — the user
  // still holds the month they paid for — so `planLapsed` guards that case out.
  if (!i.graceEndsAt) {
    if (!i.hasNumber) return { type: "noop" };
    if (!i.isTrial && !i.planLapsed) return { type: "noop" };
    return { type: "start", graceEndsAt: new Date(i.now.getTime() + i.days * DAY_MS) };
  }

  // Already in grace.
  const endMs = i.graceEndsAt.getTime();
  if (i.now.getTime() >= endMs) return { type: "release" };

  const msLeft = endMs - i.now.getTime();
  const daysLeft = daysRemaining(i.graceEndsAt, i.now);
  const stage = stageRank(i.graceNotifyStage);

  if (msLeft <= DAY_MS && stage < STAGE_RANK.final) return { type: "final" };
  if (daysLeft <= GRACE_REMINDER_DAYS_BEFORE && stage < STAGE_RANK.reminder) {
    return { type: "reminder" };
  }
  return { type: "noop" };
}
