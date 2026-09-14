import { Resolver } from "node:dns/promises";
import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { domainVerifyName, domainVerifyValuePrefix, env } from "../env.js";
import { loadBrands, normalizeDomain } from "./brands.js";

// Client-owned brand domains (platform subdomains need none of this — the wildcard covers them).
// Three checks: TXT ownership nonce, routing record at our edge, and the edge (Vercel) knowing the hostname. Edge is optional without a token.

/** A record the client pastes into their DNS provider, written for someone who has never opened a DNS panel. */
export interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  /** 1-based checklist position. Ownership first — it changes nothing on their side and gates the routing record. */
  step: number;
  /** What the step achieves, in the client's words. */
  title: string;
  /** Host/name field as most registrars want it (the label, not the FQDN). */
  name: string;
  /** Fully-qualified name, for providers that want the whole thing. */
  fqdn: string;
  value: string;
  /** What to put in the TTL column. */
  ttl: string;
  /** What this record type is, for someone who has never added one. */
  what: string;
  /** Why we need it. */
  why: string;
  /** Provider caveats worth passing on (Cloudflare proxying, ALIAS at an apex). */
  notes: string[];
  /** False once we've actually observed it resolving. */
  required: boolean;
  /** What DNS answers instead of what we asked for, so "wrong" reads differently from "not added yet". Empty when unchecked, absent or correct. */
  seen: string[];
}

export interface DomainCheck {
  domain: string;
  status: "none" | "pending" | "verified" | "error";
  /** Bare root (brand.com) rather than a subdomain — replaces the client's website and needs an A record, so the panel warns up front. */
  apex: boolean;
  /** TXT ownership nonce seen at the expected name. */
  ownershipOk: boolean;
  /** Hostname resolves to our edge (CNAME/A/ALIAS all count). */
  routingOk: boolean;
  /** Edge has the hostname registered and a certificate can be issued. */
  edgeOk: boolean;
  /** Short human reason when something isn't right yet. */
  message: string;
  records: DnsRecord[];
  checkedAt: string;
}

/* ------------------------------ DNS lookups ------------------------------ */

// Public resolvers, not the host's: the container's resolver can cache a negative answer from
// a previous attempt for the whole TTL, so a freshly-added correct record reads as missing.
function resolver(): Resolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return r;
}

/** Best-effort TXT lookup — a missing record is an empty list, never a throw. */
async function txtRecords(name: string): Promise<string[]> {
  try {
    // Each TXT answer arrives as an array of <=255-char chunks that the protocol
    // split; a long value is only whole once they are rejoined.
    return (await resolver().resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

/** The CNAME chain and A records a hostname currently points at. */
async function routingTargets(name: string): Promise<{ cnames: string[]; ips: string[] }> {
  const r = resolver();
  const [cnames, ips] = await Promise.all([
    r.resolveCname(name).catch(() => [] as string[]),
    r.resolve4(name).catch(() => [] as string[]),
  ]);
  return {
    cnames: cnames.map((c) => c.toLowerCase().replace(/\.$/, "")),
    ips,
  };
}

/* ---------------------------- Record templates ---------------------------- */

// Heuristic only (co.uk-style suffixes would need the public-suffix list); it just picks
// which record we recommend, and the operator sees the value either way.
function looksLikeApex(domain: string): boolean {
  return domain.split(".").length <= 2;
}

// Registrar "Host" label. Most providers append the zone themselves, so the FQDN would become app.brand.com.brand.com.
function hostLabel(fqdn: string, zone: string): string {
  if (fqdn === zone) return "@";
  return fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -(zone.length + 1)) : fqdn;
}

/** The zone the client administers — the registrable domain behind the host. */
function zoneOf(domain: string): string {
  const parts = domain.split(".");
  return parts.length <= 2 ? domain : parts.slice(-2).join(".");
}

/** Where the ownership TXT for a domain lives. */
export function verifyRecordName(domain: string): string {
  return `${domainVerifyName}.${domain}`;
}

/** The exact TXT value we look for. Prefixed so a shared TXT name holding other
 *  providers' tokens doesn't read as a failure — we scan for ours among them. */
export function verifyRecordValue(token: string): string {
  return `${domainVerifyValuePrefix}=${token}`;
}

/** What a registrar's TTL column should hold. "Auto" is what most panels
 *  offer; the number is for the ones that insist on one. */
const RECORD_TTL = "Auto (or 3600)";

/** The records the client must publish: ownership TXT first (harmless), routing last (it replaces whatever the hostname served before). */
export function domainInstructions(brand: Brand): DnsRecord[] {
  const domain = normalizeDomain(brand.customDomain);
  if (!domain) return [];
  const zone = zoneOf(domain);
  const target = env.BRAND_CNAME_TARGET;

  const txtName = verifyRecordName(domain);
  const ownership: DnsRecord = {
    type: "TXT",
    step: 1,
    title: "Prove the domain is yours",
    name: hostLabel(txtName, zone),
    fqdn: txtName,
    value: verifyRecordValue(brand.domainToken),
    ttl: RECORD_TTL,
    what: "A TXT record is a plain note stored in DNS. It changes nothing about the website or email at this domain.",
    why: "It lets us confirm that whoever set up this brand really controls the domain, before any link starts pointing at it.",
    notes: [],
    required: true,
    seen: [],
  };

  // Most common setup failure: a proxied Cloudflare record answers with Cloudflare's IPs, so we never see our edge.
  const proxyNote =
    "Using Cloudflare? Set this record to \"DNS only\" (grey cloud), not \"Proxied\", or the certificate cannot be issued.";

  const routing: DnsRecord = looksLikeApex(domain)
    ? {
        type: "A",
        step: 2,
        title: "Send visitors to the app",
        name: hostLabel(domain, zone),
        fqdn: domain,
        value: env.BRAND_APEX_IP,
        ttl: RECORD_TTL,
        what: `An A record maps a name to an IP address. A root domain cannot use a CNAME, so ${domain} takes an A record instead.`,
        why: "It sends the browser to our edge, which serves the app and issues the certificate for this name.",
        notes: [
          `This replaces whatever ${domain} shows today. If a website already lives there, use a subdomain such as app.${domain} instead.`,
          `If the provider offers ALIAS, ANAME or CNAME flattening at the root, use that with ${target} rather than the IP — it is the sturdier option.`,
          proxyNote,
        ],
        required: true,
        seen: [],
      }
    : {
        type: "CNAME",
        step: 2,
        title: "Send visitors to the app",
        name: hostLabel(domain, zone),
        fqdn: domain,
        value: target,
        ttl: RECORD_TTL,
        what: `A CNAME is an alias. It tells the internet that ${domain} lives at ${target}.`,
        why: "It sends the browser to our edge, which serves the app and issues the certificate for this name.",
        notes: [proxyNote],
        required: true,
        seen: [],
      };

  return [ownership, routing];
}

/* ------------------------------- Edge (host) ------------------------------ */

export function isDomainProviderConfigured(): boolean {
  return Boolean(env.VERCEL_API_TOKEN && env.VERCEL_PROJECT_ID);
}

function vercelUrl(path: string): string {
  if (!env.VERCEL_TEAM_ID) return `https://api.vercel.com${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `https://api.vercel.com${path}${sep}teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}`;
}

async function vercel(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(vercelUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env.VERCEL_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty/non-JSON body (204s and some errors) */
  }
  return { ok: res.ok, status: res.status, body };
}

/** The message inside a Vercel error envelope, or a generic one. */
function vercelError(body: Record<string, unknown>, status: number): string {
  const err = body.error as { message?: string; code?: string } | undefined;
  return err?.message?.trim() || `Vercel API returned ${status}.`;
}

/** Registers the hostname with the edge. Idempotent — an already-attached domain reports success, since re-running verification is the normal gesture. */
export async function attachDomainToEdge(
  domain: string,
): Promise<{ ok: boolean; message: string }> {
  if (!isDomainProviderConfigured()) {
    return {
      ok: false,
      message:
        "No host API token configured — add this domain to the hosting project by hand (DNS still verifies on its own).",
    };
  }
  const project = encodeURIComponent(env.VERCEL_PROJECT_ID);
  const { ok, status, body } = await vercel(`/v10/projects/${project}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  if (ok) return { ok: true, message: "" };
  // 400 "already exists on this project" and 409 "assigned elsewhere" are
  // different things: the first is a no-op, the second needs a human.
  const message = vercelError(body, status);
  if (status === 400 && /already/i.test(message)) return { ok: true, message: "" };
  if (status === 409) {
    return {
      ok: false,
      message: `${message} The domain is attached to another Vercel project or account — release it there first.`,
    };
  }
  return { ok: false, message };
}

/** Take the hostname off the edge. Best-effort: a domain that isn't there is
 *  already in the state we want, so a 404 counts as success. */
export async function detachDomainFromEdge(domain: string): Promise<void> {
  if (!isDomainProviderConfigured()) return;
  const project = encodeURIComponent(env.VERCEL_PROJECT_ID);
  await vercel(`/v9/projects/${project}/domains/${encodeURIComponent(domain)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

// Is the hostname on our project and can it get a cert? `misconfigured` is Vercel's own read
// of whether DNS points at them well enough for an ACME challenge.
async function edgeStatus(
  domain: string,
): Promise<{ known: boolean; ready: boolean; message: string }> {
  if (!isDomainProviderConfigured()) {
    // Nothing to ask. Don't hold verification hostage to a check we can't make —
    // the DNS half is still authoritative about whether the client did their part.
    return { known: true, ready: true, message: "" };
  }
  const project = encodeURIComponent(env.VERCEL_PROJECT_ID);
  const enc = encodeURIComponent(domain);

  const projectDomain = await vercel(`/v9/projects/${project}/domains/${enc}`);
  if (projectDomain.status === 404) {
    return {
      known: false,
      ready: false,
      message: "The domain isn't registered with our edge yet.",
    };
  }
  if (!projectDomain.ok) {
    return {
      known: false,
      ready: false,
      message: vercelError(projectDomain.body, projectDomain.status),
    };
  }
  // Vercel raises its OWN TXT challenge only when the apex already sits on
  // another Vercel account. Surface it verbatim rather than inventing wording.
  if (projectDomain.body.verified === false) {
    const challenge = (
      projectDomain.body.verification as
        | { type?: string; domain?: string; value?: string }[]
        | undefined
    )?.[0];
    return {
      known: true,
      ready: false,
      message: challenge
        ? `The host needs its own ownership check: add a ${challenge.type} record at ${challenge.domain} with value ${challenge.value}.`
        : "The host hasn't verified this domain yet.",
    };
  }

  const config = await vercel(`/v6/domains/${enc}/config?projectIdOrName=${project}`);
  if (!config.ok) {
    return { known: true, ready: false, message: vercelError(config.body, config.status) };
  }
  if (config.body.misconfigured === true) {
    return {
      known: true,
      ready: false,
      message:
        "DNS isn't pointing at our edge yet — the routing record is missing or still propagating.",
    };
  }
  return { known: true, ready: true, message: "" };
}

/* ------------------------------ Verification ------------------------------ */

/** Does the CNAME chain or A set actually land on our edge? */
function routingLooksRight(cnames: string[], ips: string[]): boolean {
  const target = env.BRAND_CNAME_TARGET.toLowerCase().replace(/\.$/, "");
  if (
    cnames.some((c) => c === target || c.endsWith(".vercel-dns.com") || c.endsWith(".vercel.app"))
  ) {
    return true;
  }
  // Apex records, and providers that flatten a CNAME into A records, only ever
  // show up as addresses — so an exact IP match is the only signal available.
  return ips.includes(env.BRAND_APEX_IP);
}

/** Checks a domain end to end and persists the verdict. Ownership is independent of routing — a missing TXT means an unproven claim that must never be trusted, however traffic flows. */
export async function verifyBrandDomain(brand: Brand): Promise<DomainCheck> {
  const domain = normalizeDomain(brand.customDomain);
  const checkedAt = new Date();

  if (!domain) {
    return {
      domain: "",
      status: "none",
      apex: false,
      ownershipOk: false,
      routingOk: false,
      edgeOk: false,
      message: "This brand has no custom domain — it answers on its platform subdomain.",
      records: [],
      checkedAt: checkedAt.toISOString(),
    };
  }

  const records = domainInstructions(brand);
  const want = verifyRecordValue(brand.domainToken);

  const [txts, targets, edge] = await Promise.all([
    txtRecords(verifyRecordName(domain)),
    routingTargets(domain),
    edgeStatus(domain).catch((e: unknown) => ({
      known: false,
      ready: false,
      message: e instanceof Error ? e.message : "Couldn't reach the hosting API.",
    })),
  ]);

  const ownershipOk = txts.some((t) => t.trim() === want);
  const routingOk = routingLooksRight(targets.cnames, targets.ips);
  const edgeOk = edge.ready;

  // What's there instead. For TXT only values with our prefix count — other providers' tokens
  // on the same name are fine. For routing, wherever the name lands (usually the forgotten old site).
  const staleTokens = ownershipOk
    ? []
    : txts.map((t) => t.trim()).filter((t) => t.startsWith(`${domainVerifyValuePrefix}=`));
  const routesTo = routingOk ? [] : [...targets.cnames, ...targets.ips];
  const routing = records.find((r) => r.step === 2);

  // One sentence naming the step that is holding things up, in the order the
  // client works through them, so the panel can say "do this next".
  let message = "";
  if (!ownershipOk) {
    message = staleTokens.length
      ? `Step 1 has an old value: the TXT at ${verifyRecordName(domain)} still holds a token from an earlier claim. Replace it with the value shown below.`
      : `Step 1 isn't done yet: no TXT record found at ${verifyRecordName(domain)}. Once it's added, DNS can take a few minutes to show it.`;
  } else if (!routingOk) {
    message = routesTo.length
      ? `Step 2 isn't done yet: ${domain} still points at ${routesTo.join(", ")} instead of ${routing?.value ?? "our edge"}.`
      : `Step 2 isn't done yet: ${domain} doesn't point anywhere. Add the ${routing?.type ?? "routing"} record shown below.`;
  } else if (!edgeOk) {
    message = edge.message || "The edge can't serve this hostname yet.";
  }

  const status: DomainCheck["status"] = ownershipOk && routingOk && edgeOk ? "verified" : "pending";

  await prisma.brand.update({
    where: { id: brand.id },
    data: {
      domainStatus: status,
      domainCheckedAt: checkedAt,
      domainError: message,
      // Stamped once, on the first success — it records when the domain STARTED
      // serving, so re-checks of an already-live domain don't keep moving it.
      ...(status === "verified" && !brand.domainVerifiedAt ? { domainVerifiedAt: checkedAt } : {}),
    },
  });
  await loadBrands();

  return {
    domain,
    status,
    apex: looksLikeApex(domain),
    ownershipOk,
    routingOk,
    edgeOk,
    message,
    // Mark satisfied records so the UI greys out what's done, and report what's there instead.
    records: records.map((r) =>
      r.type === "TXT"
        ? { ...r, required: !ownershipOk, seen: staleTokens }
        : { ...r, required: !routingOk, seen: routesTo },
    ),
    checkedAt: checkedAt.toISOString(),
  };
}

/** The un-checked view — what to show the operator the moment a domain is
 *  claimed, before anyone has had a chance to publish anything. */
export function pendingDomainCheck(brand: Brand): DomainCheck {
  const domain = normalizeDomain(brand.customDomain);
  const verified = brand.domainStatus === "verified";
  return {
    domain,
    status: (brand.domainStatus as DomainCheck["status"]) ?? "none",
    apex: Boolean(domain) && looksLikeApex(domain),
    ownershipOk: verified,
    routingOk: verified,
    edgeOk: verified,
    message: brand.domainError,
    // Only the verdict is stored, not per-record results, so pending reads as all outstanding until a real check runs.
    records: domainInstructions(brand).map((r) => ({ ...r, required: !verified })),
    checkedAt: brand.domainCheckedAt?.toISOString() ?? "",
  };
}

/* ------------------------------ Auto-verify ------------------------------ */

/** Re-checks PENDING domains and promotes the ones whose records landed. Never touches verified ones — a resolver hiccup demoting a live domain would cut the tenant off from its API; that's for an explicit "Check now". */
export async function sweepPendingDomains(): Promise<{ checked: number; verified: number }> {
  const pending = await prisma.brand.findMany({
    where: { domainStatus: "pending", customDomain: { not: null } },
  });
  let verified = 0;
  for (const brand of pending) {
    if (!brand.customDomain) continue;
    // Idempotent, and the most common reason a check keeps failing: the
    // hostname never made it onto the edge (no host token at claim time).
    await attachDomainToEdge(brand.customDomain).catch(() => undefined);
    try {
      const check = await verifyBrandDomain(brand);
      if (check.status === "verified") verified += 1;
    } catch {
      /* one bad domain must not stop the rest of the sweep */
    }
  }
  return { checked: pending.length, verified };
}
