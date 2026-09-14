// The verify record a client publishes must carry THIS deployment's name, derived
// from PLATFORM_DOMAIN — nothing hardcoded that could leak the original domain.

// env.ts validates at import and exits if these are missing, so set them before
// the dynamic import below.
process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
process.env.JWT_SECRET ||= "test-secret-at-least-thirty-two-characters-long";
process.env.PLATFORM_DOMAIN = "peelcases.com";
process.env.DOMAIN_VERIFY_PREFIX = "";

import { describe, it, expect, vi } from "vitest";

const { domainVerifyName, domainVerifyValuePrefix, platformDomain } = await import("../env.js");

describe("ownership record naming", () => {
  it("names both halves after the platform's own domain", () => {
    expect(platformDomain).toBe("peelcases.com");
    expect(domainVerifyName).toBe("_peelcases-verify");
    expect(domainVerifyValuePrefix).toBe("peelcases-verify");
  });

  it("gives a client a record with no trace of another platform's name", () => {
    // The exact pair the Domain panel prints:
    //   _peelcases-verify.app.client.com  TXT  peelcases-verify=<token>
    const fqdn = `${domainVerifyName}.app.client.com`;
    const value = `${domainVerifyValuePrefix}=abc123`;
    for (const shown of [fqdn, value]) {
      expect(shown).not.toMatch(/hello22|h22-/);
    }
    expect(fqdn).toBe("_peelcases-verify.app.client.com");
    expect(value).toBe("peelcases-verify=abc123");
  });
});

describe("PLATFORM_DOMAIN left unset", () => {
  it("falls back to the literal 'localhost', never a guess at a real domain", async () => {
    // Deriving from APP_URL was tried and reverted: no reliable way to get the
    // registrable apex without a public-suffix list, and a wrong apex breaks tenant routing.
    vi.resetModules();
    delete process.env.PLATFORM_DOMAIN;
    process.env.APP_URL = "https://agent.a-totally-different-client.com";
    const fresh = await import("../env.js");
    expect(fresh.platformDomain).toBe("localhost");
    expect(fresh.domainVerifyName).toBe("_localhost-verify");
  });
});

describe("a brand's platform subdomain on the loopback apex", () => {
  it("carries the dev frontend's port — a bare host has nothing listening on it", async () => {
    vi.resetModules();
    delete process.env.PLATFORM_DOMAIN;
    delete process.env.APP_URL;
    process.env.CORS_ORIGIN = "http://app.localhost:5174";
    const fresh = await import("../env.js");
    expect(fresh.platformSubdomainHost("acme")).toBe("acme.localhost:5174");
    expect(fresh.platformSubdomainUrl("acme")).toBe("http://acme.localhost:5174");
  });

  it("carries no port, and uses https, once a real apex is configured", async () => {
    vi.resetModules();
    process.env.PLATFORM_DOMAIN = "peelcases.com";
    process.env.CORS_ORIGIN = "http://app.localhost:5174";
    const fresh = await import("../env.js");
    expect(fresh.platformSubdomainHost("acme")).toBe("acme.peelcases.com");
    expect(fresh.platformSubdomainUrl("acme")).toBe("https://acme.peelcases.com");
  });

  it("never adds a port in production, even on an explicit localhost apex", async () => {
    vi.resetModules();
    process.env.PLATFORM_DOMAIN = "localhost";
    process.env.CORS_ORIGIN = "http://app.localhost:5174";
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const fresh = await import("../env.js");
      expect(fresh.platformSubdomainHost("acme")).toBe("acme.localhost");
      expect(fresh.platformSubdomainUrl("acme")).toBe("https://acme.localhost");
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
