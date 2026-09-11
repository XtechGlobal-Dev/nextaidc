import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rateLimit } from "./rateLimit.js";

/* ------------------------------------------------------------------ *
 *  Fixed-window rate limiter.
 *
 *  Two things this guards, both reported as a DoS:
 *   1. Limiting is PER key (client IP). One IP hitting the cap must not affect
 *      another IP — the real-world break was every user collapsing onto the
 *      proxy's IP (fixed separately with `trust proxy`); here we prove the
 *      limiter itself is per-key so that fix is enough.
 *   2. The internal map is swept, so idle keys don't accumulate forever (the
 *      memory leak).
 * ------------------------------------------------------------------ */

/** Minimal Express req/res doubles. `res.status().json()` records the code. */
function makeReqRes(ip: string) {
  const res: { statusCode: number | null; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { req: { ip } as any, res: res as any };
}

/** Fire n requests from one ip through the limiter; return how many were allowed. */
function run(limiter: ReturnType<typeof rateLimit>, ip: string, n: number): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) {
    const { req, res } = makeReqRes(ip);
    limiter(req, res, () => {
      allowed += 1;
    });
    if (res.statusCode === 429) {
      // blocked
    }
  }
  return allowed;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("allows up to max, then blocks with 429", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const ip = "1.2.3.4";

    // First 3 pass.
    expect(run(limiter, ip, 3)).toBe(3);

    // 4th is blocked.
    const { req, res } = makeReqRes(ip);
    limiter(req, res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("counts each IP independently — one IP's flood can't lock out another", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });

    // Attacker IP blows through its budget.
    run(limiter, "9.9.9.9", 10);

    // A different user's IP still gets its full allowance.
    expect(run(limiter, "5.6.7.8", 3)).toBe(3);
  });

  it("resets after the window elapses", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2 });
    const ip = "1.1.1.1";

    expect(run(limiter, ip, 2)).toBe(2);
    // Blocked now.
    const blocked = makeReqRes(ip);
    limiter(blocked.req, blocked.res, () => {});
    expect(blocked.res.statusCode).toBe(429);

    // After the window, the budget is fresh again.
    vi.advanceTimersByTime(60_001);
    expect(run(limiter, ip, 2)).toBe(2);
  });

  it("sweeps expired entries so idle IPs don't accumulate forever", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 5 });

    // 100 one-shot IPs that never come back.
    for (let i = 0; i < 100; i++) run(limiter, `10.0.0.${i}`, 1);
    expect(limiter.size()).toBe(100);

    // After their windows close, the background sweep evicts every stale entry —
    // the map returns to empty instead of growing without bound (the leak).
    vi.advanceTimersByTime(120_001);
    expect(limiter.size()).toBe(0);

    // And the limiter is still fully functional afterwards.
    expect(run(limiter, "8.8.8.8", 5)).toBe(5);
    const over = makeReqRes("8.8.8.8");
    limiter(over.req, over.res, () => {});
    expect(over.res.statusCode).toBe(429);
  });
});
