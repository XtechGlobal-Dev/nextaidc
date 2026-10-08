// Which front door a signed-in account belongs on. A wrong path door is fixed by rewriting the path on the
// same origin (session survives); a wrong host door can only be left for the account's own origin. Pure, for tests.

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
    // A brand origin is a real https host; on a dev machine this would bounce them to production.
    if (isLoopbackOrigin(pageOrigin)) return null;
    return `${accountOrigin.replace(/\/+$/, "")}${pathname}${search}${hash}`;
  }

  // Prefix must match a whole segment: "/acmecorp" starts with "/acme" but slicing blindly gives "corp/dashboard".
  const prefix = pageSlug ? `/${pageSlug}` : "";
  const isPrefixed = !!prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`));
  const bare = isPrefixed ? pathname.slice(prefix.length) || "/" : pathname;
  const target = `${accountSlug ? `/${accountSlug}` : ""}${bare}${search}${hash}`;
  return target === `${pathname}${search}${hash}` ? null : target;
}

export interface MovedAccountInput {
  /** "brand" once the account's row is a white-label brand; "customer" for a main-domain customer. */
  brandKind: string | null;
  /** That brand's own origin, when the server said. */
  accountOrigin: string | null;
  pageSlug: string | null;
  pageMode?: "path" | "host";
  pageOrigin: string;
}

/** A brand account signed in on the platform's own door — a customer whose Brand Admin request was approved, still in
 *  their old main-domain session. Returns the brand's origin to send them to (they sign in there), or null. */
export function movedAccountOrigin(opts: MovedAccountInput): string | null {
  const { brandKind, accountOrigin, pageSlug, pageMode = "path", pageOrigin } = opts;
  if (brandKind !== "brand" || !accountOrigin) return null;
  // Only the platform's bare door: on a brand's own door (path or host) frontDoorTarget decides.
  if (pageSlug || pageMode === "host") return null;
  const target = accountOrigin.replace(/\/+$/, "");
  if (target === pageOrigin.replace(/\/+$/, "")) return null;
  // Never send a dev machine to a production host.
  if (isLoopbackOrigin(pageOrigin) && !isLoopbackOrigin(target)) return null;
  return target;
}
