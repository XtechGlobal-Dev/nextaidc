import { describe, it, expect } from "vitest";
import { preCallCap, tightest, CEILING_MARGIN_SECONDS } from "./callCap";

/* ------------------------------------------------------------------ *
 *  The test-call dialog used to announce "Call time limit: 380:00" while
 *  connecting, then snap to "2:00" the instant the call went live — the first
 *  number was the account's own allowance (179 minutes left + a 200-minute
 *  auto-renew cycle of headroom), shown before the server's per-call ceiling
 *  had been read. Both numbers were real; only one of them ever ends the call.
 * ------------------------------------------------------------------------- */

/** The reported account: Starter, 21 of 200 minutes used, admin cap 2 minutes. */
const REPORTED = {
  serverCapSeconds: 120,
  allowanceSeconds: Math.floor((179 + 200) * 60), // 22,740s ≈ "380:00"
  autoRenew: true,
};

describe("preCallCap", () => {
  it("announces the 2-minute ceiling, not the 380 minutes of allowance", () => {
    expect(preCallCap(REPORTED)).toEqual({ seconds: 120, kind: "limit" });
  });

  it("shows the same number before the call as during it", () => {
    // What the call is actually stamped with, per begin().
    const stamped = tightest(REPORTED.serverCapSeconds, REPORTED.allowanceSeconds);
    expect(preCallCap(REPORTED)?.seconds).toBe(stamped);
  });

  it("says nothing while the ceiling is still unknown, rather than guessing", () => {
    // Warm-up hasn't landed yet — the old code filled the gap with the
    // allowance, which is exactly the number that turned out to be wrong.
    expect(preCallCap({ ...REPORTED, serverCapSeconds: null })).toBeNull();
  });

  it("caps an unlimited account too — the ceiling is an abuse control", () => {
    expect(preCallCap({ serverCapSeconds: 120, allowanceSeconds: null, autoRenew: true })).toEqual({
      seconds: 120,
      kind: "limit",
    });
  });

  it("stays quiet on an auto-renew account with no ceiling in force", () => {
    // Running out just renews the plan mid-call, so a countdown is pure noise —
    // and with no ceiling the server's number IS the allowance.
    expect(
      preCallCap({ serverCapSeconds: 22_740, allowanceSeconds: 22_740, autoRenew: true }),
    ).toBeNull();
  });

  it("calls it an allowance, not a limit, when auto-renew is off", () => {
    expect(
      preCallCap({ serverCapSeconds: 600, allowanceSeconds: 600, autoRenew: false }),
    ).toEqual({ seconds: 600, kind: "allowance" });
  });

  it("ignores a few seconds of drift between two entitlement snapshots", () => {
    // Both sides are the same limit read moments apart; calling that a per-call
    // "limit" would put a wrong-looking word next to a right-looking number.
    expect(
      preCallCap({ serverCapSeconds: 22_735, allowanceSeconds: 22_740, autoRenew: false }),
    ).toEqual({ seconds: 22_740, kind: "allowance" });
  });

  it("treats a ceiling a clear margin below the allowance as binding", () => {
    const allowance = 22_740;
    expect(
      preCallCap({
        serverCapSeconds: allowance - CEILING_MARGIN_SECONDS,
        allowanceSeconds: allowance,
        autoRenew: false,
      })?.kind,
    ).toBe("limit");
  });
});

describe("tightest", () => {
  it("takes the stricter limit", () => {
    expect(tightest(120, 22_740)).toBe(120);
    expect(tightest(22_740, 120)).toBe(120);
  });

  it("ignores a limit that isn't set, and yields null when neither is", () => {
    expect(tightest(null, 120)).toBe(120);
    expect(tightest(120, null)).toBe(120);
    expect(tightest(null, null)).toBeNull();
  });
});
