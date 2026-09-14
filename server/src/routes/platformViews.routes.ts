import express from "express";
import type { Prisma as TenantPrisma } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { asyncHandler, notFound } from "../lib/http.js";
import { audit } from "../services/audit.js";
import { tenantFor, type TenantClient } from "../services/tenantDb.js";
import { platformOverview, rollupBrandStats, utcDay, ACTIVE_SUB_STATUSES } from "../services/brandStats.js";
import { searchDirectory } from "../services/customerDirectory.js";

// Super-admin platform views. Platform-wide screens read Main only (rollup, ledger,
// directory); one brand's inside reads that brand's tenant DB and nothing else.

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function paging(req: express.Request, defaultSize = 25): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || defaultSize), 100);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** The brand plus the one tenant DB its screens read; a non-active tenant surfaces as the usual tenant error. */
async function openBrand(id: string): Promise<{ brand: { id: string; name: string; slug: string }; db: TenantClient }> {
  const brand = await prisma.brand.findUnique({ where: { id }, select: { id: true, name: true, slug: true } });
  if (!brand) throw notFound("Brand not found");
  return { brand, db: await tenantFor(brand.id) };
}

// Platform-wide (Main only).

/** Everything on the super admin's overview — from Main, as of the last rollup. */
router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(await platformOverview());
  }),
);

/** Roll every brand up NOW (today's row), for when last night is not recent enough. */
router.post(
  "/stats/rollup",
  asyncHandler(async (req, res) => {
    const result = await rollupBrandStats(utcDay());
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "platform.stats_rollup",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

/** Find a person by email or name, whichever brand they are in. */
router.get(
  "/directory",
  asyncHandler(async (req, res) => {
    const q = str(req.query.q);
    const hits = q ? await searchDirectory(q, 25) : [];
    res.json({ q, hits });
  }),
);

// One brand's inside (that tenant's DB only).

/** The brand's customers, from the brand's database. */
router.get(
  "/brands/:id/customers",
  asyncHandler(async (req, res) => {
    const { brand, db } = await openBrand(req.params.id);
    const q = str(req.query.q);
    const { page, pageSize, skip } = paging(req);
    const where: TenantPrisma.UserWhereInput = {
      role: "USER",
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { fullName: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: { id: true, email: true, fullName: true, createdAt: true },
      }),
      db.user.count({ where }),
    ]);
    const profiles = users.length
      ? await db.profile.findMany({
          where: { userId: { in: users.map((u) => u.id) } },
          select: {
            userId: true,
            businessName: true,
            plan: true,
            subscriptionPlanId: true,
            subscriptionStatus: true,
            receptionistNumber: true,
            trialSecondsUsed: true,
            planSecondsUsed: true,
            onboardingCompletedAt: true,
          },
        })
      : [];
    const planNames = await planNamesFor(profiles.map((p) => p.subscriptionPlanId));
    const byUser = new Map(profiles.map((p) => [p.userId, p]));
    res.json({
      brand,
      page,
      pageSize,
      total,
      items: users.map((u) => {
        const p = byUser.get(u.id);
        return {
          id: u.id,
          email: u.email,
          fullName: u.fullName,
          createdAt: u.createdAt,
          businessName: p?.businessName ?? "",
          plan: p?.plan ?? "free",
          planName: p?.subscriptionPlanId ? (planNames.get(p.subscriptionPlanId) ?? "") : "",
          subscriptionStatus: p?.subscriptionStatus ?? "none",
          receptionistNumber: p?.receptionistNumber ?? "",
          minutesUsed: Math.round(((p?.trialSecondsUsed ?? 0) + (p?.planSecondsUsed ?? 0)) / 60),
          onboarded: !!p?.onboardingCompletedAt,
        };
      }),
    });
  }),
);

/** The brand's subscriptions: the mix, and who is on what. From the brand's database. */
router.get(
  "/brands/:id/subscriptions",
  asyncHandler(async (req, res) => {
    const { brand, db } = await openBrand(req.params.id);
    const [byStatus, byPlan, profiles] = await Promise.all([
      db.profile.groupBy({ by: ["subscriptionStatus"], _count: { _all: true } }),
      db.profile.groupBy({
        by: ["subscriptionPlanId"],
        where: { subscriptionStatus: { in: [...ACTIVE_SUB_STATUSES, "trialing"] } },
        _count: { _all: true },
      }),
      db.profile.findMany({
        where: { subscriptionStatus: { not: "none" } },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: {
          userId: true,
          subscriptionPlanId: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          autoRenew: true,
          planMinutesAllocated: true,
          planSecondsUsed: true,
          updatedAt: true,
        },
      }),
    ]);
    const [users, planNames] = await Promise.all([
      profiles.length
        ? db.user.findMany({
            where: { id: { in: profiles.map((p) => p.userId) } },
            select: { id: true, email: true, fullName: true },
          })
        : Promise.resolve([]),
      planNamesFor([...byPlan.map((p) => p.subscriptionPlanId), ...profiles.map((p) => p.subscriptionPlanId)]),
    ]);
    const byUser = new Map(users.map((u) => [u.id, u]));
    res.json({
      brand,
      byStatus: byStatus.map((s) => ({ status: s.subscriptionStatus, count: s._count._all })),
      byPlan: byPlan.map((p) => ({
        planId: p.subscriptionPlanId,
        planName: p.subscriptionPlanId ? (planNames.get(p.subscriptionPlanId) ?? "") : "",
        count: p._count._all,
      })),
      items: profiles.map((p) => ({
        userId: p.userId,
        email: byUser.get(p.userId)?.email ?? "",
        fullName: byUser.get(p.userId)?.fullName ?? "",
        planId: p.subscriptionPlanId,
        planName: p.subscriptionPlanId ? (planNames.get(p.subscriptionPlanId) ?? "") : "",
        status: p.subscriptionStatus,
        trialEndsAt: p.trialEndsAt,
        currentPeriodEnd: p.currentPeriodEnd,
        autoRenew: p.autoRenew,
        minutesAllocated: p.planMinutesAllocated,
        minutesUsed: Math.round(p.planSecondsUsed / 60),
        updatedAt: p.updatedAt,
      })),
    });
  }),
);

const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

/** The brand's customer-support queue, from the brand's database. Read-only:
 *  the platform sees the state of a brand's support, it does not work it. */
router.get(
  "/brands/:id/tickets",
  asyncHandler(async (req, res) => {
    const { brand, db } = await openBrand(req.params.id);
    const wanted = str(req.query.status);
    const status = (TICKET_STATUSES as readonly string[]).includes(wanted) ? (wanted as TicketStatus) : null;
    const [byStatus, tickets] = await Promise.all([
      db.ticket.groupBy({ by: ["status"], where: { lane: "support" }, _count: { _all: true } }),
      db.ticket.findMany({
        where: { lane: "support", ...(status ? { status } : {}) },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
        select: {
          id: true,
          number: true,
          reference: true,
          subject: true,
          status: true,
          priority: true,
          lastMessageAt: true,
          createdAt: true,
          escalationId: true,
          requester: { select: { id: true, email: true, fullName: true } },
          department: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, fullName: true } },
        },
      }),
    ]);
    res.json({
      brand,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      items: tickets,
    });
  }),
);

/** Plan names come from the catalogue in Main — the one join a brand view
 *  makes outside the tenant, and it is by id against a table the platform owns. */
async function planNamesFor(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const plans = await prisma.subscriptionPlan.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } });
  return new Map(plans.map((p) => [p.id, p.displayName]));
}

export default router;
