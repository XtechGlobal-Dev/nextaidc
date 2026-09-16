// Which limit cuts a test call short: the account's remaining allowance or the platform's per-call ceiling.
// The server sends one `maxDurationSeconds` (the lower), so we tell them apart by comparing to our own allowance.

/** The two limits come from snapshots moments apart and can differ by seconds; only a clearly lower value counts as a ceiling. */
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

/** Pre-call cutoff and which kind it is ("capped at 2:00" vs "2:00 left" must not read alike). The allowance
 *  is only shown when auto-renew is off, since running out otherwise just renews. `null` = say nothing. */
export function preCallCap(input: CapInputs): { seconds: number; kind: "limit" | "allowance" } | null {
  if (ceilingBinds(input)) return { seconds: input.serverCapSeconds!, kind: "limit" };
  if (!input.autoRenew && input.allowanceSeconds != null)
    return { seconds: input.allowanceSeconds, kind: "allowance" };
  return null;
}
