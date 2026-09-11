import { prisma } from "../prisma.js";
import { publishToUser, publishToAdmins } from "./events.js";
import { currentBrandId } from "../lib/brandContext.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { controlPlaneAsTenant, planeOf, type TenantClient } from "./tenantDb.js";

/* ------------------------------------------------------------------ *
 *  In-app notifications follow the person (phase 4): a brand's
 *  customer, admin or staff member keeps theirs in the brand's own
 *  database; the platform's own people keep theirs in the control plane.
 *  Both tables have the same shape, so one function serves both once it
 *  knows whose notification it is writing.
 * ------------------------------------------------------------------ */

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

/**
 * Create an in-app notification for a user. Best-effort — never throws, so callers
 * can fire it with `void notify(...)` without their own try/catch.
 */
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
    // Push a live nudge so the owner's open tabs refresh instantly (no polling),
    // and admin dashboards reflect the new activity in aggregate. Payload is just
    // the type tag — clients re-fetch only what the current screen shows.
    publishToUser(userId, { type: n.type });
    publishToAdmins({ type: n.type });
  } catch {
    /* notifications must never break the action that triggered them */
  }
}

/**
 * The same notification for several accounts that live in ONE plane — a
 * ticket's handlers, say, who are all the brand's people or all the
 * platform's. Best-effort.
 */
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

/**
 * Fan a notification out to the admins who should see it (platform-ops
 * alerts: a sync failure, a grace period lapsing, etc). Best-effort.
 *
 * Tenant rule: the platform's owner hears about everything, in the control
 * plane. A brand's ADMINs hear about their OWN brand, in the brand's database
 * — so one brand's alerts never appear in another's bell.
 */
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

/**
 * Fan a notification out to the CURRENT brand's own admins only — never the
 * platform's super admin. For events about a brand's customer (signup,
 * onboarding, etc): the super admin has no access to any brand's customer
 * panel, so being notified about one customer's activity is just noise, not
 * something they can act on. Best-effort; a no-op with no current brand.
 */
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
