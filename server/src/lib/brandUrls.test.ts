import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Where a brand's links point.
 *
 *  The rule under test: a brand's domain serves the APP, and only the
 *  app. Login links, portal returns and OAuth bounces go to the brand;
 *  the conversation link in a call-summary SMS — a page the API serves —
 *  stays on the platform's share host for every tenant, and the API
 *  origin is one host for all of them.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../env.js", () => ({
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.hello22.ai",
  publicApiBaseUrl: "https://api.hello22.ai",
  appBaseUrl: "https://app.hello22.ai",
  shareLinkBaseUrl: "https://agent.hello22.ai",
  corsOrigins: ["https://app.hello22.ai"],
  platformSubdomainHost: (slug: string) => `${slug}.hello22.ai`,
  platformSubdomainUrl: (slug: string) => `https://${slug}.hello22.ai`,
  env: { JWT_SECRET: "test-secret-for-the-brand-urls-suite-xxxxx" },
}));
vi.mock("../prisma.js", () => ({ prisma: { brand: { findMany: h.findMany } } }));
vi.mock("../services/settings.js", () => ({
  getEffective: () => "",
  loadBrandSettings: vi.fn(async () => {}),
}));

const { loadBrands } = await import("../services/brands.js");
const { runWithBrand } = await import("./brandContext.js");
const {
  brandAppOrigin,
  brandAppUrl,
  brandShareOrigin,
  brandDisplayName,
  isAllowedReturnOrigin,
  platformApiOrigin,
} = await import("./brandUrls.js");

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

async function load(...rows: ReturnType<typeof brand>[]) {
  h.findMany.mockResolvedValue(rows);
  await loadBrands();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("brandAppOrigin / brandAppUrl", () => {
  it("is the platform's app when no brand is ambient", async () => {
    await load();
    expect(brandAppOrigin()).toBe("https://app.hello22.ai");
    expect(brandAppUrl("/login")).toBe("https://app.hello22.ai/login");
    expect(brandAppUrl("login")).toBe("https://app.hello22.ai/login");
  });

  it("is the brand's subdomain while its vanity domain is still pending", async () => {
    // A link to a hostname whose DNS the client hasn't published would be dead
    // on arrival; the subdomain is live from the moment the brand exists.
    await load(brand({ customDomain: "app.acmevoice.com", domainStatus: "pending" }));
    runWithBrand("b_acme", () => {
      expect(brandAppOrigin()).toBe("https://acme.hello22.ai");
      expect(brandAppUrl("/dashboard/settings")).toBe("https://acme.hello22.ai/dashboard/settings");
    });
  });

  it("switches to the vanity domain once it is verified", async () => {
    await load(brand({ customDomain: "app.acmevoice.com", domainStatus: "verified" }));
    runWithBrand("b_acme", () => {
      expect(brandAppOrigin()).toBe("https://app.acmevoice.com");
    });
  });

  it("takes an explicit brand over the ambient one, and null to mean the platform", async () => {
    await load(brand());
    runWithBrand("b_acme", () => {
      expect(brandAppOrigin("b_acme")).toBe("https://acme.hello22.ai");
      expect(brandAppOrigin(null)).toBe("https://app.hello22.ai");
    });
    expect(brandAppOrigin("b_acme")).toBe("https://acme.hello22.ai");
  });
});

describe("brandShareOrigin", () => {
  it("stays on the platform's share host even for a brand with a live domain", async () => {
    await load(brand({ customDomain: "app.acmevoice.com", domainStatus: "verified" }));
    runWithBrand("b_acme", () => {
      // The /c/* page is served by the API, which is never on the brand's domain…
      expect(brandShareOrigin()).toBe("https://agent.hello22.ai");
      // …while the app links for the very same brand DO use its domain.
      expect(brandAppOrigin()).toBe("https://app.acmevoice.com");
    });
  });
});

describe("platformApiOrigin", () => {
  it("is one host for every tenant", async () => {
    await load(brand({ customDomain: "app.acmevoice.com", domainStatus: "verified" }));
    runWithBrand("b_acme", () => expect(platformApiOrigin()).toBe("https://api.hello22.ai"));
    expect(platformApiOrigin()).toBe("https://api.hello22.ai");
  });
});

describe("brandDisplayName", () => {
  it("is the brand's name inside a brand and the platform's outside", async () => {
    await load(brand());
    runWithBrand("b_acme", () => expect(brandDisplayName()).toBe("Acme Voice"));
    expect(brandDisplayName()).toBe("hello22.ai");
  });
});

describe("isAllowedReturnOrigin", () => {
  it("accepts only an exact https origin from the allow-list", () => {
    const allowed = ["https://app.acmevoice.com", "https://app.hello22.ai", "not-a-url"];
    expect(isAllowedReturnOrigin("https://app.acmevoice.com", allowed)).toBe(true);
    expect(isAllowedReturnOrigin("https://APP.acmevoice.com/", allowed)).toBe(true);
    // The open-redirect shapes this exists to refuse.
    expect(isAllowedReturnOrigin("https://app.acmevoice.com.attacker.com", allowed)).toBe(false);
    expect(isAllowedReturnOrigin("https://attacker.com/app.acmevoice.com", allowed)).toBe(false);
    expect(isAllowedReturnOrigin("http://app.acmevoice.com", allowed)).toBe(false);
    expect(isAllowedReturnOrigin("javascript:alert(1)", allowed)).toBe(false);
    expect(isAllowedReturnOrigin("not a url", allowed)).toBe(false);
  });

  it("lets plain-http localhost through for local development", () => {
    expect(isAllowedReturnOrigin("http://localhost:5174", ["http://localhost:5174"])).toBe(true);
  });
});
