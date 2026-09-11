import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import {
  applyCallDurationCap,
  WRAP_UP_LEAD_SECONDS,
  DEFAULT_MAX_CALL_SECONDS,
  MIN_MAX_CALL_SECONDS,
} from "./callDurationCap.js";
import { scheduleWrapUp, cancelWrapUp, pendingWrapUpCount } from "./callWrapUp.js";

/* The ceiling is an abuse control layered on top of each customer's own minute
 * budget. Getting the direction wrong would either stop capping abusers or start
 * cutting paying customers early, and neither shows up until a live call. */

describe("applyCallDurationCap", () => {
  const on = { enabled: true, seconds: 300 };
  const off = { enabled: false, seconds: 300 };

  it("caps an unlimited plan — that's exactly the account worth abusing", () => {
    expect(applyCallDurationCap(null, on)).toBe(300);
  });

  it("leaves an unlimited plan alone when the ceiling is off", () => {
    expect(applyCallDurationCap(null, off)).toBeNull();
  });

  it("only ever lowers, never raises, a customer's own limit", () => {
    // Three minutes left must stay three minutes — the ceiling is not an
    // allowance to top anyone up to.
    expect(applyCallDurationCap(180, on)).toBe(180);
    expect(applyCallDurationCap(900, on)).toBe(300);
  });

  it("passes the entitlement straight through when disabled", () => {
    expect(applyCallDurationCap(900, off)).toBe(900);
    expect(applyCallDurationCap(180, off)).toBe(180);
  });

  it("keeps a blocked user's near-zero cap", () => {
    // remainingCallSeconds returns Vapi's 10s floor for a blocked account; the
    // ceiling must not hand them five minutes.
    expect(applyCallDurationCap(10, on)).toBe(10);
  });

  it("is reversible — switching the ceiling off returns an unlimited plan to uncapped", () => {
    // The value that comes back must be null, not the old ceiling: the sync layer
    // keys off null to write Vapi's maximum back and release the assistant. If
    // this returned a number, turning the feature off would be a one-way door.
    const wasCapped = applyCallDurationCap(null, on);
    expect(wasCapped).toBe(300);
    expect(applyCallDurationCap(null, off)).toBeNull();
  });

  it("lowering the ceiling takes effect for an already-capped account", () => {
    // 5 min → 2 min must actually re-derive from the entitlement, not from the
    // previously stamped value.
    expect(applyCallDurationCap(null, { enabled: true, seconds: 120 })).toBe(120);
    expect(applyCallDurationCap(900, { enabled: true, seconds: 120 })).toBe(120);
  });

  it("leaves room to warn before the shortest ceiling an admin can set", () => {
    expect(WRAP_UP_LEAD_SECONDS).toBeLessThan(MIN_MAX_CALL_SECONDS);
    expect(DEFAULT_MAX_CALL_SECONDS).toBeGreaterThan(WRAP_UP_LEAD_SECONDS);
  });
});

describe("scheduleWrapUp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cancelWrapUp("call-1");
    cancelWrapUp("call-2");
  });

  const args = (over: Record<string, unknown> = {}) => ({
    callId: "call-1",
    controlUrl: "https://control.vapi.ai/call-1",
    capSeconds: 300,
    ...over,
  });

  it("fires the wrap-up one lead window before the cap, not at it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    scheduleWrapUp(args());
    // A second before it is due, nothing has been said.
    await vi.advanceTimersByTimeAsync((300 - WRAP_UP_LEAD_SECONDS - 1) * 1000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://control.vapi.ai/call-1");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.type).toBe("add-message");
    expect(body.message.role).toBe("system");
    // Silent insertion would only be seen on the model's next turn, which may
    // never come while the caller is talking.
    expect(body.triggerResponseEnabled).toBe(true);
  });

  it("tells the agent to close without naming limits, minutes or the instruction", () => {
    // The caller must never hear that a timer ran out — that is the business's
    // internal abuse control, not their problem.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args());
    vi.advanceTimersByTime(300 * 1000);
    // Assert on the instruction the model receives, since that is what shapes
    // what the caller actually hears.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message.content).toMatch(/do not mention time limits/i);
    expect(body.message.content).toMatch(/close/i);
  });

  it("does nothing when the call has no cap — an uncapped call never gets cut", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args({ capSeconds: null }));
    vi.advanceTimersByTime(3600 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without a control url", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args({ controlUrl: null }));
    vi.advanceTimersByTime(3600 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays silent when the webhook arrives so late the window has already passed", () => {
    // Speaking now would talk over a caller mid-sentence for no benefit — the
    // hard cap is a moment away regardless.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args({ startedAt: new Date(Date.now() - 290_000) }));
    vi.advanceTimersByTime(3600 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("measures the delay from the call's start, not from when the webhook landed", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    // 60s already elapsed → 300-30-60 = 210s left, not 270s.
    scheduleWrapUp(args({ startedAt: new Date(Date.now() - 60_000) }));
    vi.advanceTimersByTime(209 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeated status-update for a call already scheduled", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args());
    scheduleWrapUp(args());
    scheduleWrapUp(args());
    vi.advanceTimersByTime(300 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a call that ended on its own first", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args());
    expect(pendingWrapUpCount()).toBe(1);
    cancelWrapUp("call-1");
    expect(pendingWrapUpCount()).toBe(0);
    vi.advanceTimersByTime(3600 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps other calls' timers when one is cancelled", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args());
    scheduleWrapUp(args({ callId: "call-2", controlUrl: "https://control.vapi.ai/call-2" }));
    cancelWrapUp("call-1");
    vi.advanceTimersByTime(300 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://control.vapi.ai/call-2");
  });

  it("survives Vapi rejecting the nudge — the hard cap still ends the call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "gone" });
    vi.stubGlobal("fetch", fetchMock);
    scheduleWrapUp(args());
    await expect(vi.advanceTimersByTimeAsync(300 * 1000)).resolves.not.toThrow();
    expect(pendingWrapUpCount()).toBe(0);
  });
});
