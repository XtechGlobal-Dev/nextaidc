// Human transfer settings + departments (in the brand's own DB), with a best-effort
// live-assistant resync so changes reach inbound calls right away.
import type { Prisma as TenantPrisma } from "@prisma/tenant-client";
import { tenantForUser } from "./tenantDb.js";
import { upsertAssistant } from "./vapi.js";
import { markVapiSyncPending, markVapiSynced } from "./vapiSync.js";
import { integrationsStatus } from "./settings.js";
import type { AgentConfig } from "../lib/agentConfig.js";

/** Settings for one owner. Created lazily on first read. */
export async function getOrCreateSettings(userId: string) {
  const db = await tenantForUser(userId);
  const existing = await db.humanTransferSettings.findUnique({ where: { userId } });
  if (existing) return existing;
  return db.humanTransferSettings.create({ data: { userId } });
}

export async function updateSettings(
  userId: string,
  data: TenantPrisma.HumanTransferSettingsUpdateInput,
) {
  await getOrCreateSettings(userId);
  const db = await tenantForUser(userId);
  const updated = await db.humanTransferSettings.update({ where: { userId }, data });
  resyncAssistant(userId);
  return updated;
}

/** List an owner's departments in display order. */
export async function listDepartments(userId: string) {
  const db = await tenantForUser(userId);
  return db.transferDepartment.findMany({
    where: { userId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

/** Create a department at the end of the list, then resync the live assistant. */
export async function createDepartment(
  userId: string,
  data: {
    name: string;
    number: string;
    description?: string;
    enabled?: boolean;
    ringTimeoutSec?: number;
    fallbackMessage?: string;
  },
) {
  const db = await tenantForUser(userId);
  const count = await db.transferDepartment.count({ where: { userId } });
  const created = await db.transferDepartment.create({
    data: {
      userId,
      name: data.name,
      number: data.number,
      description: data.description ?? "",
      enabled: data.enabled ?? true,
      ...(data.ringTimeoutSec !== undefined ? { ringTimeoutSec: data.ringTimeoutSec } : {}),
      ...(data.fallbackMessage !== undefined ? { fallbackMessage: data.fallbackMessage } : {}),
      order: count,
    },
  });
  resyncAssistant(userId);
  return created;
}

/** Update one department (owner-scoped) and resync the live assistant. */
export async function updateDepartment(
  userId: string,
  id: string,
  data: TenantPrisma.TransferDepartmentUpdateInput,
) {
  const db = await tenantForUser(userId);
  // Scope the update to this owner so a customer can't edit someone else's row.
  const { count } = await db.transferDepartment.updateMany({
    where: { id, userId },
    data,
  });
  if (count === 0) return null;
  resyncAssistant(userId);
  return db.transferDepartment.findUnique({ where: { id } });
}

/** Delete one department (owner-scoped) and resync the live assistant. */
export async function deleteDepartment(userId: string, id: string) {
  const db = await tenantForUser(userId);
  const { count } = await db.transferDepartment.deleteMany({ where: { id, userId } });
  if (count > 0) resyncAssistant(userId);
  return count > 0;
}

/** Replaces the whole department list in one transaction and resyncs once. */
export async function replaceDepartments(
  userId: string,
  list: {
    name: string;
    number: string;
    description?: string;
    enabled?: boolean;
    ringTimeoutSec?: number;
    fallbackMessage?: string;
  }[],
) {
  const db = await tenantForUser(userId);
  await db.$transaction([
    db.transferDepartment.deleteMany({ where: { userId } }),
    ...(list.length
      ? [
          db.transferDepartment.createMany({
            data: list.map((d, i) => ({
              userId,
              name: d.name,
              number: d.number,
              description: d.description ?? "",
              enabled: d.enabled ?? true,
              ...(d.ringTimeoutSec !== undefined ? { ringTimeoutSec: d.ringTimeoutSec } : {}),
              ...(d.fallbackMessage !== undefined ? { fallbackMessage: d.fallbackMessage } : {}),
              order: i,
            })),
          }),
        ]
      : []),
  ]);
  resyncAssistant(userId);
  return listDepartments(userId);
}

/** Re-pushes the live Vapi assistant so a transfer change lands now, not on the next AI-Brain save. Fire-and-forget. */
export function resyncAssistant(userId: string): void {
  void (async () => {
    if (!integrationsStatus().vapi) return;
    // Read outside the try so the catch can queue a retry against this row.
    const db = await tenantForUser(userId);
    const conversion = await db.conversion
      .findUnique({
        where: { userId },
        select: { id: true, vapiAssistantId: true, agentConfig: true },
      })
      .catch(() => null);
    if (!conversion?.vapiAssistantId) return; // no live assistant to update yet
    try {
      const id = await upsertAssistant(
        conversion.agentConfig as unknown as AgentConfig,
        conversion.vapiAssistantId,
        { ownerId: userId },
      );
      if (id && id !== conversion.vapiAssistantId) {
        await db.conversion.update({
          where: { id: conversion.id },
          data: { vapiAssistantId: id },
        });
      }
      await markVapiSynced(db, conversion.id);
    } catch (e) {
      console.error("[transfer] assistant resync failed:", e instanceof Error ? e.message : e);
      // Nobody awaits this, so queue the retry or the stale transfer config stays live.
      await markVapiSyncPending(db, conversion.id, e);
    }
  })();
}
