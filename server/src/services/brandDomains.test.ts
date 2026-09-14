import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Brand } from "@prisma/client";

// Brand vanity domains: the records, the verify check, and the sweep. Pins that the routing
// record points at the FRONTEND edge only — the API stays on the platform's host for every brand.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  txt: vi.fn(),
  cname: vi.fn(),
  a: vi.fn(),
}));

vi.mock("../env.js", () => ({
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  // Both derive from PLATFORM_DOMAIN in the real module — see
  // domainVerifyNaming.test.ts, which pins that derivation.
  domainVerifyName: "_hello22-verify",
  domainVerifyValuePrefix: "hello22-verify",
  canonicalApiBaseUrl: "https://api.hello22.ai",
  publicApiBaseUrl: "https://api.hello22.ai",
  appBaseUrl: "https://app.hello22.ai",
  shareLinkBaseUrl: "https://agent.hello22.ai",
  corsOrigins: ["https://app.hello22.ai"],
  env: {
    JWT_SECRET: "test-secret-for-the-brand-domain-suite-xxxx",
    BRAND_CNAME_TARGET: "cname.vercel-dns.com",
    BRAND_APEX_IP: "76.76.21.21",
    DOMAIN_VERIFY_PREFIX: "_hello22-verify",
    // No host token: the edge half is skipped and DNS alone decides.
    VERCEL_API_TOKEN: "",
    VERCEL_PROJECT_ID: "",
    VERCEL_TEAM_ID: "",
  },
}));

vi.mock("../prisma.js", () => ({
  prisma: { brand: { findMany: h.findMany, update: h.update } },
}));

// brands.ts refreshes brand settings on load; none of that matters here.
vi.mock("./settings.js", () => ({
  getEffective: () => "",
  loadBrandSettings: vi.fn(async () => {}),
}));

// The public resolvers, stubbed: each test decides what the client published.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers() {}
    resolveTxt(name: string) {
      return h.txt(name);
    }
    resolveCname(name: string) {
      return h.cname(name);
    }
    resolve4(name: string) {
      return h.a(name);
    }
  },
}));

const {
  domainInstructions,
  pendingDomainCheck,
  verifyBrandDomain,
  sweepPendingDomains,
  verifyRecordName,
} = await import("./brandDomains.js");

function brand(over: Record<string, unknown> = {}): Brand {
  return {
    id: "b_acme",
    name: "Acme Voice",
    slug: "acme",
    customDomain: "app.acmevoice.com",
    domainStatus: "pending",
    domainToken: "abc123",
    domainVerifiedAt: null,
    domainCheckedAt: null,
    domainError: "",
    status: "active",
    logoLightUrl: "",
    logoDarkUrl: "",
    faviconUrl: "",
    themePreset: "emerald",
    primaryColor: "#059669",
    accentColor: "#10b981",
    fontFamily: "lora",
    fontStyle: "classic",
    darkModeDefault: false,
    tagline: "",
    supportEmail: "",
    supportPhone: "",
    createdById: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...over,
  } as unknown as Brand;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...brand(),
    ...data,
  }));
  // loadBrands() runs after every verification; an empty table is fine.
  h.findMany.mockResolvedValue([]);
});

describe("domainInstructions", () => {
  it("proves ownership by TXT first, then routes the subdomain to the edge by CNAME", () => {
    const records = domainInstructions(brand());
    // Ownership first: it changes nothing on the client's side, while the
    // routing record replaces whatever the name served before.
    expect(records.map((r) => r.type)).toEqual(["TXT", "CNAME"]);
    expect(records.map((r) => r.step)).toEqual([1, 2]);
    const [txt, cname] = records;
    // Registrar-shaped: the label in "Name", the whole thing alongside for the
    // providers that want it, and a TTL so the form has no blank column.
    expect(cname.name).toBe("app");
    expect(cname.fqdn).toBe("app.acmevoice.com");
    expect(cname.value).toBe("cname.vercel-dns.com");
    expect(cname.ttl).toMatch(/Auto/);
    expect(txt.fqdn).toBe("_hello22-verify.app.acmevoice.com");
    expect(txt.name).toBe("_hello22-verify.app");
    expect(txt.value).toBe("hello22-verify=abc123");
    expect(records.every((r) => r.required)).toBe(true);
    expect(records.every((r) => r.seen.length === 0)).toBe(true);
  });

  it("explains each record type in the client's words, not the RFC's", () => {
    const [txt, cname] = domainInstructions(brand());
    expect(txt.title).toBeTruthy();
    expect(txt.what).toMatch(/changes nothing/i);
    expect(cname.what).toMatch(/alias/i);
    expect(cname.what).toContain("app.acmevoice.com");
    for (const r of [txt, cname]) {
      expect(r.why).toBeTruthy();
      expect(`${r.what} ${r.why} ${r.notes.join(" ")}`).not.toMatch(/RFC/);
    }
    // The routing record carries the Cloudflare caveat; the TXT has nothing to warn about.
    expect(cname.notes.join(" ")).toMatch(/Cloudflare/);
    expect(txt.notes).toEqual([]);
  });

  it("never points anything at the API host — that stays on the platform", () => {
    for (const r of domainInstructions(brand())) {
      expect(r.value).not.toContain("api.hello22.ai");
    }
  });

  it("uses an A record at an apex, where CNAME is illegal, and warns what that replaces", () => {
    const records = domainInstructions(brand({ customDomain: "acmevoice.com" }));
    const routing = records.find((r) => r.step === 2)!;
    expect(routing.type).toBe("A");
    expect(routing.name).toBe("@");
    expect(routing.value).toBe("76.76.21.21");
    expect(routing.what).toMatch(/root domain cannot use a CNAME/i);
    expect(routing.notes.join(" ")).toMatch(/replaces whatever acmevoice\.com shows today/i);
    expect(routing.notes.join(" ")).toMatch(/ALIAS/);
    // The ownership TXT sits directly under the zone.
    expect(records.find((r) => r.step === 1)?.name).toBe("_hello22-verify");
  });

  it("hands back nothing for a brand with no vanity domain", () => {
    expect(domainInstructions(brand({ customDomain: null }))).toEqual([]);
  });
});

describe("verifyBrandDomain", () => {
  it("promotes the claim once the TXT proof and the CNAME both resolve", async () => {
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com."]);
    h.a.mockRejectedValue(new Error("ENODATA"));

    const check = await verifyBrandDomain(brand());

    expect(check.status).toBe("verified");
    expect(check.ownershipOk && check.routingOk && check.edgeOk).toBe(true);
    expect(check.records.every((r) => !r.required)).toBe(true);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b_acme" },
        data: expect.objectContaining({
          domainStatus: "verified",
          domainError: "",
          domainVerifiedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("finds our proof among other providers' tokens on the same TXT name", async () => {
    h.txt.mockResolvedValue([["google-site-verification=zzz"], ["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);
    expect((await verifyBrandDomain(brand())).ownershipOk).toBe(true);
  });

  it("stays pending — and says why — while the ownership TXT is missing", async () => {
    h.txt.mockResolvedValue([["some-other-provider=xyz"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);

    const check = await verifyBrandDomain(brand());

    expect(check.status).toBe("pending");
    expect(check.ownershipOk).toBe(false);
    expect(check.routingOk).toBe(true);
    expect(check.message).toContain(verifyRecordName("app.acmevoice.com"));
    // Only the outstanding record is still marked as work to do.
    expect(check.records.find((r) => r.type === "TXT")?.required).toBe(true);
    expect(check.records.find((r) => r.type === "CNAME")?.required).toBe(false);
  });

  it("does not trust a domain that resolves elsewhere, even with the proof in place", async () => {
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue([]);
    h.a.mockResolvedValue(["203.0.113.9"]);

    const check = await verifyBrandDomain(brand());

    expect(check.status).toBe("pending");
    expect(check.ownershipOk).toBe(true);
    expect(check.routingOk).toBe(false);
    expect(check.message).toContain("203.0.113.9");
    expect(check.message).toMatch(/^Step 2/);
    // "Wrong" reads differently from "missing": the record says where the
    // name currently lands, so the operator can tell the client what to change.
    expect(check.records.find((r) => r.type === "CNAME")?.seen).toEqual(["203.0.113.9"]);
    expect(check.records.find((r) => r.type === "TXT")?.seen).toEqual([]);
  });

  it("tells a stale token from a missing one", async () => {
    // A domain claimed, removed and claimed again keeps the old TXT in DNS.
    h.txt.mockResolvedValue([["hello22-verify=old-token"], ["google-site-verification=zzz"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);

    const check = await verifyBrandDomain(brand());

    expect(check.ownershipOk).toBe(false);
    expect(check.message).toMatch(/old value/i);
    expect(check.message).toContain(verifyRecordName("app.acmevoice.com"));
    // Only OUR stale value is reported — another provider's token is not the client's problem.
    expect(check.records.find((r) => r.type === "TXT")?.seen).toEqual(["hello22-verify=old-token"]);
  });

  it("flags a root domain so the panel can warn before the client's website is replaced", async () => {
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockRejectedValue(new Error("ENODATA"));
    h.a.mockResolvedValue(["76.76.21.21"]);

    const check = await verifyBrandDomain(brand({ customDomain: "acmevoice.com" }));

    expect(check.apex).toBe(true);
    expect(check.status).toBe("verified");
    expect((await verifyBrandDomain(brand())).apex).toBe(false);
  });

  it("accepts a provider that flattens the CNAME into our apex address", async () => {
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockRejectedValue(new Error("ENODATA"));
    h.a.mockResolvedValue(["76.76.21.21"]);
    expect((await verifyBrandDomain(brand())).status).toBe("verified");
  });

  it("keeps the original verifiedAt on a re-check of a live domain", async () => {
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);

    await verifyBrandDomain(
      brand({ domainStatus: "verified", domainVerifiedAt: new Date("2026-01-01T00:00:00Z") }),
    );

    const data = h.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.domainStatus).toBe("verified");
    expect("domainVerifiedAt" in data).toBe(false);
  });
});

describe("pendingDomainCheck", () => {
  it("reads a verified domain's records as done and a pending one's as outstanding", () => {
    expect(
      pendingDomainCheck(brand({ domainStatus: "verified" })).records.every((r) => !r.required),
    ).toBe(true);
    const pending = pendingDomainCheck(brand());
    expect(pending.records.every((r) => r.required)).toBe(true);
    expect(pending.apex).toBe(false);
    expect(pendingDomainCheck(brand({ customDomain: "acmevoice.com" })).apex).toBe(true);
    expect(pendingDomainCheck(brand({ customDomain: null })).apex).toBe(false);
  });
});

describe("sweepPendingDomains", () => {
  it("re-checks only pending claims and promotes the ones whose DNS has landed", async () => {
    h.findMany.mockResolvedValueOnce([brand()]); // the sweep's own query
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);

    const result = await sweepPendingDomains();

    expect(result).toEqual({ checked: 1, verified: 1 });
    expect(h.findMany).toHaveBeenCalledWith({
      where: { domainStatus: "pending", customDomain: { not: null } },
    });
  });

  it("carries on past a domain whose check blows up", async () => {
    h.findMany.mockResolvedValueOnce([
      brand({ id: "b_one", customDomain: "app.one.test" }),
      brand({ id: "b_two", customDomain: "app.two.test" }),
    ]);
    h.txt.mockResolvedValue([["hello22-verify=abc123"]]);
    h.cname.mockResolvedValue(["cname.vercel-dns.com"]);
    h.a.mockResolvedValue([]);
    h.update
      .mockImplementationOnce(async () => {
        throw new Error("db hiccup");
      })
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...brand(),
        ...data,
      }));

    const result = await sweepPendingDomains();

    expect(result).toEqual({ checked: 2, verified: 1 });
  });

  it("is a no-op with nothing pending", async () => {
    h.findMany.mockResolvedValueOnce([]);
    expect(await sweepPendingDomains()).toEqual({ checked: 0, verified: 0 });
    expect(h.txt).not.toHaveBeenCalled();
  });
});
