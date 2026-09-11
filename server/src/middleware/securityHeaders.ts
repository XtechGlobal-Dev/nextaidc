import type { Request, Response, NextFunction } from "express";

/**
 * The recommended baseline HTTP security headers, set on every response.
 *
 * Kept as a tiny hand-rolled middleware rather than pulling in helmet, because
 * helmet's defaults (Cross-Origin-Resource-Policy: same-origin, COEP, a strict
 * CSP) would break this API's legitimate cross-origin use — the SPA on another
 * domain fetches JSON, streams TTS audio and call recordings, and the public
 * conversation page renders inline styles. We set the headers that are safe here
 * and leave CORP/CSP to the places that actually serve app HTML.
 *
 * - X-Content-Type-Options: nosniff  — don't let browsers MIME-sniff responses.
 * - X-Frame-Options: DENY            — this API / its pages are never framed
 *                                      (clickjacking protection).
 * - Referrer-Policy                  — don't leak full URLs (which can carry
 *                                      tokens) in the Referer header.
 * - Strict-Transport-Security        — force HTTPS for future requests. Safe on
 *                                      Render (TLS-terminated); harmless locally
 *                                      where browsers ignore HSTS on http/localhost.
 * - X-Permitted-Cross-Domain-Policies: none — no Flash/PDF cross-domain policy.
 * - X-DNS-Prefetch-Control: off      — don't prefetch DNS for linked hosts.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
}
