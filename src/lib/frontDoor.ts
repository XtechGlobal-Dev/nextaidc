/* ------------------------------------------------------------------ *
 *  Which front door a signed-in account belongs on.
 *
 *  A brand can be reached two ways, and the fix for being on the wrong
 *  door is different for each:
 *
 *    path — example.com/acme/…  The slug is a prefix on the platform's
 *           host. A wrong door is fixed by rewriting the path, in place,
 *           on the same origin — so the session survives the move.
 *    host — acme.example.com, or the brand's own domain. The host IS the
 *           door. Nothing in the path can change it; the only way off a
 *           wrong host is to leave for the account's own origin.
 *
 *  Pure, so the rule can be tested without a browser. The guard that
 *  applies it is components/auth/RequireBrandFrontDoor.tsx.
 * ------------------------------------------------------------------ */

export interface FrontDoorInput {
  /** Brand slug the account belongs to; null for a platform-level account. */
  accountSlug: string | null;
  /** That brand's origin (https://acme.example.com), when the server said. */
  accountOrigin?: string | null;
  /** Brand this page was loaded under; null for the platform's bare door. */
  pageSlug: string | null;
  /** How the page reached its brand: a path prefix, or the host itself. */
  pageMode?: "path" | "host";
  /** The origin the page is loaded on, when leaving it is on the table. */
  pageOrigin?: string;
  pathname: string;
  search?: string;
  hash?: string;
}

/** Is this origin a developer's own machine? `*.localhost` included — that is
 *  how a brand's front door is opened locally (see platformDomains). */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1"
    );
  } catch {
    return false;
  }
}

/** Where this account should be, given where it currently is. Null = stay put. */
export function frontDoorTarget(opts: FrontDoorInput): string | null {
  const {
    accountSlug,
    accountOrigin,
    pageSlug,
    pageMode = "path",
    pageOrigin,
    pathname,
    search = "",
    hash = "",
  } = opts;
  if (accountSlug === pageSlug) return null;

  if (pageMode === "host") {
    // A platform-level account on a brand's host is the super admin helping
    // inside that brand — the brand's look is what they came for. Stay.
    if (!accountSlug) return null;
    // Another brand's account. Only its own origin will do, and only when we
    // actually know it: guessing at a hostname would be worse than staying.
    if (!accountOrigin) return null;
    // A brand's origin is always a real https host, so on a developer's machine
    // this would throw them out of the environment they are working in and onto
    // production. Stay put and let the page render where it is.
    if (isLoopbackOrigin(pageOrigin)) return null;
    return `${accountOrigin.replace(/\/+$/, "")}${pathname}${search}${hash}`;
  }

  // Path routing. The prefix only counts as a whole segment: "/acmecorp" starts
  // with "/acme" as a string but is a different brand, and slicing blindly
  // would hand the browser "corp/dashboard".
  const prefix = pageSlug ? `/${pageSlug}` : "";
  const isPrefixed = !!prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`));
  const bare = isPrefixed ? pathname.slice(prefix.length) || "/" : pathname;
  const target = `${accountSlug ? `/${accountSlug}` : ""}${bare}${search}${hash}`;
  return target === `${pathname}${search}${hash}` ? null : target;
}
