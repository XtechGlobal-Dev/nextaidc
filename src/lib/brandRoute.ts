/* ------------------------------------------------------------------ *
 *  Brand routing — which tenant this page load belongs to, and how it
 *  got there. A brand has two kinds of front door:
 *
 *    host — acme.example.com, or the brand's own verified domain. The
 *           server resolves the tenant from the request's Origin, so
 *           nothing in the URL names it and the app lives at plain
 *           /dashboard. The brand's domain serves ONLY this SPA; every
 *           API call still goes to the platform's API host.
 *
 *    path — example.com/{brandname}/…  Every brand shares the platform's
 *           host and the first path segment names the tenant. That
 *           segment is resolved ONCE at boot and becomes the router's
 *           basename, so no link, redirect or navigate() call anywhere
 *           in the app has to know about it: React Router prefixes them
 *           all. Needs no DNS, so it is the door that still works while
 *           a wildcard record propagates or on a preview deployment.
 *
 *  Either way the API is told which brand the page is, via an X-Brand
 *  header — redundant on a host door, essential on a path one.
 * ------------------------------------------------------------------ */

/**
 * First segments that are the platform's own and can never be a brand.
 *
 * Checked before the network so a normal page load doesn't wait on a lookup,
 * and so a brand could never take over `/login` even if someone slipped that
 * slug past the reserved-name check at creation time. Keep in step with the
 * top-level routes in App.tsx and with RESERVED_SLUGS on the server.
 */
export const RESERVED_PATH_SEGMENTS = new Set([
  "dashboard",
  "superadmin",
  "login",
  "onboarding",
  "subscribe",
  "reseller",
  "api",
  "c",
  "assets",
  "static",
  "favicon.ico",
  "robots.txt",
]);

/** The candidate brand slug in a pathname, or null when there isn't one. */
export function slugFromPath(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  const slug = segment.toLowerCase();
  if (RESERVED_PATH_SEGMENTS.has(slug)) return null;
  // Same shape the server accepts, so an obviously-invalid segment (a file
  // name, an encoded id) never costs a round trip.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;
  if (slug.length < 3 || slug.length > 40) return null;
  return slug;
}

/** How this page load reached its brand. */
export interface BrandDoor {
  slug: string;
  /** "path": the slug is a prefix and the router's basename.
   *  "host": the host itself named the brand; the path carries no prefix. */
  mode: "path" | "host";
}

/** The door for this page load — set once at boot, then read by the API client
 *  on every request and by the front-door guard. Null on the platform's own door. */
let door: BrandDoor | null = null;

/** A PATH door (provisional until /api/config confirms the segment is a live
 *  brand). Null clears it. */
export function setActiveBrandSlug(slug: string | null): void {
  door = slug ? { slug, mode: "path" } : null;
}

/** A HOST door: the server resolved the brand from the origin the page loaded
 *  on. No basename — the app lives at the plain path on that host. */
export function setHostBrand(slug: string): void {
  door = { slug, mode: "host" };
}

export function brandDoor(): BrandDoor | null {
  return door;
}

/** The active brand slug for this page load, whichever door it came through. */
export function activeBrandSlug(): string | null {
  return door?.slug ?? null;
}

/** Router basename for this page load: "/acme" on a path door, else undefined. */
export function brandBasename(): string | undefined {
  return door?.mode === "path" ? `/${door.slug}` : undefined;
}

/**
 * An in-app path with the brand prefix applied, for a FULL page navigation.
 *
 * `window.location` bypasses the router, so its `basename` does not apply and a
 * bare "/login" would drop a path-door customer onto the PLATFORM's page. Every
 * `window.location` that targets an in-app path goes through here; anything
 * navigating inside the router (Link, navigate, Navigate) must NOT, or the
 * prefix lands twice.
 */
export function brandPath(path: string): string {
  const base = brandBasename() ?? "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
