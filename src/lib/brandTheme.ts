import type { PublicBrand } from "@/lib/api";

// White-label theming: override the index.css custom properties inline on <html>. Inline beats the
// stylesheet, so one write re-themes everything with no re-render or prop drilling.

/** #RGB or #RRGGBB → {h, s, l}. Returns null for anything else. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** The `h s% l%` triple an hsl() token wants, so alpha variants can reuse it. */
function hslParts(hex: string): string | null {
  const hsl = hexToHsl(hex);
  return hsl ? `${hsl.h} ${hsl.s}% ${hsl.l}%` : null;
}

/* ----------------------------- Readable ink ------------------------------ */

// A brand colour has two jobs and they pull opposite ways on a dark theme: as a FILL it wants
// the literal hex the brand chose, as TEXT it has to out-contrast the surface behind it. The
// dark end of the palette can't do both — Graphite (#334155) is 1.55:1 on the dark card, which
// is why a brand's initials, links and nav labels went near-invisible there. So fills keep the
// hex and text gets `readableInk`: the same hue and saturation, re-levelled until it reads.

/** Surfaces brand-coloured text actually lands on — `--color-card` in each theme. Kept as the
 *  hex and measured below, never as a hand-typed luminance: a value a fraction too low silently
 *  stops the search one step early and ships text that just misses the bar. */
const SURFACE_HEX = { light: "#ffffff", dark: "#1e2129" } as const;

export type Surface = keyof typeof SURFACE_HEX;

/** WCAG 2.1 AA for body text. Also clears the 3:1 a non-text outline needs. */
const MIN_CONTRAST = 4.5;

/** One sRGB channel, gamma-expanded for the luminance sum. */
function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `h s% l%` colour. */
function hslLuminance(h: number, s: number, l: number): number {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lum - c / 2;
  const [r, g, b] = (
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x]
  ).map((v) => channel(v + m));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG relative luminance of a full `#rrggbb`. */
function hexLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(n.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SURFACE_LUMINANCE: Record<Surface, number> = {
  light: hexLuminance(SURFACE_HEX.light),
  dark: hexLuminance(SURFACE_HEX.dark),
};

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The brand hue re-levelled until it clears {@link MIN_CONTRAST} as text on `surface` — lighter on
 *  dark, darker on light. Hue and saturation are untouched, so it still reads as the brand's colour,
 *  and a colour that already passes comes back unchanged. Null for an unparseable hex. */
export function readableInk(hex: string, surface: Surface): string | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const target = SURFACE_LUMINANCE[surface];
  const step = surface === "dark" ? 1 : -1;
  for (let l = hsl.l; l >= 0 && l <= 100; l += step) {
    if (contrast(hslLuminance(hsl.h, hsl.s, l), target) >= MIN_CONTRAST) {
      return `${hsl.h} ${hsl.s}% ${l}%`;
    }
  }
  // Ran out of headroom — pure white on dark, pure black on light still beats an unreadable hue.
  return `${hsl.h} ${hsl.s}% ${surface === "dark" ? 100 : 0}%`;
}

/** Custom properties this module owns, so switching brands (or leaving one)
 *  can clear exactly what it set and nothing else. */
const OWNED_PROPS = [
  "--color-primary",
  "--color-primary-tint",
  "--color-primary-tint-soft",
  // Both surfaces' ink is parked here; index.css picks whichever is in play, so
  // toggling the theme needs no JS and no re-render.
  "--brand-ink-light",
  "--brand-ink-dark",
  "--color-step-1",
  "--color-step-2",
  "--color-chart-1",
  "--color-chart-2",
  "--font-sans",
] as const;

const FONT_LINK_ID = "brand-font";

/** Load a brand's web font from Google Fonts, replacing any previous one. */
function applyFont(stack: string, googleFamily: string) {
  const head = document.head;
  const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;

  if (googleFamily) {
    // Only the weights the UI uses; `display=swap` so text isn't invisible while the face downloads.
    const family = googleFamily.replace(/ /g, "+");
    const href = `https://fonts.googleapis.com/css2?family=${family}:wght@400;500;600;700&display=swap`;
    if (existing) {
      if (existing.href !== href) existing.href = href;
    } else {
      const link = document.createElement("link");
      link.id = FONT_LINK_ID;
      link.rel = "stylesheet";
      link.href = href;
      head.appendChild(link);
    }
  } else if (existing) {
    existing.remove();
  }

  document.documentElement.style.setProperty("--font-sans", stack);
}

/** Point a <link rel> at the given href, creating the tag if it's missing. */
function setIconLink(rel: string, url: string) {
  let link = document.querySelector<HTMLLinkElement>(`link[rel~="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = url;
}

/** Repaint the app as `brand`; null removes everything this module set so index.css takes over. No-op outside a browser. */
export function applyBrandTheme(brand: PublicBrand | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (!brand) {
    for (const prop of OWNED_PROPS) root.style.removeProperty(prop);
    document.getElementById(FONT_LINK_ID)?.remove();
    return;
  }

  const primary = hslParts(brand.theme.primaryColor);
  const accent = hslParts(brand.theme.accentColor);

  if (primary) {
    root.style.setProperty("--color-primary", `hsl(${primary})`);
    // The tints are the SAME hue at low alpha — derived rather than configured,
    // so a brand colour can never drift out of step with its own soft surfaces.
    root.style.setProperty("--color-primary-tint", `hsl(${primary} / 0.12)`);
    root.style.setProperty("--color-primary-tint-soft", `hsl(${primary} / 0.06)`);
    // Step 1 (AI Brain "Identity") and chart series 1 are the brand hue by
    // design in the base theme — keep that relationship under a brand too.
    root.style.setProperty("--color-step-1", `hsl(${primary})`);
    root.style.setProperty("--color-chart-1", `hsl(${primary})`);

    // Text and outlines in the brand hue read off these instead, so a dark brand
    // colour stops disappearing into the dark theme.
    const inkLight = readableInk(brand.theme.primaryColor, "light");
    const inkDark = readableInk(brand.theme.primaryColor, "dark");
    if (inkLight) root.style.setProperty("--brand-ink-light", `hsl(${inkLight})`);
    if (inkDark) root.style.setProperty("--brand-ink-dark", `hsl(${inkDark})`);
  }
  if (accent) {
    root.style.setProperty("--color-step-2", `hsl(${accent})`);
    root.style.setProperty("--color-chart-2", `hsl(${accent})`);
  }

  applyFont(brand.theme.fontStack, brand.theme.googleFamily);

  if (brand.faviconUrl) {
    setIconLink("icon", brand.faviconUrl);
    setIconLink("apple-touch-icon", brand.faviconUrl);
  }
}
