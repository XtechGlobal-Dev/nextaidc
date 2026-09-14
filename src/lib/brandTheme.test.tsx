import { describe, it, expect, beforeEach } from "vitest";
import { applyBrandTheme, hexToHsl } from "@/lib/brandTheme";
import type { PublicBrand } from "@/lib/api";

// White-label theming: the right custom properties get set, tints stay the brand hue, leaving a brand restores everything.

function brand(over: Partial<PublicBrand["theme"]> = {}): PublicBrand {
  return {
    id: "b1",
    name: "Acme Voice",
    slug: "acme",
    tagline: "",
    supportEmail: "",
    supportPhone: "",
    logoLightUrl: "",
    logoDarkUrl: "",
    faviconUrl: "",
    websiteUrl: "",
    helpUrl: "",
    termsUrl: "",
    privacyUrl: "",
    legalName: "",
    signupMode: "public",
    loginHeadline: "",
    loginBlurb: "",
    modules: { booking: true, transfer: true, crm: true, smsToCaller: true, whatsapp: true },
    theme: {
      preset: "emerald",
      primaryColor: "#059669",
      accentColor: "#10b981",
      fontFamily: "lora",
      fontStyle: "classic",
      fontStack: '"Lora", Georgia, serif',
      googleFamily: "Lora",
      darkModeDefault: false,
      ...over,
    },
  };
}

const root = () => document.documentElement;

describe("hexToHsl", () => {
  it("converts the shorthand and full forms alike", () => {
    expect(hexToHsl("#fff")).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHsl("#ffffff")).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHsl("#000000")).toEqual({ h: 0, s: 0, l: 0 });
  });

  it("keeps the hue of a saturated brand colour", () => {
    const hsl = hexToHsl("#2C76ED");
    expect(hsl).not.toBeNull();
    expect(hsl!.h).toBeGreaterThan(200);
    expect(hsl!.h).toBeLessThan(230);
    expect(hsl!.s).toBeGreaterThan(50);
  });

  it("rejects anything that isn't a hex colour", () => {
    for (const bad of ["", "#12", "rgb(1,2,3)", "#12345g", "blue"]) {
      expect(hexToHsl(bad)).toBeNull();
    }
  });
});

describe("applyBrandTheme", () => {
  beforeEach(() => {
    applyBrandTheme(null);
  });

  it("overrides the brand tokens and the font stack", () => {
    applyBrandTheme(brand());
    const style = root().style;
    expect(style.getPropertyValue("--color-primary")).toContain("hsl(");
    expect(style.getPropertyValue("--font-sans")).toContain("Lora");
    // Step 1 and chart series 1 are the brand hue in the base theme — a brand
    // must not break that relationship.
    expect(style.getPropertyValue("--color-step-1")).toBe(
      style.getPropertyValue("--color-primary"),
    );
  });

  it("derives the soft tints from the brand hue rather than leaving them blue", () => {
    applyBrandTheme(brand({ primaryColor: "#059669" }));
    const primary = root().style.getPropertyValue("--color-primary");
    const hue = primary.match(/hsl\((\d+)/)?.[1];
    expect(hue).toBeTruthy();
    for (const token of ["--color-primary-tint", "--color-primary-tint-soft"]) {
      const value = root().style.getPropertyValue(token);
      expect(value).toContain(`hsl(${hue}`);
      expect(value).toContain("/"); // carries an alpha
    }
  });

  it("loads the brand's web font once, and swaps it when the brand changes", () => {
    applyBrandTheme(brand());
    const first = document.getElementById("brand-font") as HTMLLinkElement | null;
    expect(first?.href).toContain("Lora");

    applyBrandTheme(brand({ googleFamily: "Manrope", fontStack: '"Manrope", sans-serif' }));
    expect(document.querySelectorAll("#brand-font")).toHaveLength(1);
    expect((document.getElementById("brand-font") as HTMLLinkElement).href).toContain("Manrope");
  });

  it("leaves a system face without a font request", () => {
    applyBrandTheme(brand({ googleFamily: "", fontStack: "system-ui, sans-serif" }));
    expect(document.getElementById("brand-font")).toBeNull();
    expect(root().style.getPropertyValue("--font-sans")).toContain("system-ui");
  });

  it("restores the platform theme when the brand goes away", () => {
    applyBrandTheme(brand());
    applyBrandTheme(null);
    for (const token of [
      "--color-primary",
      "--color-primary-tint",
      "--color-primary-tint-soft",
      "--color-step-1",
      "--color-step-2",
      "--font-sans",
    ]) {
      expect(root().style.getPropertyValue(token)).toBe("");
    }
    expect(document.getElementById("brand-font")).toBeNull();
  });

  it("ignores a malformed colour instead of writing a broken token", () => {
    applyBrandTheme(brand({ primaryColor: "not-a-colour" }));
    expect(root().style.getPropertyValue("--color-primary")).toBe("");
    // …while the rest of the theme still applies.
    expect(root().style.getPropertyValue("--font-sans")).toContain("Lora");
  });
});
