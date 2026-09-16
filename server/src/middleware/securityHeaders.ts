import type { Request, Response, NextFunction } from "express";

/** Baseline security headers (nosniff, no framing, no Referer leaks of token-bearing URLs, HSTS).
 *  Hand-rolled instead of helmet: its CORP/COEP/CSP defaults would break the cross-origin SPA, audio streaming
 *  and the inline-styled public page. CORP/CSP belong wherever app HTML is served. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
}
