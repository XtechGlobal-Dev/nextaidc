import type { Request, Response, NextFunction, RequestHandler } from "express";

/** The middleware plus `size()` (tracked keys) so tests can prove the sweep evicts. */
export type RateLimiter = RequestHandler & { size(): number };

/** In-memory fixed-window limiter keyed by IP (single-process; swap for a shared store if we scale out).
 *  The sweep matters: without it every IP ever seen stays forever, and a botnet can exhaust memory. */
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
