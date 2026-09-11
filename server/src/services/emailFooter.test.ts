import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  The email footer names the TENANT — its legal entity, its address,
 *  its policies — when a brand has set them, and says nothing about
 *  them otherwise. A compliance line that quietly showed the platform's
 *  details on a white-label send would be the worst kind of leak.
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
  env: { JWT_SECRET: "test-secret-for-the-email-footer-suite-xxxx" },
}));
vi.mock("../prisma.js", () => ({ prisma: { brand: { findMany: h.findMany } } }));
vi.mock("./settings.js", () => ({
  getEffective: () => "",
  loadBrandSettings: vi.fn(async () => {}),
}));

const { loadBrands } = await import("./brands.js");
const { runWithBrand } = await import("../lib/brandContext.js");
const { emailGlobals, defaultFooterHtml, legalFooterHtml, GLOBAL_VARS } = await import(
  "./emailTemplates.js"
);

function brand(over: Record<string, unknown> = {}) {
  return {
    id: "b_acme",
    name: "Acme Voice",
    slug: "acme",
    customDomain: null,
    domainStatus: "none",
    status: "active",
    supportEmail: "help@acmevoice.com",
    legalName: "",
    legalAddress: "",
    termsUrl: "",
    privacyUrl: "",
    websiteUrl: "",
    themePreset: "ocean",
    primaryColor: "#2c76ed",
    accentColor: "#7c5cfc",
    fontFamily: "inter",
    fontStyle: "business",
    darkModeDefault: false,
    tagline: "",
    supportPhone: "",
    logoLightUrl: "",
    logoDarkUrl: "",
    faviconUrl: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("emailGlobals", () => {
  it("exposes every legal field as a template variable", () => {
    for (const key of ["legal_name", "legal_address", "terms_url", "privacy_url", "website_url"]) {
      expect(GLOBAL_VARS).toContain(key);
    }
  });

  it("is blank for the platform and filled inside a brand that set them", async () => {
    h.findMany.mockResolvedValue([
      brand({
        legalName: "Acme Voice Pty Ltd",
        legalAddress: "12 Example St, Sydney NSW 2000",
        termsUrl: "https://acmevoice.com/terms",
        privacyUrl: "https://acmevoice.com/privacy",
        websiteUrl: "https://acmevoice.com",
      }),
    ]);
    await loadBrands();

    expect(emailGlobals().legal_name).toBe("");
    runWithBrand("b_acme", () => {
      const g = emailGlobals();
      expect(g.app_name).toBe("Acme Voice");
      expect(g.support_email).toBe("help@acmevoice.com");
      expect(g.legal_name).toBe("Acme Voice Pty Ltd");
      expect(g.terms_url).toBe("https://acmevoice.com/terms");
    });
  });
});

describe("defaultFooterHtml", () => {
  it("signs the © line with the legal entity and lists the policies inside a brand", async () => {
    h.findMany.mockResolvedValue([
      brand({
        legalName: "Acme Voice Pty Ltd",
        legalAddress: "12 Example St, Sydney NSW 2000",
        termsUrl: "https://acmevoice.com/terms",
        privacyUrl: "https://acmevoice.com/privacy",
      }),
    ]);
    await loadBrands();
    runWithBrand("b_acme", () => {
      const html = defaultFooterHtml();
      expect(html).toContain("Acme Voice Pty Ltd. All rights reserved.");
      expect(html).toContain("12 Example St, Sydney NSW 2000");
      expect(html).toContain('href="https://acmevoice.com/terms"');
      expect(html).toContain('href="https://acmevoice.com/privacy"');
      expect(html).not.toContain("Website");
      // The unsubscribe marker survives, so notification mails still get it.
      expect(html).toContain("{{unsubscribe}}");
    });
  });

  it("falls back to the product name and omits the legal block when nothing is set", async () => {
    h.findMany.mockResolvedValue([brand()]);
    await loadBrands();
    runWithBrand("b_acme", () => {
      const html = defaultFooterHtml();
      expect(html).toContain("Acme Voice. All rights reserved.");
      expect(html).not.toContain("Terms");
      expect(html).not.toContain("Privacy");
    });
  });

  it("escapes what the brand typed", () => {
    const html = legalFooterHtml({
      app_name: "x",
      support_email: "",
      legal_name: "",
      legal_address: "<b>Bold</b> & Co",
      terms_url: "https://acmevoice.com/terms?a=1&b=2",
      privacy_url: "",
      website_url: "",
    });
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; Co");
    expect(html).toContain("terms?a=1&amp;b=2");
  });
});
