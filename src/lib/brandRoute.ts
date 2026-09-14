// Brand routing: which tenant this page load belongs to. "host" door = the brand's own domain, server
// resolves it from Origin; "path" door = /{slug}/..., resolved once at boot as the router basename. Both send X-Brand.

/** Platform-owned first segments that can never be a brand; checked before the network so `/login` can't be
 *  hijacked by a slipped slug. Keep in step with App.tsx top-level routes and RESERVED_SLUGS on the server. */
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

/** Brand-prefixed path for FULL page navigations only: `window.location` bypasses the router basename.
 *  Never use for Link/navigate, or the prefix lands twice. */
export function brandPath(path: string): string {
  const base = brandBasename() ?? "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
