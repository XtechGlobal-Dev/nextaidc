// Write side of the API Center: every outbound vendor call is recorded here. Rules: telemetry never
// fails or blocks the request it measures (buffered, fire-and-forget), and the freshest facts live in an in-memory snapshot.

import { prisma } from "../prisma.js";
import { providerDefOrFallback, type ProviderDef } from "./apiProviders.js";

/* ----------------------------- Tunables ---------------------------- */

/** Flush whenever the buffer reaches this many rows… */
const FLUSH_AT_ROWS = 50;
/** …or this often, whichever comes first. */
const FLUSH_EVERY_MS = 5_000;
// Hard ceiling: past this the OLDEST rows are dropped. Losing old telemetry during a DB outage beats an OOM.
const MAX_BUFFER = 5_000;

/** How long request rows are kept. Older rows are pruned by the daily sweep. */
export const RETENTION_DAYS = 45;

/** Chars of a vendor error message worth storing — enough to identify the
 *  failure, short enough that a runaway HTML error page can't bloat the table. */
const MAX_ERROR_CHARS = 500;

/* --------------------------- Public types -------------------------- */

export type ApiEnvironment = "production" | "sandbox";

export interface TraceInput {
  provider: string;
  /** Raw path or URL — normalised before storage (see {@link normalizeEndpoint}). */
  endpoint?: string;
  method?: string;
  /** HTTP status; 0 means no response was received at all. */
  status?: number;
  ok?: boolean;
  durationMs: number;
  environment?: ApiEnvironment;
  errorCode?: string;
  errorMessage?: string;
  /** Billable units (tokens, chars, seconds, segments). Omit when unmeasurable; cost then falls back to per-request pricing rather than pretending the call was free. */
  units?: number;
  /** Rate-limit headroom advertised on the response, when the vendor advertises any. */
  rateLimit?: number | null;
  rateRemaining?: number | null;
  rateResetAt?: Date | null;
}

/** The freshest per-provider facts, held in memory (see rule 3 above). */
export interface ProviderSnapshot {
  lastRequestAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string;
  lastErrorStatus: number;
  lastLatencyMs: number;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: Date | null;
}

/* ------------------------- Endpoint grouping ----------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID_RE = /^c[a-z0-9]{20,}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;
/** Twilio-style prefixed ids: AC…, SM…, PN…, CA… */
const PREFIXED_ID_RE = /^[A-Z]{2}[0-9a-f]{30,}$/;
/** A dated API version segment, e.g. Twilio's `/2010-04-01/`. */
const DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

// Telephony vendors put phone numbers in the path, so they must collapse — but a dated
// API version (/2010-04-01/) looks similar and collapsing it would hide a half-finished migration.
function looksLikePhoneNumber(seg: string): boolean {
  if (DATE_VERSION_RE.test(seg)) return false;
  // Digits and the punctuation people write numbers with — nothing else.
  if (!/^[+(]?[\d\-() .]+$/.test(seg)) return false;
  const digits = seg.replace(/\D/g, "");
  // E.164 allows up to 15 digits; below 7 it isn't a dialable number.
  return digits.length >= 7 && digits.length <= 15;
}

/** Collapses ids in a path so calls to one endpoint group into one row. Query strings are dropped entirely — they routinely carry keys and phone numbers. */
export function normalizeEndpoint(raw: string): string {
  if (!raw) return "";
  let path = raw;
  // Strip scheme + host so the same endpoint groups regardless of base URL.
  const schemeAt = path.indexOf("://");
  if (schemeAt !== -1) {
    const slash = path.indexOf("/", schemeAt + 3);
    path = slash === -1 ? "/" : path.slice(slash);
  }
  path = path.split("?")[0].split("#")[0];

  const parts = path.split("/").map((seg) => {
    if (!seg) return seg;
    if (
      UUID_RE.test(seg) ||
      CUID_RE.test(seg) ||
      NUMERIC_RE.test(seg) ||
      PREFIXED_ID_RE.test(seg) ||
      LONG_HEX_RE.test(seg)
    ) {
      return ":id";
    }
    if (looksLikePhoneNumber(seg)) return ":id";
    return seg;
  });

  const joined = parts.join("/") || "/";
  return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
}

/* ------------------------ Provider price cache --------------------- */

interface PriceRow {
  unitCostMicroUsd: number | null;
  environment: string;
}

let priceCache: Map<string, PriceRow> | null = null;
let priceCacheAt = 0;
const PRICE_TTL_MS = 60_000;

// Price overrides, cached a minute. Cost is computed on the write path (a row must record
// what it cost at the time), and a DB read per call would defeat the buffer.
async function priceRows(): Promise<Map<string, PriceRow>> {
  const now = Date.now();
  if (priceCache && now - priceCacheAt < PRICE_TTL_MS) return priceCache;
  try {
    const rows = await prisma.apiProviderSetting.findMany({
      select: { provider: true, unitCostMicroUsd: true, environment: true },
    });
    priceCache = new Map(
      rows.map((r) => [r.provider, { unitCostMicroUsd: r.unitCostMicroUsd, environment: r.environment }]),
    );
    priceCacheAt = now;
  } catch {
    // Keep serving the previous cache (or code defaults) rather than failing a
    // flush over a price lookup.
    priceCache = priceCache ?? new Map();
    priceCacheAt = now;
  }
  return priceCache;
}

/** Drop the cache so an admin's price/environment edit takes effect at once. */
export function invalidateProviderPriceCache(): void {
  priceCache = null;
  priceCacheAt = 0;
}

// Micro-USD for one call. Unmeasured units fall back to one per request; costConfidence
// already tells the UI to treat that as an estimate.
function computeCostMicroUsd(def: ProviderDef, units: number, override: number | null | undefined): number {
  const perUnitMicro =
    override ?? (def.defaultUnitCostUsd !== undefined ? Math.round(def.defaultUnitCostUsd * 1_000_000) : 0);
  if (!perUnitMicro) return 0;
  const billable = units > 0 ? units : def.unit === "none" ? 0 : 1;
  return Math.round(perUnitMicro * billable);
}

/* --------------------------- Live snapshot ------------------------- */

const snapshots = new Map<string, ProviderSnapshot>();

function blankSnapshot(): ProviderSnapshot {
  return {
    lastRequestAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: "",
    lastErrorStatus: 0,
    lastLatencyMs: 0,
    rateLimit: null,
    rateRemaining: null,
    rateResetAt: null,
  };
}

/** The in-memory snapshot for one provider, or null if it hasn't been called
 *  since this process started. */
export function providerSnapshot(provider: string): ProviderSnapshot | null {
  return snapshots.get(provider) ?? null;
}

export function allSnapshots(): Map<string, ProviderSnapshot> {
  return snapshots;
}

/* ------------------------------ Buffer ----------------------------- */

interface BufferedRow {
  provider: string;
  endpoint: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs: number;
  environment: string;
  errorCode: string;
  errorMessage: string;
  units: number;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: Date | null;
  createdAt: Date;
}

let buffer: BufferedRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
/** Rows discarded because the buffer hit its ceiling — surfaced on the Logs
 *  screen so a gap in the data is never mistaken for a quiet period. */
let droppedRows = 0;

export function droppedRowCount(): number {
  return droppedRows;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTraces();
  }, FLUSH_EVERY_MS);
  // Never hold the process open for a telemetry flush.
  flushTimer.unref?.();
}

/** Writes buffered rows; concurrent calls collapse into one. A failed batch is DISCARDED, not requeued — retrying against a down DB becomes a retry loop competing with real traffic. */
export async function flushTraces(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const prices = await priceRows();
    const data = batch.map((row) => {
      const def = providerDefOrFallback(row.provider);
      const override = prices.get(row.provider)?.unitCostMicroUsd;
      return {
        provider: row.provider,
        endpoint: row.endpoint,
        method: row.method,
        status: row.status,
        ok: row.ok,
        durationMs: row.durationMs,
        environment: row.environment,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        units: row.units,
        // Only successful calls cost anything — counting a vendor 500 would inflate spend exactly when they misbehave.
        costMicroUsd: row.ok ? computeCostMicroUsd(def, row.units, override) : 0,
        rateLimit: row.rateLimit,
        rateRemaining: row.rateRemaining,
        rateResetAt: row.rateResetAt,
        createdAt: row.createdAt,
      };
    });
    await prisma.apiRequestLog.createMany({ data });
  } catch {
    // Deliberately silent and deliberately lossy — see the doc comment.
  } finally {
    flushing = false;
  }
}

/* ------------------------------ Record ----------------------------- */

/** Records one outbound call. Synchronous, non-throwing and cheap; prefer traceFetch, which fills most of this in. */
export function recordApiCall(input: TraceInput): void {
  try {
    const provider = input.provider;
    const now = new Date();
    const ok = input.ok ?? (input.status !== undefined && input.status >= 200 && input.status < 400);
    const errorMessage = (input.errorMessage ?? "").slice(0, MAX_ERROR_CHARS);

    // --- live snapshot (rule 3) ---
    const snap = snapshots.get(provider) ?? blankSnapshot();
    snap.lastRequestAt = now;
    snap.lastLatencyMs = input.durationMs;
    if (ok) {
      snap.lastSuccessAt = now;
    } else {
      snap.lastErrorAt = now;
      snap.lastErrorMessage = errorMessage;
      snap.lastErrorStatus = input.status ?? 0;
    }
    if (input.rateLimit != null) snap.rateLimit = input.rateLimit;
    if (input.rateRemaining != null) snap.rateRemaining = input.rateRemaining;
    if (input.rateResetAt != null) snap.rateResetAt = input.rateResetAt;
    snapshots.set(provider, snap);

    // --- buffered row ---
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift();
      droppedRows++;
    }
    buffer.push({
      provider,
      endpoint: normalizeEndpoint(input.endpoint ?? ""),
      method: (input.method ?? "GET").toUpperCase(),
      status: input.status ?? 0,
      ok,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      environment: input.environment ?? "production",
      errorCode: (input.errorCode ?? "").slice(0, 80),
      errorMessage,
      units: input.units && input.units > 0 ? input.units : 0,
      rateLimit: input.rateLimit ?? null,
      rateRemaining: input.rateRemaining ?? null,
      rateResetAt: input.rateResetAt ?? null,
      createdAt: now,
    });

    if (buffer.length >= FLUSH_AT_ROWS) void flushTraces();
    else scheduleFlush();
  } catch {
    // A tracer must never throw into the call it is measuring.
  }
}

/* --------------------------- Header capture ------------------------ */

function toInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// "Reset" arrives as a unix timestamp, seconds-from-now, or ISO date. Guess by magnitude:
// under a day's worth of seconds is a duration, anything larger is absolute.
function parseReset(value: string | null): Date | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    if (n < 86_400) return new Date(Date.now() + n * 1000);
    // Seconds vs milliseconds since the epoch.
    return new Date(n < 10_000_000_000 ? n * 1000 : n);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const NO_RATE_LIMIT = { rateLimit: null, rateRemaining: null, rateResetAt: null };

// Defensive on purpose: SDK fetch-alikes and test doubles may omit `headers` entirely,
// and the tracer must never throw into the call it measures.
function readRateLimitHeaders(def: ProviderDef, headers: Headers | undefined | null) {
  const spec = def.rateLimitHeaders;
  if (!spec || !headers || typeof headers.get !== "function") return NO_RATE_LIMIT;
  try {
    return {
      rateLimit: toInt(headers.get(spec.limit)),
      rateRemaining: toInt(headers.get(spec.remaining)),
      rateResetAt: parseReset(headers.get(spec.reset)),
    };
  } catch {
    return NO_RATE_LIMIT;
  }
}

/* ---------------------------- traceFetch --------------------------- */

export interface TraceFetchOptions {
  /** Billable units, when the call site knows them up front (e.g. characters sent). */
  units?: number;
  /** Derive billable units from the parsed response — for token counts and the like. */
  unitsFromResponse?: (body: unknown) => number;
  environment?: ApiEnvironment;
  /** Override the recorded endpoint when the URL alone doesn't identify the operation. */
  endpoint?: string;
}

/** Drop-in `fetch` that records itself. Response and errors pass through untouched; transport failures record as status 0 and re-throw; unitsFromResponse reads a clone so the body stays unconsumed. */
export async function traceFetch(
  provider: string,
  url: string,
  init?: RequestInit,
  opts: TraceFetchOptions = {},
): Promise<Response> {
  const def = providerDefOrFallback(provider);
  const started = Date.now();
  const method = (init?.method ?? "GET").toUpperCase();
  const endpoint = opts.endpoint ?? url;

  try {
    const res = await fetch(url, init);
    const durationMs = Date.now() - started;
    const { rateLimit, rateRemaining, rateResetAt } = readRateLimitHeaders(def, res.headers);

    let units = opts.units ?? 0;
    let errorMessage = "";

    // Read the body only when there's a reason to: a failure worth describing,
    // or a unit count worth extracting. Always from a clone, never the original.
    if (!res.ok || opts.unitsFromResponse) {
      try {
        const text = await res.clone().text();
        if (!res.ok) errorMessage = text.slice(0, MAX_ERROR_CHARS);
        if (opts.unitsFromResponse && res.ok && text) {
          try {
            units = opts.unitsFromResponse(JSON.parse(text)) || units;
          } catch {
            /* not JSON, or the extractor didn't like it — units stay as given */
          }
        }
      } catch {
        /* body already consumed or unreadable — the status alone still tells the story */
      }
    }

    recordApiCall({
      provider,
      endpoint,
      method,
      status: res.status,
      ok: res.ok,
      durationMs,
      environment: opts.environment,
      errorCode: res.ok ? "" : String(res.status),
      errorMessage,
      units,
      rateLimit,
      rateRemaining,
      rateResetAt,
    });
    return res;
  } catch (err) {
    recordApiCall({
      provider,
      endpoint,
      method,
      status: 0,
      ok: false,
      durationMs: Date.now() - started,
      environment: opts.environment,
      errorCode: (err as { code?: string })?.code ?? "NETWORK",
      errorMessage: err instanceof Error ? err.message : "Network error",
      units: opts.units ?? 0,
    });
    throw err;
  }
}

/** Times and records an SDK call (Stripe, nodemailer, Twilio) where there's no Response to inspect. Result and errors pass through untouched. */
export async function traceCall<T>(
  provider: string,
  endpoint: string,
  fn: () => Promise<T>,
  opts: { units?: number; method?: string; environment?: ApiEnvironment } = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    recordApiCall({
      provider,
      endpoint,
      method: opts.method ?? "POST",
      status: 200,
      ok: true,
      durationMs: Date.now() - started,
      units: opts.units,
      environment: opts.environment,
    });
    return result;
  } catch (err) {
    // SDKs surface the upstream status under several different names.
    const e = err as { status?: number; statusCode?: number; code?: string | number; message?: string };
    recordApiCall({
      provider,
      endpoint,
      method: opts.method ?? "POST",
      status: e?.status ?? e?.statusCode ?? 0,
      ok: false,
      durationMs: Date.now() - started,
      errorCode: String(e?.code ?? e?.status ?? "ERROR"),
      errorMessage: e?.message ?? "Request failed",
      environment: opts.environment,
    });
    throw err;
  }
}

/* ----------------------------- Retention --------------------------- */

/** Drops request rows past the retention window; returns the count so the sweep can be logged. */
export async function pruneApiRequestLogs(days = RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.apiRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
  } catch {
    return 0;
  }
}

/* ---------------------------- Shutdown ----------------------------- */

let shutdownHooked = false;

/** Flush on the way out so the last few seconds of telemetry aren't lost on deploy. */
export function installTraceShutdownHook(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const onExit = () => {
    void flushTraces();
  };
  process.once("SIGTERM", onExit);
  process.once("SIGINT", onExit);
  process.once("beforeExit", onExit);
}
