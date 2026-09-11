import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/* ------------------------------------------------------------------ *
 *  SSRF guard for server-side fetches of user-supplied URLs.
 *
 *  The onboarding flow fetches whatever website URL a (pre-signup, unauthed)
 *  visitor types, to scrape their business details. Without a check, that URL
 *  could point at the cloud metadata endpoint (169.254.169.254), localhost, or
 *  an internal 10./192.168./172.16 host — turning our server into a proxy into
 *  the private network. This blocks non-http(s) schemes and any host that
 *  resolves to a private/loopback/link-local/reserved address.
 *
 *  Note: this validates the INITIAL target. Callers that follow redirects still
 *  carry a residual redirect-to-internal risk; keep the fetch timeouts + size
 *  caps that bound it, and prefer re-validating hops for anything higher-risk.
 * ------------------------------------------------------------------ */

/** True for an IPv4 literal in a range that must never be reached from a fetch. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/** True for an IPv6 literal that must never be reached. Covers loopback, ULA,
 *  link-local, unspecified, multicast, and IPv4-mapped (::ffff:a.b.c.d). */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:127.0.0.1, which new URL() may also render in hex as
  // ::ffff:7f00:1). Block the whole ::ffff: space — a legit public host is never
  // reached via a mapped-IPv6 literal, and parsing every hex form is error-prone.
  if (addr.startsWith("::ffff:")) return true;
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique-local
  if (addr.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a recognisable IP → block
}

/**
 * Throw if `rawUrl` isn't a plain http(s) URL to a public host. Resolves the
 * hostname first so a name that points at an internal address is caught too.
 * Returns the parsed URL on success.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }

  // url.hostname keeps the brackets on an IPv6 literal ("[::1]"); strip them so
  // isIP recognises it and we take the literal path instead of a DNS lookup.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An IP literal is checked directly; a hostname is resolved to every address
  // it maps to, and blocked if ANY is private (defeats "127.0.0.1.nip.io" tricks).
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error("URL resolves to a non-public address");
    return url;
  }

  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error("Host could not be resolved");
  }
  if (!records.length) throw new Error("Host could not be resolved");
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error("URL resolves to a non-public address");
  }
  return url;
}

/** Boolean convenience wrapper — never throws. */
export async function isPublicHttpUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertPublicHttpUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
