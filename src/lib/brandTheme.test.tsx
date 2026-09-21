import { describe, it, expect, beforeEach } from "vitest";
import { applyBrandTheme, hexToHsl, readableInk, type Surface } from "@/lib/brandTheme";
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

/* --------------------------- Readable ink -------------------------------- */

// Contrast maths written out again rather than imported: a test that reuses the implementation's
// own luminance function would pass even if that function were wrong.

const SURFACE_HEX: Record<Surface, string> = { light: "#ffffff", dark: "#1e2129" };

function luminanceOfHex(hex: string): number {
  const n = hex.replace("#", "");
  const ch = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** `h s% l%` → luminance, via the plain HSL→RGB formula. */
function luminanceOfHsl(parts: string): number {
  const [h, s, l] = parts.split(" ").map((p) => parseFloat(p));
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const rgb =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  const ch = rgb
    .map((v) => v + m)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastOnSurface(parts: string, surface: Surface): number {
  const a = luminanceOfHsl(parts);
  const b = luminanceOfHex(SURFACE_HEX[surface]);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Mirrors COLOR_PRESETS in server/src/lib/brandTheme.ts. A copy is fine here: the point is
// that the RULE holds for any hue, and the sweep below covers what this list can't.
const PRESETS = [
  "#2C76ED", "#4F46E5", "#7C3AED", "#059669", "#0D9488",
  "#D97706", "#EA580C", "#DC2626", "#E11D48", "#334155",
  "#166534", "#475569", "#1D4ED8", "#F43F5E", "#CA8A04",
];

describe("readableInk", () => {
  it("lifts the three darkest presets off the dark surface", () => {
    // Graphite, Forest and Slate measured 1.55, 2.26 and 2.12 as raw text on the dark card.
    for (const hex of ["#334155", "#166534", "#475569"]) {
      const ink = readableInk(hex, "dark")!;
      expect(contrastOnSurface(ink, "dark")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("clears 4.5:1 for every preset on both surfaces", () => {
    for (const hex of PRESETS) {
      for (const surface of ["light", "dark"] as const) {
        const ink = readableInk(hex, surface)!;
        expect(
          contrastOnSurface(ink, surface),
          `${hex} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("holds for any hue at any lightness, not just the catalog", () => {
    for (let h = 0; h < 360; h += 15) {
      for (const l of [5, 20, 35, 50, 65, 80, 95]) {
        const hex = hslToHex(h, 70, l);
        for (const surface of ["light", "dark"] as const) {
          expect(
            contrastOnSurface(readableInk(hex, surface)!, surface),
            `hsl(${h} 70% ${l}%) on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps the brand's hue and saturation — it re-levels, it doesn't recolour", () => {
    const source = hexToHsl("#166534")!;
    const [h, s] = readableInk("#166534", "dark")!.split(" ");
    expect(parseFloat(h)).toBe(source.h);
    expect(parseFloat(s)).toBe(source.s);
  });

  it("leaves a colour that already reads exactly as it is", () => {
    // Mustard is 5.48:1 on the dark card untouched, so nothing should move.
    const source = hexToHsl("#CA8A04")!;
    expect(readableInk("#CA8A04", "dark")).toBe(`${source.h} ${source.s}% ${source.l}%`);
  });

  it("returns null for an unparseable colour rather than a broken token", () => {
    expect(readableInk("nope", "dark")).toBeNull();
  });
});

/** Test-local HSL→hex, for generating sweep inputs. */
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const rgb =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return `#${rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

describe("applyBrandTheme", () => {
  beforeEach(() => {
    applyBrandTheme(null);
  });

  it("parks both surfaces' ink on the root so a theme toggle needs no JS", () => {
    applyBrandTheme(brand({ primaryColor: "#334155" }));
    const light = root().style.getPropertyValue("--brand-ink-light");
    const dark = root().style.getPropertyValue("--brand-ink-dark");
    expect(light).toMatch(/^hsl\(/);
    expect(dark).toMatch(/^hsl\(/);
    // The fill stays the brand's literal colour — only the ink moves.
    expect(root().style.getPropertyValue("--color-primary")).toBe("hsl(215 25% 27%)");
    expect(dark).not.toBe(light);
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
      "--brand-ink-light",
      "--brand-ink-dark",
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
