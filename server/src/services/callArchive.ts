import { Prisma } from "@prisma/tenant-client";
import { env } from "../env.js";
import {
  isStorageConfigured,
  putJsonObject,
  getJsonObject,
  deleteObject,
} from "./storage.js";
import type { TenantClient } from "./tenantDb.js";

// Call log tiering: past CALL_ARCHIVE_AFTER_DAYS the three JSON blobs move to one S3 object per call and the columns
// empty; THE ROW STAYS so billing numbers never change. Nightly sweep per tenant, never on the latency-critical Vapi webhook path.

/** Bucket prefix for archived blobs. One object per call, stable key. */
const PREFIX = "call-blobs";

// Small on purpose: each row carries a full transcript, and the S3 PUTs, not the query, are the slow part.
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

/** A call's Vapi id: the column first, then analysis.vapiCallId for un-backfilled rows. Every recording path must use this — `analysis` is archivable, the column is not. */
export function vapiCallIdOf(
  call: { vapiCallId?: string | null; analysis?: unknown } | null | undefined,
): string | null {
  if (!call) return null;
  if (typeof call.vapiCallId === "string" && call.vapiCallId) return call.vapiCallId;
  const fromAnalysis = (call.analysis as { vapiCallId?: unknown } | null)?.vapiCallId;
  return typeof fromAnalysis === "string" && fromAnalysis ? fromAnalysis : null;
}

/* ---------------------------- Rehydration -------------------------- */

/** Refills an archived call's JSON columns from S3. No-op when never archived; a missing blob returns the call as-is rather than failing the request. */
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

// Deliberately no batch hydrateCalls: a 500-row inbox page would pay 500 cold reads for fields
// it never renders. The list flags archived rows and the client fetches the one it opens.

/** Saves a translation into an archived call's S3 object. hydrateCall overwrites the columns from it on every read, so writing the column instead would be masked and re-billed forever. */
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

/** Moves aged-out blobs to S3. Idempotent across instances (derived key, blobKey filter). PUT first, null the columns only after — the other order destroys transcripts on S3 failure. */
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
        // Skip rows with already-empty blobs, or every sweep re-scans the same never-archivable rows forever.
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

/** Deletes call logs past retention, blob and all. Off by default — these rows carry billed minutes. Blob goes first; deleting the row first strands the object forever. */
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
