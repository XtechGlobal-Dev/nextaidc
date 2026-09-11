/* ------------------------------------------------------------------ *
 *  Marketing analytics — GTM data layer helper.
 *
 *  Pushes a NAMED custom event onto window.dataLayer so Google Tag Manager can
 *  trigger GA4 / Google Ads tags on it. We push our own events (instead of
 *  relying on GTM's generic auto events like `gtm.formSubmit`) so each key
 *  interaction has a unique, trackable name and can't be confused with any other
 *  form on the site.
 *
 *  The GTM container itself is NOT in this codebase — it is pasted into Admin →
 *  Settings → SEO & Scripts and injected at runtime by SeoManager. This only
 *  feeds the data layer, which is safe to do before GTM loads: the array is
 *  created here if missing and GTM replays everything already queued in it once
 *  the container boots, so no event is lost to the injection delay.
 * ------------------------------------------------------------------ */

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

/**
 * Which path through the funnel an event happened on — the standalone /subscribe
 * page or the in-dashboard quick-setup wizard. Both render the same plan/card
 * components, so this is pushed as `plan_context` to keep them apart in a report.
 */
export type FunnelContext = "subscribe_page" | "quick_setup";

/**
 * Push a custom event to the GTM data layer. Safe to call anywhere — if GTM /
 * the data layer isn't present yet, this initialises the array so the event
 * isn't lost, and it never throws (analytics must never break a user flow).
 */
export function trackEvent(event: string, params: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event, ...params });
  } catch {
    /* analytics is best-effort — never let it break the calling flow */
  }
}

/**
 * SHA-256 hex of a value, normalised (trimmed + lowercased) the way Google's
 * Enhanced Conversions expects. Returns "" for an empty value, and "" (never
 * throws) if Web Crypto isn't available — analytics must never break a flow.
 */
export async function sha256Hex(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/**
 * Build a hashed copy of the signup fields for Enhanced Conversions — SHA-256
 * so the raw PII never leaves the browser in the clear. Phone/business numbers
 * are stripped to digits (+) first so the hash matches Google's normalisation.
 * Never throws; unavailable-crypto just yields empty strings.
 */
export async function hashUserData(u: {
  name?: string;
  email?: string;
  phone?: string;
  business_number?: string;
  address?: string;
}): Promise<Record<string, string>> {
  const digits = (v: string) => v.replace(/[^\d+]/g, "");
  const [name, email, phone, business_number, address] = await Promise.all([
    sha256Hex(u.name ?? ""),
    sha256Hex(u.email ?? ""),
    sha256Hex(digits(u.phone ?? "")),
    sha256Hex(digits(u.business_number ?? "")),
    sha256Hex(u.address ?? ""),
  ]);
  return { name, email, phone, business_number, address };
}
