import { describe, it, expect, vi } from "vitest";
import { securityHeaders } from "./securityHeaders.js";

/** Minimal res double recording setHeader calls. */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    res: { setHeader: (k: string, v: string) => { headers[k] = v; } } as any,
    headers,
  };
}

describe("securityHeaders", () => {
  it("sets the baseline security headers and calls next", () => {
    const { res, headers } = makeRes();
    const next = vi.fn();

    securityHeaders({} as any, res, next);

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(headers["X-Permitted-Cross-Domain-Policies"]).toBe("none");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does NOT set a Cross-Origin-Resource-Policy (would break cross-origin API/audio)", () => {
    const { res, headers } = makeRes();
    securityHeaders({} as any, res, () => {});
    expect(headers["Cross-Origin-Resource-Policy"]).toBeUndefined();
  });
});
