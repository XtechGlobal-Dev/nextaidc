// GTM data layer helper. Named events (not GTM's generic auto events) so each interaction is unique. The
// container itself is pasted in Admin > Settings and injected by SeoManager; GTM replays queued events on boot.

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

/** Funnel path an event came from; pushed as `plan_context` since both render the same plan/card components. */
export type FunnelContext = "subscribe_page" | "quick_setup";

/** Push a GTM event. Creates the data layer if GTM hasn't loaded yet and never throws; analytics must not break a flow. */
export function trackEvent(event: string, params: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event, ...params });
  } catch {
    /* analytics is best-effort — never let it break the calling flow */
  }
}

/** SHA-256 hex, trimmed + lowercased as Enhanced Conversions expects. "" for empty or when Web Crypto is missing; never throws. */
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

/** Hashed signup fields for Enhanced Conversions so raw PII never leaves the browser; phone numbers are
 *  stripped to digits/+ first to match Google's normalisation. Never throws. */
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
