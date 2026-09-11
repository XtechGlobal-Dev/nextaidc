import { Prisma } from "@prisma/tenant-client";
import { env } from "../env.js";
import {
  isStorageConfigured,
  putJsonObject,
  getJsonObject,
  deleteObject,
} from "./storage.js";
import type { TenantClient } from "./tenantDb.js";

/* ------------------------------------------------------------------ *
 *  Call log tiering — hot in Postgres, cold in S3, then gone.
 *
 *  `call_logs` is the largest table in the schema and three JSON columns are
 *  nearly all of its weight: `transcript`, `analysis` and the cached
 *  `transcriptTranslated`. A ten-minute call's transcript dwarfs every scalar
 *  on the row put together, and none of it is ever aggregated, filtered or
 *  sorted on — it is read only when a human opens that one call.
 *
 *  So the blobs age out. Past CALL_ARCHIVE_AFTER_DAYS they move to a single S3
 *  object per call and the columns are emptied; `blobKey` records where they
 *  went. THE ROW STAYS. Every field reports and billing touch — durationSec,
 *  outcome, intent, summary, createdAt — lives in Postgres forever, so
 *  archiving can never change a number the owner sees. Reads rehydrate through
 *  `hydrateCall`, so an archived call still opens exactly as it did before,
 *  one S3 GET slower.
 *
 *  Deliberately NOT done on write. The Vapi webhook is latency-critical and
 *  currently has no storage dependency at all; putting a synchronous S3 PUT in
 *  that path would mean an S3 outage loses call data. Archiving is a nightly
 *  sweep over calls nobody is looking at.
 *
 *  Calls live in each brand's own database, so every sweep here takes the
 *  brand's client and the scheduler runs it once per tenant. A sweep with a
 *  default client would quietly maintain one database and forget the rest.
 * ------------------------------------------------------------------ */

/** Bucket prefix for archived blobs. One object per call, stable key. */
const PREFIX = "call-blobs";

/** Rows per batch. Small on purpose: each row carries a full transcript, so a
 *  large batch is a large heap spike for no throughput gain — the S3 PUTs, not
 *  the query, are the slow part. */
const BATCH = 100;

/** Batches per sweep, i.e. at most 5,000 calls a night. A backlog drains over
 *  a few nights rather than pinning the box (and the bill) for one long run. */
const MAX_BATCHES = 50;

/** Concurrent S3 operations. Enough to keep the pipe busy, low enough not to
 *  starve the request-serving side of the same process. */
const CONCURRENCY = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The archived payload: exactly the three columns we empty, nothing else. */
interface CallBlobs {
  transcript: unknown;
  analysis: unknown;
  transcriptTranslated: unknown;
}

/** Where a given call's blobs live. Derived, not random, so a re-run overwrites
 *  its own object instead of orphaning one. */
export function blobKeyFor(callId: string): string {
  return `${PREFIX}/${callId}.json`;
}

/** Shape every hydrate/read helper needs. Kept structural so callers can pass a
 *  partial `select` without casting. */
export interface ArchivableCall {
  id: string;
  blobKey?: string | null;
  transcript?: unknown;
  analysis?: unknown;
  transcriptTranslated?: unknown;
}

/**
 * A call's Vapi id.
 *
 * Reads the promoted column first and falls back to `analysis.vapiCallId` for
 * rows logged before that column existed and not yet backfilled. The fallback
 * is what makes the column safe to introduce: no row loses playback while the
 * backfill is pending. Once `npm run backfill-call-ids` has run everywhere, the
 * fallback simply stops being reached.
 *
 * Every recording path must go through this rather than reading `analysis`
 * directly — `analysis` is archivable, the column is not.
 */
export function vapiCallIdOf(
  call: { vapiCallId?: string | null; analysis?: unknown } | null | undefined,
): string | null {
  if (!call) return null;
  if (typeof call.vapiCallId === "string" && call.vapiCallId) return call.vapiCallId;
  const fromAnalysis = (call.analysis as { vapiCallId?: unknown } | null)?.vapiCallId;
  return typeof fromAnalysis === "string" && fromAnalysis ? fromAnalysis : null;
}

/* ---------------------------- Rehydration -------------------------- */

/**
 * Fill an archived call's JSON columns back in from S3.
 *
 * A no-op for a call that was never archived, which is the overwhelming
 * majority — so this is safe to drop in front of any read path. When the blob
 * can't be fetched the call is returned as-is (empty transcript) rather than
 * throwing: a missing object should degrade one panel, not fail the request.
 */
export async function hydrateCall<T extends ArchivableCall>(call: T): Promise<T> {
  if (!call.blobKey) return call;
  const blobs = await getJsonObject<CallBlobs>(call.blobKey);
  if (!blobs) return call;
  return {
    ...call,
    ...("transcript" in call ? { transcript: blobs.transcript ?? [] } : {}),
    ...("analysis" in call ? { analysis: blobs.analysis ?? {} } : {}),
    ...("transcriptTranslated" in call
      ? { transcriptTranslated: blobs.transcriptTranslated ?? null }
      : {}),
  };
}

/* There is deliberately no batch `hydrateCalls`. The only place tempted to use
 * one is the inbox list, where a page can be 500 rows — and paying 500 cold
 * reads to fill fields the table never renders would trade one slow query for
 * something far worse. The list flags archived rows instead and the client
 * fetches the single call it opens. */

/**
 * Persist a lazily-translated transcript for a call that has already been
 * archived.
 *
 * For an archived call the S3 object — not the column — is the source of truth
 * for the three JSON fields, because `hydrateCall` overwrites the columns from
 * it on every read. So a translation written to `transcriptTranslated` would be
 * silently masked the next time anyone opened the call, and re-translated (and
 * re-billed) forever. Rewriting the object keeps one source of truth; the
 * transcript and analysis inside it are carried over untouched.
 */
export async function cacheArchivedTranslation(
  blobKey: string,
  transcriptTranslated: unknown,
): Promise<void> {
  const blobs = await getJsonObject<CallBlobs>(blobKey);
  if (!blobs) return;
  await putJsonObject(blobKey, { ...blobs, transcriptTranslated } satisfies CallBlobs);
}

/* ----------------------------- Archiving --------------------------- */

export interface SweepResult {
  archived: number;
  failed: number;
  /** True when more rows were eligible than MAX_BATCHES allowed this run. */
  more: boolean;
}

/**
 * Move aged-out call blobs to S3.
 *
 * Idempotent and safe to run on several instances at once: the candidate filter
 * excludes anything already carrying a `blobKey`, and because the key is derived
 * from the call id, the worst a race can do is write identical bytes twice.
 *
 * The order matters — PUT first, and only null the columns once it resolved.
 * Nulling first would mean an S3 failure destroys the transcript.
 */
export async function archiveCallBlobs(
  db: TenantClient,
  days = env.CALL_ARCHIVE_AFTER_DAYS,
): Promise<SweepResult> {
  const result: SweepResult = { archived: 0, failed: 0, more: false };
  if (days <= 0 || !isStorageConfigured()) return result;

  const cutoff = new Date(Date.now() - days * DAY_MS);

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const candidates = await db.callLog.findMany({
      where: {
        createdAt: { lt: cutoff },
        blobKey: null,
        // Rows whose blobs are already empty gain nothing from an S3 object and
        // a wasted PUT — skip them, or every sweep would re-scan the same
        // never-archivable rows forever.
        OR: [
          { NOT: { transcript: { equals: [] } } },
          { NOT: { analysis: { equals: {} } } },
          { NOT: { transcriptTranslated: { equals: Prisma.DbNull } } },
        ],
      },
      select: {
        id: true,
        // Half of the partitioned primary key — the update below uses it to
        // write straight into the one month's partition.
        createdAt: true,
        transcript: true,
        analysis: true,
        transcriptTranslated: true,
      },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (candidates.length === 0) return result;

    const outcomes = await mapWithConcurrency(candidates, CONCURRENCY, async (call) => {
      const key = blobKeyFor(call.id);
      try {
        await putJsonObject(key, {
          transcript: call.transcript,
          analysis: call.analysis,
          transcriptTranslated: call.transcriptTranslated,
        } satisfies CallBlobs);
      } catch {
        // Leave the row untouched — the blobs are still in Postgres, and the
        // next sweep picks it up again.
        return false;
      }
      await db.callLog.update({
        where: { id_createdAt: { id: call.id, createdAt: call.createdAt } },
        data: {
          transcript: [],
          analysis: {},
          transcriptTranslated: Prisma.DbNull,
          blobKey: key,
          blobArchivedAt: new Date(),
        },
      });
      return true;
    });

    result.archived += outcomes.filter(Boolean).length;
    result.failed += outcomes.filter((ok) => !ok).length;

    // A short batch means the eligible set is exhausted.
    if (candidates.length < BATCH) return result;
    // Every row in this batch failed its PUT — storage is down, so stop rather
    // than spin through MAX_BATCHES re-reading the same rows.
    if (!outcomes.some(Boolean)) return result;
  }

  result.more = true;
  return result;
}

/* ----------------------------- Retention --------------------------- */

/**
 * Delete call logs past the retention window, blob and all.
 *
 * Off by default (CALL_RETENTION_DAYS = 0) and it should stay off unless an
 * operator has decided otherwise: these rows carry billed minutes and feed
 * reports, so deleting them silently would quietly rewrite history.
 *
 * The bucket object goes first. Deleting the row first would strand the blob
 * with nothing left pointing at it — a leak that only ever grows, and the exact
 * thing this whole file exists to avoid.
 */
export async function pruneCallLogs(db: TenantClient, days = env.CALL_RETENTION_DAYS): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * DAY_MS);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const doomed = await db.callLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, blobKey: true },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (doomed.length === 0) return deleted;

    const keys = doomed.map((c) => c.blobKey).filter((k): k is string => Boolean(k));
    await mapWithConcurrency(keys, CONCURRENCY, (k) => deleteObject(k));

    const { count } = await db.callLog.deleteMany({
      where: { id: { in: doomed.map((c) => c.id) } },
    });
    deleted += count;

    if (doomed.length < BATCH) return deleted;
  }
  return deleted;
}

/** Drop the archived blob for calls being deleted for some other reason (a
 *  closed account, say), so the bucket doesn't accumulate orphans. */
export async function deleteCallBlobs(db: TenantClient, callIds: string[]): Promise<void> {
  if (callIds.length === 0) return;
  const rows = await db.callLog.findMany({
    where: { id: { in: callIds }, NOT: { blobKey: null } },
    select: { blobKey: true },
  });
  const keys = rows.map((r) => r.blobKey).filter((k): k is string => Boolean(k));
  await mapWithConcurrency(keys, CONCURRENCY, (k) => deleteObject(k));
}

/* ------------------------------ Helpers ---------------------------- */

/** Run `fn` over `items` at most `limit` at a time, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
