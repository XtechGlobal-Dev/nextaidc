import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Brand host resolution + theme validation.
 *
 *  Host → brand runs on EVERY request and decides which tenant a
 *  visitor sees and which sender their mail goes out as, so the edges
 *  (apex domain, localhost, a suspended brand, an unknown label) are
 *  worth pinning down.
 * ------------------------------------------------------------------ */

// This file imports the REAL env.ts (unlike its sibling *.test.ts files, which
// mock it), so the apex resolveBrandForHost checks host names against has to
// be set explicitly rather than assumed — env.ts derives it from deployment
// config instead of hardcoding a brand's own domain as the default.
process.env.PLATFORM_DOMAIN ||= "test-platform.example";

const h = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../prisma.js", () => ({
  prisma: { brand: { findMany: h.findMany }, brandSetting: { findMany: vi.fn(async () => []) } },
}));

const { loadBrands, resolveBrandForHost, publicBrand, cachedBrand } = await import("./brands.js");
const { normalizeSlug, slugProblem, COLOR_PRESETS, FONTS, findFont } = await import(
  "../lib/brandTheme.js"
);

function brand(over: Record<string, unknown> = {}) {
  return {
    id: "b_acme",
    name: "Acme Voice",
    slug: "acme",
    customDomain: null,
    domainStatus: "none",
    domainToken: "",
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
  };
}

describe("resolveBrandForHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches the leading label of a platform subdomain", async () => {
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    expect(resolveBrandForHost("acme.test-platform.example")?.id).toBe("b_acme");
  });

  it("ignores the port and case in the Host header", async () => {
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    expect(resolveBrandForHost("ACME.test-platform.example:4000")?.id).toBe("b_acme");
  });

  it("matches an exact custom domain once it is verified", async () => {
    h.findMany.mockResolvedValue([
      brand({ customDomain: "acmevoice.com", domainStatus: "verified" }),
    ]);
    await loadBrands();
    expect(resolveBrandForHost("acmevoice.com")?.id).toBe("b_acme");
  });

  it("ignores a claimed domain the client hasn't proven yet", async () => {
    // This map feeds CORS and the Origin fallback: an unverified entry would
    // admit a page on a domain the tenant merely typed in, not one it controls.
    h.findMany.mockResolvedValue([
      brand({ customDomain: "acmevoice.com", domainStatus: "pending" }),
    ]);
    await loadBrands();
    expect(resolveBrandForHost("acmevoice.com")).toBeNull();
    // The subdomain keeps working regardless — that is the whole point of it.
    expect(resolveBrandForHost("acme.test-platform.example")?.id).toBe("b_acme");
  });

  it("returns null for the platform's own host and for unknown labels", async () => {
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    expect(resolveBrandForHost("test-platform.example")).toBeNull();
    expect(resolveBrandForHost("other.test-platform.example")).toBeNull();
  });

  it("resolves a brand subdomain on the dev loopback apex", async () => {
    // Outside production `localhost` is an apex too, so a brand's own front
    // door can be opened locally. Without it every request from
    // acme.localhost fell through to the platform, and anyone signing up
    // there was created as a PLATFORM customer instead of the brand's.
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    expect(resolveBrandForHost("acme.localhost")?.id).toBe("b_acme");
    expect(resolveBrandForHost("acme.localhost:5174")?.id).toBe("b_acme");
    // Still only one label deep, and still nothing for an unknown label.
    expect(resolveBrandForHost("a.acme.localhost")).toBeNull();
    expect(resolveBrandForHost("other.localhost")).toBeNull();
  });

  it("never treats a dotless host as a brand", async () => {
    // Otherwise a brand slugged "localhost" would hijack every local request.
    h.findMany.mockResolvedValue([brand({ slug: "localhost" })]);
    await loadBrands();
    expect(resolveBrandForHost("localhost")).toBeNull();
  });

  it("stops resolving a suspended brand's front door", async () => {
    h.findMany.mockResolvedValue([brand({ status: "suspended" })]);
    await loadBrands();
    expect(resolveBrandForHost("acme.test-platform.example")).toBeNull();
    // …but the record is still cached, so admin screens can still show it.
    expect(cachedBrand("b_acme")?.name).toBe("Acme Voice");
  });

  it("keeps the previous snapshot when the DB read fails", async () => {
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    h.findMany.mockRejectedValue(new Error("connection lost"));
    await loadBrands();
    expect(resolveBrandForHost("acme.test-platform.example")?.id).toBe("b_acme");
  });
});

describe("publicBrand", () => {
  it("resolves the font id to a full CSS stack and Google family", () => {
    const pub = publicBrand(brand() as never);
    expect(pub.theme.fontStack).toContain("Lora");
    expect(pub.theme.googleFamily).toBe("Lora");
    expect(pub.theme.primaryColor).toBe("#059669");
  });

  it("falls back to the default font when the stored id is unknown", () => {
    const pub = publicBrand(brand({ fontFamily: "comic-papyrus" }) as never);
    expect(pub.theme.fontFamily).toBe("inter");
  });

  it("carries nothing secret", () => {
    const pub = publicBrand(brand() as never);
    expect(JSON.stringify(pub)).not.toMatch(/token|secret|password|apiKey/i);
  });
});

describe("subdomain rules", () => {
  it("normalises what a person types into a valid label", () => {
    expect(normalizeSlug("  Acme Voice!! ")).toBe("acme-voice");
    expect(normalizeSlug("--Acme--")).toBe("acme");
  });

  it("refuses reserved, too-short and malformed labels", () => {
    expect(slugProblem("www")).toMatch(/reserved/i);
    expect(slugProblem("api")).toMatch(/reserved/i);
    expect(slugProblem("ab")).toMatch(/at least 3/i);
    expect(slugProblem("-acme")).toMatch(/hyphen/i);
    expect(slugProblem("a".repeat(41))).toMatch(/40 characters/i);
  });

  it("accepts an ordinary brand label", () => {
    expect(slugProblem("acme-voice")).toBeNull();
  });
});

describe("theme catalog", () => {
  it("offers colour presets with unique ids and hex pairs", () => {
    expect(COLOR_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(COLOR_PRESETS.map((p) => p.id)).size).toBe(COLOR_PRESETS.length);
    for (const p of COLOR_PRESETS) {
      expect(p.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("offers both a business and a classic font family", () => {
    expect(FONTS.filter((f) => f.group === "business").length).toBeGreaterThan(0);
    expect(FONTS.filter((f) => f.group === "classic").length).toBeGreaterThan(0);
    expect(new Set(FONTS.map((f) => f.id)).size).toBe(FONTS.length);
  });

  it("gives every font a fallback beyond its web face", () => {
    // A brand whose web font fails to load must still render in something sane.
    for (const f of FONTS) {
      expect(f.stack.split(",").length).toBeGreaterThan(1);
      expect(findFont(f.id)).toBeTruthy();
    }
  });
});
