import type { Request, Response, NextFunction, RequestHandler } from "express";

/** The middleware, plus a small introspection hook: `size()` returns how many
 *  keys are currently tracked — used by tests to prove the sweep evicts, and
 *  handy for a metrics/health readout. */
export type RateLimiter = RequestHandler & { size(): number };

/**
 * Tiny in-memory fixed-window rate limiter. Keyed by client IP. Good enough for
 * a single-process API to blunt brute-force / abuse on public endpoints; swap
 * for a shared store if we ever run multiple instances.
 *
 * A background sweep evicts expired entries so the map can't grow without bound.
 * Without it, every distinct IP that ever hit the endpoint stays in memory
 * forever — a slow leak, and a fast one once a client can vary its IP (spoofed
 * X-Forwarded-For, or just a botnet), letting an attacker exhaust memory.
 */
export function rateLimit(opts: { windowMs: number; max: number; message?: string }): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodically drop entries whose window has closed. `unref()` so this timer
  // never keeps the process (or a test runner) alive on its own.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (now >= v.resetAt) hits.delete(k);
    }
  }, opts.windowMs);
  sweep.unref?.();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > opts.max) {
      return res
        .status(429)
        .json({ error: opts.message ?? "Too many requests, please try again later." });
    }
    next();
  };

  return Object.assign(middleware, { size: () => hits.size });
}
