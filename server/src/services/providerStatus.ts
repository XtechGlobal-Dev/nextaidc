/* ------------------------------------------------------------------ *
 *  Vendor-reported status — the "is it them or is it us?" signal.
 *
 *  Our own telemetry (apiTrace.ts) says whether OUR calls are failing. It can't
 *  say whether the vendor is having a public incident, and the difference
 *  matters: a provider that is red on our side AND red on its own status page
 *  needs waiting out, while one that is red only on our side is our bug — a bad
 *  key, an expired token, a payload we changed.
 *
 *  Most modern API vendors publish a statuspage.io v2 summary. Those that don't
 *  (or whose endpoint moves) report `unknown`, never a fabricated "operational" —
 *  a green light nobody checked is worse than an honest blank.
 *
 *  Deliberately NOT routed through traceFetch: polling a status page is our own
 *  housekeeping, not traffic to the vendor's API, and counting it would inflate
 *  request counts and skew latency for every provider.
 * ------------------------------------------------------------------ */

import { PROVIDER_DEFS, type ProviderDef } from "./apiProviders.js";

/** statuspage.io's five indicators, plus our own "unknown" for the no-feed case. */
export type StatusIndicator = "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";

export interface ProviderIncident {
  id: string;
  name: string;
  /** investigating | identified | monitoring | resolved */
  status: string;
  impact: string;
  shortlink: string;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface ProviderStatus {
  provider: string;
  indicator: StatusIndicator;
  /** Vendor's own words, e.g. "Partially Degraded Service". */
  description: string;
  incidents: ProviderIncident[];
  statusPageUrl?: string;
  /** When we last got a usable answer; null if we never have. */
  checkedAt: string | null;
}

/* ------------------------------- Cache ----------------------------- */

/** Status pages move slowly; five minutes is fresh enough and keeps us a polite
 *  caller across a couple of dozen vendors. */
const TTL_MS = 5 * 60 * 1000;
/** A status page that doesn't answer promptly is not worth blocking a dashboard for. */
const FETCH_TIMEOUT_MS = 6_000;

const cache = new Map<string, { value: ProviderStatus; at: number }>();
/** In-flight polls, so a burst of dashboard loads triggers one fetch per vendor. */
const inflight = new Map<string, Promise<ProviderStatus>>();

function unknownStatus(def: ProviderDef): ProviderStatus {
  return {
    provider: def.id,
    indicator: "unknown",
    description: def.statusApiUrl ? "Status feed unavailable" : "No public status feed",
    incidents: [],
    statusPageUrl: def.statusPageUrl,
    checkedAt: null,
  };
}

/* ------------------------------ Parsing ---------------------------- */

interface StatuspageSummary {
  status?: { indicator?: string; description?: string };
  incidents?: Array<{
    id?: string;
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
    created_at?: string;
    updated_at?: string;
  }>;
}

const INDICATORS: StatusIndicator[] = ["none", "minor", "major", "critical", "maintenance"];

function parseSummary(def: ProviderDef, body: StatuspageSummary): ProviderStatus {
  const raw = body.status?.indicator ?? "";
  const indicator = (INDICATORS as string[]).includes(raw) ? (raw as StatusIndicator) : "unknown";
  // Resolved incidents stay in the feed for a while; the dashboard only cares
  // about what is happening now.
  const incidents = (body.incidents ?? [])
    .filter((i) => i.status && i.status !== "resolved" && i.status !== "postmortem")
    .slice(0, 5)
    .map((i) => ({
      id: i.id ?? "",
      name: i.name ?? "Incident",
      status: i.status ?? "investigating",
      impact: i.impact ?? "none",
      shortlink: i.shortlink ?? def.statusPageUrl ?? "",
      startedAt: i.created_at ?? null,
      updatedAt: i.updated_at ?? null,
    }));

  return {
    provider: def.id,
    indicator,
    description: body.status?.description ?? (indicator === "none" ? "All systems operational" : "Degraded"),
    incidents,
    statusPageUrl: def.statusPageUrl,
    checkedAt: new Date().toISOString(),
  };
}

async function poll(def: ProviderDef): Promise<ProviderStatus> {
  if (!def.statusApiUrl) return unknownStatus(def);
  try {
    const res = await fetch(def.statusApiUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return unknownStatus(def);
    const body = (await res.json()) as StatuspageSummary;
    // Only statuspage.io's shape is understood. A vendor with a bespoke feed
    // (Slack's, for one) parses to nothing and honestly reports "unknown"
    // rather than being coerced into a green light.
    if (!body || typeof body !== "object" || !body.status) return unknownStatus(def);
    return parseSummary(def, body);
  } catch {
    return unknownStatus(def);
  }
}

/* ------------------------------- Public ---------------------------- */

/**
 * One provider's vendor-reported status, from cache when fresh.
 *
 * Never throws and never blocks longer than {@link FETCH_TIMEOUT_MS}: a status
 * page having a bad day must not stop the API Center from rendering.
 */
export async function getProviderStatus(providerId: string): Promise<ProviderStatus> {
  const def = PROVIDER_DEFS.find((p) => p.id === providerId);
  if (!def) {
    return {
      provider: providerId,
      indicator: "unknown",
      description: "Unknown provider",
      incidents: [],
      checkedAt: null,
    };
  }

  const hit = cache.get(providerId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const existing = inflight.get(providerId);
  if (existing) return existing;

  const p = poll(def)
    .then((value) => {
      // Only a real answer refreshes the cache clock. Caching a failed poll for
      // the full TTL would hide a recovering status page for five minutes;
      // caching it briefly still stops a hammering loop, because `inflight`
      // collapses concurrent callers and the next attempt is one request.
      if (value.checkedAt) cache.set(providerId, { value, at: Date.now() });
      return value;
    })
    .finally(() => inflight.delete(providerId));

  inflight.set(providerId, p);
  return p;
}

/**
 * Status for many providers at once, fetched concurrently. Used by the Health
 * screen and the fleet overview.
 */
export async function getProviderStatuses(providerIds: string[]): Promise<Map<string, ProviderStatus>> {
  const unique = [...new Set(providerIds)];
  const results = await Promise.all(unique.map((id) => getProviderStatus(id)));
  return new Map(results.map((r) => [r.provider, r]));
}

/** Cached status only — no network. For paths that must not wait on a vendor. */
export function cachedProviderStatus(providerId: string): ProviderStatus | null {
  return cache.get(providerId)?.value ?? null;
}

/** Every provider currently reporting a live incident. */
export async function activeIncidents(): Promise<ProviderStatus[]> {
  const ids = PROVIDER_DEFS.filter((p) => p.statusApiUrl).map((p) => p.id);
  const map = await getProviderStatuses(ids);
  return [...map.values()].filter((s) => s.indicator !== "none" && s.indicator !== "unknown");
}
