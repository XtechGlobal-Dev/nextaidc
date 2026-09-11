import { allTenants, type TenantClient } from "./tenantDb.js";
import { integrationsStatus } from "./settings.js";
import { upsertAssistant } from "./vapi.js";
import { notifyAdmins } from "./notifications.js";
import { HttpError } from "../lib/http.js";
import type { AgentConfig } from "../lib/agentConfig.js";

/**
 * Retry queue for config pushes to the live Vapi assistant.
 *
 * Every save path writes the config to the DB first and pushes to Vapi second,
 * best-effort — an outage must never cost the owner their edits. The cost of
 * that ordering is a silent divergence: the dashboard shows the new settings
 * while real callers still hear the old ones, and nothing retries.
 *
 * So a failed push marks the conversion pending and the scheduler drains the
 * queue. The retry re-reads whatever config is saved NOW rather than replaying
 * the payload that failed, which makes it correct regardless of how many saves
 * happened in between — the live assistant converges on the latest config, and
 * the queue is idempotent (a redundant push is a no-op PATCH).
 */

/** First retry ~5 min after a failure, doubling to an hourly floor. Fast enough
 *  to self-heal a short outage before anyone notices; slow enough that a config
 *  Vapi will never accept doesn't hammer them forever. */
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Consecutive failures before admins are told once. At this point the backoff
 *  has spanned roughly an hour, so it's no longer a blip — either Vapi is having
 *  a real incident or this specific config is being rejected. */
const ALERT_AFTER_ATTEMPTS = 5;

/** Rows per sweep. Each one is a network round-trip to Vapi, so a wide outage is
 *  drained over several ticks instead of stampeding a provider that just came
 *  back up. Oldest divergence first, so the most stale agent is fixed first. */
const BATCH = 25;

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Is this failure worth retrying?
 *
 * A 4xx means Vapi rejected the payload itself — an unknown voice id, a field it
 * won't take. That verdict doesn't change with time, so re-pushing the same
 * config in five minutes and again every hour would just be noise against a
 * provider that has already given its answer. Those are still recorded (the
 * account IS out of sync, and the reason belongs in vapiSyncError), they're just
 * not queued: the fix is a corrected config, and saving one clears the flag.
 *
 * 408/429 are the exceptions — those are about timing, not content. Everything
 * else (5xx, network failures, and the 502 that vapiFetch maps upstream auth
 * errors to) is transient and gets the backoff.
 */
function isRetryable(error: unknown): boolean {
  const status = error instanceof HttpError ? error.status : 0;
  if (!status || status >= 500) return true;
  return status === 408 || status === 429;
}

/**
 * Record that the live assistant no longer matches the saved config. Called from
 * catch blocks, so it never throws — a failure to record the failure must not
 * turn a best-effort push into a failed save.
 */
export async function markVapiSyncPending(db: TenantClient, conversionId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? "Vapi sync failed");
  try {
    const row = await db.conversion.findUnique({
      where: { id: conversionId },
      select: { vapiSyncPendingAt: true, vapiSyncAttempts: true },
    });
    if (!row) return;
    const attempts = row.vapiSyncAttempts + 1;
    await db.conversion.update({
      where: { id: conversionId },
      data: {
        // Keep the original timestamp on repeat failures — it answers "how long
        // have callers been hearing the old script", which a last-attempt time
        // would hide.
        vapiSyncPendingAt: row.vapiSyncPendingAt ?? new Date(),
        // Null parks the row: still flagged out of sync, but the sweep won't pick
        // it up because no amount of retrying will change Vapi's answer.
        vapiSyncNextAt: isRetryable(error) ? new Date(Date.now() + backoffMs(attempts)) : null,
        vapiSyncAttempts: attempts,
        vapiSyncError: message.slice(0, 500),
      },
    });
  } catch (e) {
    console.warn("[vapiSync] could not flag pending sync:", e instanceof Error ? e.message : e);
  }
}

/** Clear the pending flag after a successful push. Never throws. */
export async function markVapiSynced(db: TenantClient, conversionId: string): Promise<void> {
  try {
    // Filtered updateMany so the overwhelmingly common already-in-sync save costs
    // no write at all.
    await db.conversion.updateMany({
      where: { id: conversionId, NOT: { vapiSyncPendingAt: null } },
      data: {
        vapiSyncPendingAt: null,
        vapiSyncNextAt: null,
        vapiSyncAttempts: 0,
        vapiSyncError: null,
      },
    });
  } catch (e) {
    console.warn("[vapiSync] could not clear pending sync:", e instanceof Error ? e.message : e);
  }
}

/**
 * Re-push every config whose retry is due. Strictly a repair pass: it only
 * touches accounts that ALREADY have a live assistant, and never creates one.
 * Provisioning stays owned by picking a plan / claiming a number — an account
 * without an assistant isn't out of sync, it just isn't live yet, and creating
 * one here would hand a live agent to someone who never qualified for it.
 */
export async function retryPendingVapiSyncs(): Promise<{ attempted: number; recovered: number }> {
  if (!integrationsStatus().vapi) return { attempted: 0, recovered: 0 };

  // Every brand's database has its own queue; one pass gathers them all.
  const due = (
    await Promise.all(
      (await allTenants()).map(async ({ db }) =>
        (
          await db.conversion.findMany({
    where: {
      vapiSyncPendingAt: { not: null },
      vapiAssistantId: { not: null },
      // A null vapiSyncNextAt never matches, which is the point — that's how a
      // config Vapi rejected outright is kept out of the queue.
      vapiSyncNextAt: { lte: new Date() },
    },
    orderBy: { vapiSyncPendingAt: "asc" },
    take: BATCH,
    select: {
      id: true,
      userId: true,
      vapiAssistantId: true,
      agentConfig: true,
      vapiSyncAttempts: true,
    },
          })
        ).map((c) => ({ ...c, db })),
      ),
    )
  ).flat();

  let recovered = 0;
  for (const conv of due) {
    if (!conv.vapiAssistantId) continue; // the `not: null` filter doesn't narrow the type
    try {
      const id = await upsertAssistant(
        conv.agentConfig as unknown as AgentConfig,
        conv.vapiAssistantId,
        { ownerId: conv.userId },
      );
      // upsertAssistant recreates an assistant Vapi no longer has, so persist the
      // new id — otherwise the number keeps routing to a dead one.
      if (id && id !== conv.vapiAssistantId) {
        await conv.db.conversion.update({ where: { id: conv.id }, data: { vapiAssistantId: id } });
      }
      await markVapiSynced(conv.db, conv.id);
      recovered++;
    } catch (e) {
      await markVapiSyncPending(conv.db, conv.id, e);
      // Fires once, on the crossing tick only, so a long outage doesn't spam the
      // admin inbox every five minutes.
      if (conv.vapiSyncAttempts + 1 === ALERT_AFTER_ATTEMPTS) {
        void notifyAdmins({
          type: "system",
          title: "An AI agent is stuck out of sync",
          message:
            `A saved config has failed to reach Vapi ${ALERT_AFTER_ATTEMPTS} times — ` +
            `callers are still hearing the previous script. Last error: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  return { attempted: due.length, recovered };
}
