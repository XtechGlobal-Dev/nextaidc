/* ------------------------------------------------------------------ *
 *  What will cut a test call short, and how to describe it.
 *
 *  Two independent limits can end a browser test call:
 *
 *   • the account's remaining allowance (plan/trial minutes, plus a cycle of
 *     headroom when auto-renew is on — mirrors the server's remainingCallSeconds), and
 *   • the platform's per-call ceiling, an admin-owned abuse control that caps
 *     EVERY call regardless of how many minutes the account has left.
 *
 *  The server hands the browser a single `maxDurationSeconds` — already the
 *  lower of the two — so the client can't be told which one it is. It works that
 *  out by comparing against the allowance it computed itself. Getting this wrong
 *  is what put "Call time limit: 380:00" on screen for an account whose calls
 *  are capped at 2:00.
 * ------------------------------------------------------------------------- */

/** The two limits can be derived from entitlement snapshots taken moments apart
 *  and differ by a few seconds. A "ceiling" within a minute of the allowance
 *  isn't meaningfully what's cutting the call, so wording it as one would only
 *  mislead — only a clearly lower value counts as a ceiling. */
export const CEILING_MARGIN_SECONDS = 60;

/** The stricter of two limits, ignoring whichever isn't set. `null` on both
 *  sides means nothing will cut the call. */
export function tightest(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export interface CapInputs {
  /** `maxDurationSeconds` from the server-built assistant payload, or null when
   *  it hasn't been fetched yet / nothing caps the call. */
  serverCapSeconds: number | null;
  /** Seconds this account may still talk for, computed from the live entitlement. */
  allowanceSeconds: number | null;
  /** Running out of minutes renews the plan rather than stopping the service. */
  autoRenew: boolean;
}

/** Is a platform ceiling the thing that will actually cut the call, rather than
 *  the account simply running out of minutes? */
export function ceilingBinds({ serverCapSeconds, allowanceSeconds }: CapInputs): boolean {
  if (serverCapSeconds == null) return false;
  if (allowanceSeconds == null) return true; // unlimited account, but still capped per call
  return serverCapSeconds + CEILING_MARGIN_SECONDS <= allowanceSeconds;
}

/**
 * The cutoff to show BEFORE a call starts, and which of the two it is — "your
 * call is capped at 2:00" and "you have 2:00 of minutes left" are very different
 * messages and must not be worded alike.
 *
 * A per-call ceiling always applies, auto-renew or not. The allowance is only
 * worth showing when auto-renew is OFF: otherwise running out mid-call just
 * renews the plan, so a countdown is pure noise.
 *
 * `null` means say nothing.
 */
export function preCallCap(input: CapInputs): { seconds: number; kind: "limit" | "allowance" } | null {
  if (ceilingBinds(input)) return { seconds: input.serverCapSeconds!, kind: "limit" };
  if (!input.autoRenew && input.allowanceSeconds != null)
    return { seconds: input.allowanceSeconds, kind: "allowance" };
  return null;
}
