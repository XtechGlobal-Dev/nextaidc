import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for fetching user-supplied URLs (unauthed onboarding scrapes any site typed in). Blocks
// non-http(s) and hosts resolving to private/loopback/link-local (cloud metadata) ranges.
// Validates the INITIAL target only — redirects still carry residual risk; keep timeouts and size caps.

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
  // Block all IPv4-mapped (::ffff:) — URL() may render it in hex, and no legit public host uses it.
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

/** Throw unless `rawUrl` is http(s) to a public host (hostname resolved first). Returns the parsed URL. */
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
