import type { PublicBrand } from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  Painting the app as a white-label brand.
 *
 *  The design tokens in index.css are plain CSS custom properties on
 *  :root, and every utility in the app reads them through var(). So a
 *  brand's palette and typeface are applied by overriding those same
 *  properties inline on <html> — an inline style beats the stylesheet,
 *  and one write re-themes every button, badge, chart and nav item at
 *  once. No re-render, no theme-aware components, no prop drilling.
 * ------------------------------------------------------------------ */

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

/** Custom properties this module owns, so switching brands (or leaving one)
 *  can clear exactly what it set and nothing else. */
const OWNED_PROPS = [
  "--color-primary",
  "--color-primary-tint",
  "--color-primary-tint-soft",
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
    // Weights the UI actually uses (body, medium, semibold, bold). `display=swap`
    // so text paints in the fallback immediately rather than staying invisible
    // while the face downloads.
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

/**
 * Repaint the app as `brand`. Passing null restores the platform's own theme
 * (every property this module set is removed, so index.css takes over again).
 *
 * Safe to call repeatedly and safe outside a browser (SSR/tests no-op).
 */
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
