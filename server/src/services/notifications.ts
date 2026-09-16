import { prisma } from "../prisma.js";
import { publishToUser, publishToAdmins } from "./events.js";
import { currentBrandId } from "../lib/brandContext.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { controlPlaneAsTenant, planeOf, type TenantClient } from "./tenantDb.js";

// Notifications follow the person: a brand's people keep theirs in the brand DB,
// the platform's own in the control plane. Same table shape in both.

export interface NotificationInput {
  type: string; // missed_call | new_lead | billing | agent | system | ticket
  title: string;
  message?: string;
  link?: string;
}

/** Where one account's notifications live. */
export async function notificationsOf(userId: string): Promise<TenantClient> {
  return planeOf(await brandIdForOwner(userId));
}

/** Creates an in-app notification. Never throws, so `void notify(...)` is safe. */
export async function notify(userId: string, n: NotificationInput): Promise<void> {
  try {
    const db = await notificationsOf(userId);
    await db.notification.create({
      data: {
        userId,
        type: n.type,
        title: n.title,
        message: n.message ?? "",
        link: n.link ?? null,
      },
    });
    // Live nudge; payload is just the type tag, clients re-fetch what they show.
    publishToUser(userId, { type: n.type });
    publishToAdmins({ type: n.type });
  } catch {
    /* notifications must never break the action that triggered them */
  }
}

/** Same notification for several accounts that all live in ONE plane. Best-effort. */
export async function notifyIn(db: TenantClient, userIds: string[], n: NotificationInput): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await db.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: n.type,
        title: n.title,
        message: n.message ?? "",
        link: n.link ?? null,
      })),
    });
  } catch {
    /* best-effort */
  }
}

/** Platform-ops alert fan-out. Platform owner hears everything; a brand's admins hear only their own brand, in their own DB. */
export async function notifyAdmins(n: NotificationInput): Promise<void> {
  try {
    const brandId = currentBrandId();
    if (brandId) {
      const tenant = await planeOf(brandId);
      const admins = await tenant.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
      await notifyIn(
        tenant,
        admins.map((a) => a.id),
        n,
      );
    }
    const owners = await prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
    await notifyIn(
      controlPlaneAsTenant(),
      owners.map((o) => o.id),
      n,
    );
    // Live nudge to every admin/staff tab (e.g. a new signup) — no polling needed.
    publishToAdmins({ type: n.type });
  } catch {
    /* best-effort */
  }
}

/** Current brand's admins only — the super admin can't open a brand's customer panel, so it'd be noise. No-op without a brand. */
export async function notifyBrandAdmins(n: NotificationInput): Promise<void> {
  try {
    const brandId = currentBrandId();
    if (!brandId) return;
    const tenant = await planeOf(brandId);
    const admins = await tenant.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    await notifyIn(
      tenant,
      admins.map((a) => a.id),
      n,
    );
    publishToAdmins({ type: n.type });
  } catch {
    /* best-effort */
  }
}

export async function listNotifications(db: TenantClient, userId: string, limit = 50) {
  return db.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Mark one notification read — scoped to the owner so users can't touch others'. */
export async function markNotificationRead(db: TenantClient, userId: string, id: string): Promise<void> {
  await db.notification.updateMany({
    where: { id, userId },
    data: { read: true },
  });
}

export async function markAllNotificationsRead(db: TenantClient, userId: string): Promise<void> {
  await db.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function clearNotifications(db: TenantClient, userId: string): Promise<void> {
  await db.notification.deleteMany({ where: { userId } });
}
