import { allTenants, type TenantClient } from "./tenantDb.js";
import { integrationsStatus } from "./settings.js";
import { upsertAssistant } from "./vapi.js";
import { notifyAdmins } from "./notifications.js";
import { HttpError } from "../lib/http.js";
import type { AgentConfig } from "../lib/agentConfig.js";

// Retry queue for Vapi config pushes (DB first, Vapi second, so a failed push silently leaves
// callers on the old script). Retries re-read the current config, not the failed payload — idempotent.

// ~5 min first retry, doubling to an hourly cap — heals a blip fast without hammering Vapi forever.
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

// Consecutive failures before admins are told once (~an hour in, so no longer a blip).
const ALERT_AFTER_ATTEMPTS = 5;

// Rows per sweep — drains a wide outage over several ticks instead of stampeding Vapi.
const BATCH = 25;

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

// A 4xx means Vapi rejected the payload; retrying won't change that, so it's recorded
// but not queued (a corrected save clears it). 408/429 are timing, so they retry.
function isRetryable(error: unknown): boolean {
  const status = error instanceof HttpError ? error.status : 0;
  if (!status || status >= 500) return true;
  return status === 408 || status === 429;
}

/** Flags the conversion as out of sync with Vapi. Called from catch blocks, so it never throws. */
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
        // Keep the first timestamp — it answers "how long have callers heard the old script".
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

/** Re-pushes every due config. Repair only — never creates an assistant, or someone who never qualified would get a live agent. */
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
