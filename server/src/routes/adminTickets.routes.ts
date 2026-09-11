import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { laneDb, type TenantClient } from "../services/tenantDb.js";
import { brandIdsMatching, cachedBrand } from "../services/brands.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../lib/http.js";
import { requireAuth, requireAdminOrStaff } from "../middleware/auth.js";
import { ticketUpload, storeTicketUpload } from "../middleware/ticketUpload.js";
import { audit } from "../services/audit.js";
import { isAdminRole, isSuperAdminRole } from "../lib/roles.js";
import { departmentTenant, handlerLane, laneCopy } from "../lib/ticketLanes.js";
import {
  assertDepartmentDeletable,
  assertDepartmentNameFree,
  departmentInclude,
  departmentSchema,
  serializeDepartment,
} from "../services/ticketDepartments.js";
import {
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_VIDEO_BYTES,
  MESSAGE_TOO_LONG,
} from "../lib/ticketFiles.js";
import {
  ALLOWED_REACTIONS,
  MAX_STARS,
  MIN_STARS,
  POOR_RATING_MAX,
  appendMessage,
  assertCan,
  attachEscalationPairs,
  deleteMessage,
  deleteTicket,
  departmentScope,
  editMessage,
  escalateTicket,
  forgetDepartmentScopes,
  handlerWhere,
  handlersWhere,
  handoffLine,
  isRateable,
  loadTicketForHandler,
  markThreadRead,
  mergeTickets,
  messageInclude,
  messagePreview,
  nextReference,
  notifyRequester,
  notifyTicketHandoff,
  notifyTicketStaff,
  publishThreadChanged,
  publishTyping,
  resolveDepartment,
  scopeFilter,
  serializeMerge,
  serializeMessage,
  serializeTicket,
  shouldEmailForMessage,
  ticketInclude,
  toggleReaction,
  verifyAttachments,
  type MessageActor,
  type TicketActor,
  withRequester,
} from "../services/tickets.js";

/* ------------------------------------------------------------------ *
 *  The handler's inbox.
 *
 *  ONE router, mounted once, serving both lanes — because which inbox
 *  you get is decided by who you are, not by which URL you called:
 *
 *    a brand ADMIN or its STAFF  → `support`: their customers' requests
 *    the SUPER_ADMIN             → `brand`:   their brands' requests
 *
 *  That is what makes the two connections impossible to cross. There is
 *  no query parameter, header or body field that selects a lane, so the
 *  platform owner cannot reach a tenant's customer conversations and a
 *  tenant's admin cannot reach another tenant's queue — the same wall
 *  BRAND_SCOPED_SECTIONS / PLATFORM_ONLY_SECTIONS already put around
 *  the customer list and the audit log.
 *
 *  Within a lane, `scopeFilter` narrows every read to the caller's
 *  tenant, granted departments and the tickets nobody else has taken.
 * ------------------------------------------------------------------ */

const router = express.Router();

router.use(requireAuth, requireAdminOrStaff);

/** Everything below needs to know which side of the ladder the caller is on —
 *  and, with it, which database that side's tickets live in (phase 4): a
 *  brand's inbox in the brand's own, the platform's in the control plane. */
async function withLane(req: Request, _res: Response, next: NextFunction) {
  const lane = handlerLane(req.user!.role, req.user!.brandId ?? null);
  if (!lane) return next(forbidden("Your account doesn't handle support requests."));
  try {
    req.ticketLane = lane;
    req.ticketDb = await laneDb(lane, req.user!.brandId);
    next();
  } catch (err) {
    next(err);
  }
}

router.use(withLane);

/** The lane's database, resolved by withLane above. */
function dbOf(req: Request): TenantClient {
  return req.ticketDb!;
}

/** The control plane's own people carry no brand. The tenant's Role type has
 *  no such column, so the clause is built loose and only ever run there. */
const PLATFORM_ONLY = { brandId: null } as unknown as Prisma.UserWhereInput;

function actorOf(req: Request): TicketActor {
  return {
    id: req.user!.sub,
    role: req.user!.role,
    permissions: req.user!.permissions,
    brandId: req.user!.brandId ?? null,
    lane: req.ticketLane!,
  };
}

/**
 * The tenant a handler's own departments and saved replies belong to.
 *
 * On `brand` that is the platform (null) — the queues brand admins file into
 * are the platform's. On `support` it is the handler's own brand, and null for
 * a platform-level admin, whose customers carry no brand either.
 */
function ownTenant(actor: TicketActor): string | null {
  return departmentTenant(actor.lane, actor.brandId);
}

/** Which queues EXIST is the platform's call on both lanes: the super admin
 *  manages the platform's own from here, and every brand's from that brand's
 *  page (see brands.routes). A brand admin reaches this router's department
 *  routes only to decide who works a queue — see PATCH. */
function assertPlatformOwner(actor: TicketActor): void {
  assertCan(actor, "view");
  if (!isSuperAdminRole(actor.role)) {
    throw forbidden("Departments are set up by the platform — ask them to add or change one.");
  }
}

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(150),
  size: z.number().int().nonnegative(),
  key: z.string().min(1),
  url: z.string().min(1),
  sig: z.string().min(1),
});

/** Which inbox this is, in the words the screen should use. */
router.get("/lane", (req, res) => {
  const lane = req.ticketLane!;
  res.json({ lane, copy: laneCopy(lane) });
});

/* ----------------------------- Departments ------------------------------- */

router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const { scope: which } = z
      .object({ scope: z.enum(["mine", "all"]).default("mine") })
      .parse(req.query);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const mineIds = scope === null ? null : new Set(scope);

    // "all" exists to make reassignment possible, so it widens only for someone
    // who can actually reassign. A view-only member gets their own queues back
    // instead of the names of every queue in the building.
    const widen =
      which === "all" && (isAdminRole(actor.role) || actor.permissions.includes("tickets.edit"));

    const rows = await db.ticketDepartment.findMany({
      where: {
        lane: actor.lane,
        brandId: ownTenant(actor),
        ...(scope === null || widen ? {} : { id: { in: scope } }),
      },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      include: departmentInclude,
    });
    res.json(rows.map((d) => serializeDepartment(d, mineIds === null || mineIds.has(d.id))));
  }),
);

/**
 * Keep only the ids that are real STAFF accounts of the caller's own tenant.
 *
 * Silently dropping a stale id beats 400-ing the whole save: the picker can lag
 * behind a colleague who was deleted a moment ago, and that shouldn't cost the
 * admin the rest of their edit. Full admins are excluded — they already work
 * every queue, so "granting" them one would be a no-op row that then reads as a
 * real membership on screen.
 */
async function validStaffIds(db: TenantClient, ids: string[], actor: TicketActor): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.user.findMany({
    where: {
      id: { in: ids },
      role: "STAFF",
      // A cross-tenant grant would put another brand's staff member on this
      // brand's queue — the one thing department membership must never do. On
      // the support lane the database IS the brand; on the platform's lane the
      // control plane holds every account, so its own people are picked out.
      ...(actor.lane === "brand" ? PLATFORM_ONLY : {}),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

router.post(
  "/departments",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertPlatformOwner(actor);
    const db = dbOf(req);
    const { staffIds, ...data } = departmentSchema.parse(req.body);
    await assertDepartmentNameFree(db, actor.lane, ownTenant(actor), data.name);

    const members = await validStaffIds(db, staffIds ?? [], actor);
    const dept = await db.ticketDepartment.create({
      data: {
        ...data,
        lane: actor.lane,
        brandId: ownTenant(actor),
        staff: { connect: members.map((id) => ({ id })) },
      },
      include: departmentInclude,
    });
    if (members.length > 0) forgetDepartmentScopes();
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.create",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { lane: actor.lane, name: dept.name, staffIds: members },
      ip: req.ip,
    });
    res.status(201).json(serializeDepartment(dept, true));
  }),
);

/** The department, if it is one the caller's lane and tenant own. */
async function loadOwnDepartment(db: TenantClient, id: string, actor: TicketActor) {
  const dept = await db.ticketDepartment.findFirst({
    where: { id, lane: actor.lane, brandId: ownTenant(actor) },
  });
  if (!dept) throw notFound("Department not found");
  return dept;
}

router.patch(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    if (!isAdminRole(actor.role)) throw forbidden("Only an admin can manage departments.");
    const { staffIds, ...data } = departmentSchema.partial().parse(req.body);
    // A brand admin STAFFS their queues; the platform decides what the queues
    // are. Anything but membership from a brand admin is refused rather than
    // ignored, so a stale client can't look like it saved a rename that never
    // happened.
    if (!isSuperAdminRole(actor.role) && Object.keys(data).length > 0) {
      throw forbidden(
        "Departments are set up by the platform — ask them to rename or change one. You can still change who works it.",
      );
    }
    const db = dbOf(req);
    const exists = await loadOwnDepartment(db, req.params.id, actor);
    if (data.name && data.name !== exists.name) {
      await assertDepartmentNameFree(db, actor.lane, ownTenant(actor), data.name, exists.id);
    }

    // `set`, not `connect` — the picker posts the full membership, so someone
    // who was unticked has to actually lose the department.
    const members = staffIds ? await validStaffIds(db, staffIds, actor) : null;
    const dept = await db.ticketDepartment.update({
      where: { id: exists.id },
      data: { ...data, ...(members ? { staff: { set: members.map((id) => ({ id })) } } : {}) },
      include: departmentInclude,
    });
    // Someone may have just gained or lost this queue — their cached grants
    // must not outlive the save.
    if (members) forgetDepartmentScopes();
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.update",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { ...data, ...(members ? { staffIds: members } : {}) },
      ip: req.ip,
    });
    res.json(serializeDepartment(dept, true));
  }),
);

router.delete(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertPlatformOwner(actor);
    const db = dbOf(req);
    const dept = await loadOwnDepartment(db, req.params.id, actor);
    await assertDepartmentDeletable(db, dept);

    await db.ticketDepartment.delete({ where: { id: dept.id } });
    forgetDepartmentScopes();
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.delete",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { lane: actor.lane, name: dept.name },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

/* ------------------------------- Inbox ----------------------------------- */

/**
 * Who can be handed a ticket in the given department — everyone who works that
 * queue, plus the lane's full admins.
 *
 * With no `departmentId` this widens to everyone who works ANY queue the caller
 * can see: the inbox's assignee filter, and the reassign picker while the
 * destination department is still being chosen.
 */
router.get(
  "/agents",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : "";
    const db = dbOf(req);
    const rows = await db.user.findMany({
      where: departmentId
        ? await handlerWhere(db, actor.lane, departmentId, "edit")
        : await handlersWhere(db, actor.lane, await departmentScope(db, actor), "edit"),
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        // Which queues each person works (role grant plus personal grant), so
        // the picker can group them by team and say when assigning to someone
        // also hands the ticket to their department. The role's grants are
        // fetched by id below — a role is a plain id on the account.
        staffRoleId: true,
        ticketDepartments: { select: { id: true, name: true, lane: true } },
      },
      orderBy: { fullName: "asc" },
    });
    const roleIds = [...new Set(rows.map((u) => u.staffRoleId).filter((id): id is string => !!id))];
    const roleGrants = new Map(
      (
        roleIds.length
          ? await db.staffRole.findMany({
              where: { id: { in: roleIds } },
              select: { id: true, ticketDepartments: { select: { id: true, name: true, lane: true } } },
            })
          : []
      ).map((r) => [r.id, r.ticketDepartments]),
    );
    res.json(
      rows.map((u) => {
        const departments = new Map<string, { id: string; name: string }>();
        const viaRole = u.staffRoleId ? (roleGrants.get(u.staffRoleId) ?? []) : [];
        for (const d of [...viaRole, ...u.ticketDepartments]) {
          if (d.lane === actor.lane) departments.set(d.id, { id: d.id, name: d.name });
        }
        return {
          id: u.id,
          name: u.fullName || u.email,
          role: u.role,
          departments: [...departments.values()],
        };
      }),
    );
  }),
);

/**
 * Accounts this handler may raise a request FOR — the picker on the "log a
 * request that came in another way" form.
 *
 * Its own endpoint rather than reusing the customer search, because the two
 * lanes look for different people and one of them can't use that search at all:
 * the super admin is refused the `customers` section by design, so a shared
 * lookup would 403 on exactly the lane that needs it most.
 *
 *   support — the caller's own tenant's customers (and resellers).
 *   brand   — the brand admins, each labelled with the brand they run, which is
 *             the thing the platform owner is actually choosing between.
 */
router.get(
  "/requesters",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "create");
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (actor.lane === "brand") {
      // Brand admins live in their brands' databases; Main's thin directory
      // names each with their brand — which is the thing the platform owner
      // is actually choosing between.
      const rows = await prisma.customerDirectory.findMany({
        where: {
          role: "ADMIN",
          ...(q
            ? {
                OR: [
                  { fullName: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                  { brand: { name: { contains: q, mode: "insensitive" } } },
                ],
              }
            : {}),
        },
        select: { userId: true, fullName: true, email: true, role: true, brand: { select: { id: true, name: true } } },
        orderBy: { fullName: "asc" },
        take: 20,
      });
      res.json(
        rows.map((u) => ({ id: u.userId, name: u.fullName || u.email, email: u.email, role: u.role, brand: u.brand })),
      );
      return;
    }

    // The brand's own customers, from the brand's own database — there is
    // nobody else in it to pick.
    const own = cachedBrand(actor.brandId);
    const rows = await dbOf(req).user.findMany({
      where: {
        role: { in: ["USER", "RESELLER"] },
        ...(q
          ? {
              OR: [
                { fullName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { fullName: "asc" },
      take: 20,
    });

    res.json(
      rows.map((u) => ({
        id: u.id,
        name: u.fullName || u.email,
        email: u.email,
        role: u.role,
        brand: own ? { id: own.id, name: own.name } : null,
      })),
    );
  }),
);

router.get(
  "/upload-policy",
  asyncHandler(async (req, res) => {
    assertCan(actorOf(req), "view");
    res.json({
      maxBytes: MAX_ATTACHMENT_BYTES,
      maxVideoBytes: MAX_VIDEO_BYTES,
      maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
      extensions: ALLOWED_EXTENSIONS,
    });
  }),
);

router.post(
  "/uploads",
  ticketUpload.single("file"),
  asyncHandler(async (req, res) => {
    assertCan(actorOf(req), "view");
    res.status(201).json(await storeTicketUpload(req));
  }),
);

/** First-reply timing: this 30-day window and the one before it, for the trend. */
interface ResponseRow {
  avgSeconds: number | null;
  prevAvgSeconds: number | null;
}

const EMPTY_STATS = {
  open: 0,
  pending: 0,
  resolved: 0,
  closed: 0,
  total: 0,
  unread: 0,
  assignedToMe: 0,
  unassigned: 0,
  csat: { average: null as number | null, count: 0 },
  firstResponse: { avgSeconds: null as number | null, prevAvgSeconds: null as number | null },
};

/**
 * Counts and headline metrics for the inbox tiles — always within the caller's
 * reach, so a staff member's numbers describe the same world their list does.
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    if (scope !== null && scope.length === 0) {
      // A role with no department sees nothing — say so without a query.
      res.json({ ...EMPTY_STATS, departments: 0 });
      return;
    }
    const where = scopeFilter(actor, scope);
    const unresolved: Prisma.EnumTicketStatusFilter = { in: ["open", "pending"] };

    const [byStatus, unread, assignedToMe, unassigned, csat, timing] = await Promise.all([
      db.ticket.groupBy({ by: ["status"], where, _count: { _all: true } }),
      db.ticket.count({ where: { ...where, unreadForStaff: true } }),
      db.ticket.count({ where: { ...where, assignedToId: actor.id, status: unresolved } }),
      db.ticket.count({ where: { ...where, assignedToId: null, status: unresolved } }),
      db.ticket.aggregate({ where, _avg: { rating: true }, _count: { rating: true } }),
      firstResponseTiming(db, actor, scope),
    ]);

    const counts: Record<string, number> = { open: 0, pending: 0, resolved: 0, closed: 0 };
    let total = 0;
    for (const row of byStatus) {
      counts[row.status] = row._count._all;
      total += row._count._all;
    }

    res.json({
      open: counts.open,
      pending: counts.pending,
      resolved: counts.resolved,
      closed: counts.closed,
      total,
      unread,
      assignedToMe,
      unassigned,
      departments: scope === null ? ("all" as const) : scope.length,
      csat: {
        average: csat._avg.rating === null ? null : Number(csat._avg.rating.toFixed(2)),
        count: csat._count.rating,
      },
      firstResponse: timing,
    });
  }),
);

/**
 * How long a requester waited for the first reply, averaged over the last 30
 * days and the 30 before that.
 *
 * Raw SQL because this is a per-ticket MIN over a join, which Prisma's groupBy
 * can't express. The lane goes in as a CAST rather than a bare parameter:
 * Postgres will not implicitly compare an enum column to text.
 */
async function firstResponseTiming(
  db: TenantClient,
  actor: TicketActor,
  scope: string[] | null,
): Promise<ResponseRow> {
  const filters: Prisma.Sql[] = [
    Prisma.sql`t."lane" = CAST(${actor.lane} AS "TicketLane")`,
    Prisma.sql`t."createdAt" >= NOW() - INTERVAL '60 days'`,
  ];
  if (actor.brandId) filters.push(Prisma.sql`t."brandId" = ${actor.brandId}`);
  if (scope !== null) {
    filters.push(Prisma.sql`t."departmentId" IN (${Prisma.join(scope)})`);
    filters.push(Prisma.sql`(t."assignedToId" IS NULL OR t."assignedToId" = ${actor.id})`);
  }
  try {
    const [row] = await db.$queryRaw<ResponseRow[]>`
      WITH firsts AS (
        SELECT t."createdAt" AS opened, MIN(m."createdAt") AS replied
        FROM "tickets" t
        JOIN "ticket_messages" m
          ON m."ticketId" = t.id AND m."authorType" = 'staff' AND m."internal" = false
        WHERE ${Prisma.join(filters, " AND ")}
        GROUP BY t.id, t."createdAt"
      )
      SELECT
        AVG(EXTRACT(EPOCH FROM (replied - opened)))
          FILTER (WHERE opened >= NOW() - INTERVAL '30 days')::float8 AS "avgSeconds",
        AVG(EXTRACT(EPOCH FROM (replied - opened)))
          FILTER (WHERE opened <  NOW() - INTERVAL '30 days')::float8 AS "prevAvgSeconds"
      FROM firsts
    `;
    return { avgSeconds: row?.avgSeconds ?? null, prevAvgSeconds: row?.prevAvgSeconds ?? null };
  } catch (err) {
    // A metric is not worth failing the whole inbox for.
    console.error("[tickets] first-response timing failed:", err);
    return { avgSeconds: null, prevAvgSeconds: null };
  }
}

/* -------------------------------- Ratings --------------------------------- */

const ratingsQuery = z.object({
  departmentId: z.string().optional(),
  stars: z.coerce.number().int().min(MIN_STARS).max(MAX_STARS).optional(),
  poorOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  "/ratings",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const query = ratingsQuery.parse(req.query);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);

    // Only rated tickets count — an unrated one is not a 0, it's a no-answer,
    // and folding those in would drag every average toward a number nobody gave.
    const base: Prisma.TicketWhereInput = { ...scopeFilter(actor, scope), NOT: { rating: null } };
    if (query.departmentId) {
      if (scope !== null && !scope.includes(query.departmentId)) {
        res.json({ ratings: [], total: 0, page: 1, pageSize: query.pageSize, summary: null });
        return;
      }
      base.departmentId = query.departmentId;
    }
    const where: Prisma.TicketWhereInput = { ...base };
    if (query.stars) where.rating = query.stars;
    else if (query.poorOnly) where.rating = { lte: POOR_RATING_MAX };

    const [total, rows, distribution, byDepartment] = await Promise.all([
      db.ticket.count({ where }),
      db.ticket.findMany({
        where,
        orderBy: { ratedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: ticketInclude,
      }),
      // The summary describes the caller's whole scope, not the star filter —
      // otherwise "1 star" would report an average of 1.
      db.ticket.groupBy({ by: ["rating"], where: base, _count: { _all: true } }),
      db.ticket.groupBy({
        by: ["departmentId"],
        where: base,
        _count: { _all: true },
        _avg: { rating: true },
      }),
    ]);

    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let rated = 0;
    for (const row of distribution) {
      if (row.rating === null) continue;
      counts[row.rating] = row._count._all;
      sum += row.rating * row._count._all;
      rated += row._count._all;
    }

    const deptIds = byDepartment.map((d) => d.departmentId).filter((id): id is string => !!id);
    const deptNames = new Map(
      (
        await db.ticketDepartment.findMany({
          where: { id: { in: deptIds } },
          select: { id: true, name: true },
        })
      ).map((d) => [d.id, d.name]),
    );

    res.json({
      ratings: rows.map((t) => serializeTicket(withRequester(t))),
      total,
      page: query.page,
      pageSize: query.pageSize,
      summary: {
        rated,
        average: rated ? Number((sum / rated).toFixed(2)) : null,
        poor: counts[1] + counts[2],
        distribution: counts,
        byDepartment: byDepartment
          .map((d) => ({
            id: d.departmentId,
            name: d.departmentId ? (deptNames.get(d.departmentId) ?? "Unknown") : "No department",
            rated: d._count._all,
            average: d._avg.rating === null ? null : Number(d._avg.rating.toFixed(2)),
          }))
          .sort((a, b) => b.rated - a.rated),
      },
    });
  }),
);

/* --------------------------------- List ---------------------------------- */

const listQuery = z.object({
  status: z.enum(["all", "unresolved", "open", "pending", "resolved", "closed"]).default("all"),
  departmentId: z.string().optional(),
  assigned: z.enum(["any", "me", "unassigned"]).default("any"),
  assignedToId: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  unread: z.enum(["true", "false"]).optional(),
  /** On lane `brand`, narrowing to one tenant is the first thing the platform
   *  owner wants — "what is Acme asking?" rather than one long mixed list. */
  brandId: z.string().optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * The inbox filters as a Prisma `where` — shared by the table and the CSV
 * export, so the file always holds exactly what the screen showed. Null when a
 * filter points outside the caller's reach: that must read as "nothing", never
 * widen to "everything".
 */
function listWhere(
  query: z.infer<typeof listQuery>,
  actor: TicketActor,
  scope: string[] | null,
): Prisma.TicketWhereInput | null {
  const where: Prisma.TicketWhereInput = { ...scopeFilter(actor, scope) };
  if (query.status === "unresolved") where.status = { in: ["open", "pending"] };
  else if (query.status !== "all") where.status = query.status;

  if (query.departmentId) {
    // Never widen: an explicit filter can only narrow what the caller holds.
    if (scope !== null && !scope.includes(query.departmentId)) return null;
    where.departmentId = query.departmentId;
  }
  if (query.brandId) {
    // Same rule one level up: a handler tied to a tenant can only ever filter
    // to that tenant, so the parameter is a narrowing tool, not a way across.
    if (actor.brandId && actor.brandId !== query.brandId) return null;
    where.brandId = query.brandId;
  }
  if (query.assigned === "me") where.assignedToId = actor.id;
  else if (query.assigned === "unassigned") where.assignedToId = null;
  else if (query.assignedToId) where.assignedToId = query.assignedToId;
  if (query.priority) where.priority = query.priority;
  if (query.unread === "true") where.unreadForStaff = true;

  if (query.q) {
    // "#42" (or just "42") is how a team refers to a ticket — match the number
    // as well as the text fields. A brand's name is matched through the brands
    // cache: the ticket names its brand by id, and the brand table is the
    // platform's, not something this database can join.
    const asNumber = /^#?\d{1,9}$/.test(query.q) ? Number(query.q.replace("#", "")) : null;
    const brandIds = actor.lane === "brand" ? brandIdsMatching(query.q) : [];
    where.OR = [
      ...(asNumber !== null ? [{ number: asNumber }] : []),
      { reference: { contains: query.q, mode: "insensitive" as const } },
      { subject: { contains: query.q, mode: "insensitive" as const } },
      { requesterName: { contains: query.q, mode: "insensitive" as const } },
      { requesterEmail: { contains: query.q, mode: "insensitive" as const } },
      ...(brandIds.length ? [{ brandId: { in: brandIds } }] : []),
    ];
  }
  return where;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const query = listQuery.parse(req.query);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const where = listWhere(query, actor, scope);
    if (!where) {
      res.json({ tickets: [], total: 0, page: 1, pageSize: query.pageSize });
      return;
    }

    const [total, rows] = await Promise.all([
      db.ticket.count({ where }),
      db.ticket.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          ...ticketInclude,
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              body: true,
              authorType: true,
              deletedAt: true,
              attachments: { select: { mime: true }, take: 1 },
            },
          },
          _count: { select: { messages: true } },
        },
      }),
    ]);

    res.json({
      tickets: (await attachEscalationPairs(rows)).map((t) =>
        serializeTicket(t, {
          lastMessage: messagePreview(t.messages[0]),
          messageCount: t._count.messages,
        }),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  }),
);

/** A spreadsheet-safe cell: quoted, quotes doubled, and a leading formula
 *  character neutralised so a subject like "=1+1" can't run when opened. */
function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** How many rows one click can pull out of the database. */
const EXPORT_LIMIT = 5000;

router.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const query = listQuery.parse(req.query);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const where = listWhere(query, actor, scope);
    const rows = where
      ? await db.ticket.findMany({
          where,
          orderBy: { lastMessageAt: "desc" },
          take: EXPORT_LIMIT,
          include: { ...ticketInclude, _count: { select: { messages: true } } },
        })
      : [];

    const header = [
      "Number",
      "Reference",
      "Subject",
      "Status",
      "Priority",
      "Department",
      "Requester",
      "Requester email",
      "Brand",
      "Assigned to",
      "Messages",
      "Rating",
      "Opened",
      "Last activity",
      "Closed",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
      const t = serializeTicket(withRequester(row), { messageCount: row._count.messages });
      lines.push(
        [
          t.number,
          t.reference,
          t.subject,
          t.status,
          t.priority,
          t.department?.name ?? "",
          t.requester.name,
          t.requester.email,
          t.brand?.name ?? "",
          t.assignedTo?.name ?? "",
          t.messageCount ?? 0,
          t.rating ?? "",
          t.createdAt.toISOString(),
          t.lastMessageAt.toISOString(),
          t.closedAt?.toISOString() ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tickets-${stamp}.csv"`);
    // A byte-order mark, so Excel reads accented names as UTF-8 rather than guessing.
    res.send("﻿" + lines.join("\r\n"));
  }),
);

/* ----------------------------- Saved replies ------------------------------ */

const savedReplyInclude = {
  department: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.TicketSavedReplyInclude;

type SavedReplyRow = Prisma.TicketSavedReplyGetPayload<{ include: typeof savedReplyInclude }>;

/** Whether this actor may change or remove a reply filed under `departmentId`. */
function canManageSavedReply(
  actor: TicketActor,
  scope: string[] | null,
  reply: { departmentId: string | null },
): boolean {
  if (isAdminRole(actor.role)) return true;
  if (!actor.permissions.includes("tickets.edit")) return false;
  // A global reply is shared by every queue in the lane — only an admin edits it.
  if (reply.departmentId === null) return false;
  return scope === null || scope.includes(reply.departmentId);
}

function serializeSavedReply(r: SavedReplyRow, canEdit: boolean) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    department: r.department,
    createdBy: r.createdBy
      ? { id: r.createdBy.id, name: r.createdBy.fullName || r.createdBy.email }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    canEdit,
  };
}

const savedReplySchema = z.object({
  title: z.string().trim().min(2, "Give the reply a name").max(80),
  body: z.string().trim().min(1, "Write the reply").max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG),
  /** Null = every department in this lane. */
  departmentId: z.string().min(1).nullable(),
});

router.get(
  "/saved-replies",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const rows = await db.ticketSavedReply.findMany({
      where: {
        lane: actor.lane,
        brandId: ownTenant(actor),
        ...(scope === null
          ? {}
          : { OR: [{ departmentId: null }, { departmentId: { in: scope } }] }),
      },
      orderBy: { title: "asc" },
      include: savedReplyInclude,
    });
    res.json(rows.map((r) => serializeSavedReply(r, canManageSavedReply(actor, scope, r))));
  }),
);

router.post(
  "/saved-replies",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const data = savedReplySchema.parse(req.body);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    if (!canManageSavedReply(actor, scope, data)) {
      throw forbidden(
        data.departmentId === null
          ? "Only an admin can add a reply for every department."
          : "You can only add replies for departments you work.",
      );
    }
    if (data.departmentId) await loadOwnDepartment(db, data.departmentId, actor);

    const created = await db.ticketSavedReply.create({
      data: { ...data, lane: actor.lane, brandId: ownTenant(actor), createdById: actor.id },
      include: savedReplyInclude,
    });
    res.status(201).json(serializeSavedReply(created, true));
  }),
);

/** The reply, if the caller can see it — 404 otherwise, so another lane's or
 *  another queue's replies read as absent rather than forbidden. */
async function loadSavedReply(db: TenantClient, id: string, actor: TicketActor, scope: string[] | null) {
  const reply = await db.ticketSavedReply.findFirst({
    where: { id, lane: actor.lane, brandId: ownTenant(actor) },
  });
  if (!reply) throw notFound("Saved reply not found");
  if (scope !== null && reply.departmentId !== null && !scope.includes(reply.departmentId)) {
    throw notFound("Saved reply not found");
  }
  return reply;
}

router.patch(
  "/saved-replies/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const data = savedReplySchema.partial().parse(req.body);
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const existing = await loadSavedReply(db, req.params.id, actor, scope);
    if (!canManageSavedReply(actor, scope, existing)) {
      throw forbidden("You can't change this reply.");
    }
    if (
      data.departmentId !== undefined &&
      !canManageSavedReply(actor, scope, { departmentId: data.departmentId })
    ) {
      throw forbidden(
        data.departmentId === null
          ? "Only an admin can offer a reply to every department."
          : "You can only file replies under departments you work.",
      );
    }
    if (data.departmentId) await loadOwnDepartment(db, data.departmentId, actor);

    const updated = await db.ticketSavedReply.update({
      where: { id: existing.id },
      data,
      include: savedReplyInclude,
    });
    res.json(serializeSavedReply(updated, true));
  }),
);

router.delete(
  "/saved-replies/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const db = dbOf(req);
    const scope = await departmentScope(db, actor);
    const existing = await loadSavedReply(db, req.params.id, actor, scope);
    if (!canManageSavedReply(actor, scope, existing)) {
      throw forbidden("You can't remove this reply.");
    }
    await db.ticketSavedReply.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

/* -------------------------------- Tickets --------------------------------- */

const createSchema = z.object({
  subject: z.string().trim().min(3).max(140),
  departmentId: z.string().min(1, "Choose a department"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  message: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG).default(""),
  /** The account the request is FOR. Validated against the lane below. */
  requesterId: z.string().min(1, "Pick who this is for"),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});

/**
 * Raise a ticket on someone's behalf — a request that came in by phone, or a
 * conversation that started somewhere else and needs a thread to live in.
 *
 * The requester must be an account that actually raises tickets in this lane
 * (see requesterLane) AND one the caller can already reach. Without both
 * checks this route would be a way to mint a thread in another tenant, or to
 * put words in an account's mouth that it never said.
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "create");
    const data = createSchema.parse(req.body);
    const db = dbOf(req);

    // Who the request is FOR. On the support lane that is one of the brand's
    // own customers, in the brand's database — there is nobody else in it, so
    // the tenant wall is the database itself. On the platform's lane it is a
    // brand admin, found in Main's thin directory with their brand.
    const requester =
      actor.lane === "brand"
        ? await prisma.customerDirectory
            .findFirst({
              where: { userId: data.requesterId },
              select: { userId: true, fullName: true, email: true, role: true, brandId: true },
            })
            .then((d) => (d ? { id: d.userId, fullName: d.fullName, email: d.email, role: d.role, brandId: d.brandId } : null))
        : await db.user
            .findUnique({
              where: { id: data.requesterId },
              select: { id: true, fullName: true, email: true, role: true },
            })
            .then((u) => (u ? { ...u, brandId: actor.brandId } : null));
    const expectedRole =
      actor.lane === "brand" ? ["ADMIN"] : ["USER", "RESELLER"];
    if (!requester || !expectedRole.includes(requester.role)) {
      throw badRequest(
        actor.lane === "brand"
          ? "Pick the brand admin this request is for."
          : "Pick the customer this request is for.",
      );
    }

    const brandId = requester.brandId ?? null;
    const departmentId = await resolveDepartment(db, data.departmentId, {
      lane: actor.lane,
      brandId: departmentTenant(actor.lane, brandId),
      requireSelectable: true,
    });

    const created = await db.ticket.create({
      data: {
        reference: await nextReference(db),
        subject: data.subject,
        lane: actor.lane,
        priority: data.priority,
        brandId,
        departmentId,
        requesterId: requester.id,
        requesterBrandId: brandId,
        requesterName: requester.fullName || requester.email,
        requesterEmail: requester.email,
        source: "admin",
        // Raised by a handler, so there is nothing new for handlers to read.
        unreadForStaff: false,
      },
    });

    if (data.message.trim() || data.attachments.length) {
      await appendMessage(db, {
        ticketId: created.id,
        authorType: "staff",
        authorId: actor.id,
        authorName: await myName(db, actor, laneCopy(actor.lane).handlerLabel),
        body: data.message,
        attachments: verifyAttachments(data.attachments),
      });
    }

    const ticket = withRequester(
      await db.ticket.findUniqueOrThrow({
        where: { id: created.id },
        include: ticketInclude,
      }),
    );
    void notifyRequester(ticket, {
      title: `Request ${ticket.reference} opened`,
      message: ticket.subject,
      templateKey: "ticket_created",
    });

    res.status(201).json(serializeTicket(ticket));
  }),
);

const escalateSchema = z.object({
  /** One of the PLATFORM's queues — the brand admin picks it the way they
   *  would when raising any platform request. */
  departmentId: z.string().min(1, "Choose a platform department"),
  note: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG).default(""),
});

/**
 * Hand a customer's ticket up to the platform.
 *
 * Brand admins only: the ticket that goes up is raised in THEIR name on the
 * `brand` lane, and a brand's staff have no standing to ask the platform
 * anything. The customer's thread stays here, in this inbox; what the
 * platform gets is the admin's account of it, linked both ways.
 */
router.post(
  "/:id/escalate",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    if (actor.lane !== "support" || actor.role !== "ADMIN" || !actor.brandId) {
      throw forbidden("Only a brand admin can escalate a customer's request to the platform.");
    }
    const data = escalateSchema.parse(req.body);
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    const escalation = await escalateTicket(
      db,
      ticket,
      { id: actor.id, name: await myName(db, actor, laneCopy(actor.lane).handlerLabel), brandId: actor.brandId },
      data,
    );
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket.escalate",
      targetType: "ticket",
      targetId: ticket.id,
      metadata: { escalationId: escalation.id, departmentId: data.departmentId },
      ip: req.ip,
    });
    const updated = await loadTicketForHandler(db, ticket.id, actor);
    res.status(201).json({ ticket: serializeTicket(updated), escalation: serializeTicket(escalation) });
  }),
);

/** One thread — internal notes included, since this is the handler's view. */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "view");
    // The messages are keyed by the same id, so they are fetched alongside the
    // ticket rather than after it. If the ticket turns out to be outside the
    // caller's reach, the 404 from the first read discards them unseen.
    const db = dbOf(req);
    const [ticket, messages, merges] = await Promise.all([
      loadTicketForHandler(db, req.params.id, actor),
      db.ticketMessage.findMany({
        where: { ticketId: req.params.id },
        orderBy: { createdAt: "asc" },
        include: messageInclude,
      }),
      db.ticketMerge.findMany({
        where: { ticketId: req.params.id },
        orderBy: { mergedAt: "desc" },
      }),
    ]);

    // Stamps `staffReadAt` and nudges the requester's tab, so the "Seen" tick
    // under their last message appears without them reloading. Not awaited: the
    // response already reports the thread as read, and the write is one more
    // round trip nobody should have to wait on.
    void markThreadRead(db, ticket, "staff").catch(() => {});

    res.json({
      ticket: serializeTicket({ ...ticket, unreadForStaff: false }),
      messages: messages.map((m) => serializeMessage(m, actor.id)),
      merges: merges.map(serializeMerge),
    });
  }),
);

router.post(
  "/:id/merge",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const { sourceId } = z.object({ sourceId: z.string().min(1) }).parse(req.body);
    const merged = await mergeTickets(dbOf(req), req.params.id, sourceId, actor);
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket.merge",
      targetType: "ticket",
      targetId: merged.id,
      metadata: { sourceId, number: merged.number },
      ip: req.ip,
    });
    res.json(serializeTicket(merged));
  }),
);

const replySchema = z.object({
  body: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG).default(""),
  /** Staff-only note — the requester never sees it, and it doesn't notify them. */
  internal: z.boolean().default(false),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  replyToId: z.string().nullable().optional(),
});

/** The display name a reply is stored under, for the handler-side view. The
 *  handler is in the lane's own database: a brand's team in the brand's, the
 *  platform's people in the control plane. */
async function myName(db: TenantClient, actor: TicketActor, fallback: string): Promise<string> {
  const me = await db.user.findUnique({
    where: { id: actor.id },
    select: { fullName: true, email: true },
  });
  return me?.fullName || me?.email || fallback;
}

router.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const data = replySchema.parse(req.body);
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);

    const message = await appendMessage(db, {
      ticketId: ticket.id,
      authorType: "staff",
      authorId: actor.id,
      authorName: await myName(db, actor, laneCopy(actor.lane).handlerLabel),
      body: data.body,
      internal: data.internal,
      attachments: verifyAttachments(data.attachments),
      replyToId: data.replyToId,
      // Handlers read internal notes, so quoting one back is legitimate here.
      canQuoteInternal: true,
    });

    if (!data.internal) {
      const updated = await db.ticket.update({
        where: { id: ticket.id },
        data: {
          // A reply puts the ball back in the requester's court.
          status: ticket.status === "open" ? "pending" : ticket.status,
          // Whoever answers owns it — not just the first responder. The ticket
          // sits under the name the requester last heard from, so a colleague
          // who steps in takes it over from the previous assignee.
          assignedToId: actor.id,
        },
        include: ticketInclude,
      });
      void notifyRequester(withRequester(updated), {
        title: `${laneCopy(actor.lane).handlerLabel} replied · ${updated.reference}`,
        message: data.body.slice(0, 140) || "Sent you an attachment",
        // The bell always rings; mail only once the conversation has been quiet
        // for an hour. `ticket` is the row from before this reply, so its
        // lastMessageAt says when the thread last spoke.
        ...(shouldEmailForMessage(ticket)
          ? { templateKey: "ticket_reply", templateVars: { reply_preview: data.body.slice(0, 400) } }
          : {}),
      });
    }

    res.status(201).json(serializeMessage(message, actor.id));
  }),
);

function handlerActor(req: Request, name: string): MessageActor {
  const actor = actorOf(req);
  return {
    key: actor.id,
    type: "staff",
    name,
    userId: actor.id,
    // Removing a REQUESTER's message (a mistyped card number, a screenshot they
    // regret) is a moderation act, so it rides on `*.delete` rather than on
    // ordinary reply rights. Your own message is always yours to take back.
    canModerate: isAdminRole(actor.role) || actor.permissions.includes("tickets.delete"),
  };
}

router.patch(
  "/:id/messages/:messageId",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const { body } = z
      .object({ body: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG) })
      .parse(req.body);
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    const message = await editMessage(
      db,
      ticket.id,
      req.params.messageId,
      handlerActor(req, await myName(db, actor, laneCopy(actor.lane).handlerLabel)),
      body,
    );
    publishThreadChanged(ticket, "staff");
    res.json(serializeMessage(message, actor.id));
  }),
);

router.delete(
  "/:id/messages/:messageId",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    const message = await deleteMessage(
      db,
      ticket.id,
      req.params.messageId,
      handlerActor(req, await myName(db, actor, laneCopy(actor.lane).handlerLabel)),
    );
    publishThreadChanged(ticket, "staff");
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket.message.delete",
      targetType: "ticket",
      targetId: ticket.id,
      metadata: { reference: ticket.reference, messageId: message.id },
      ip: req.ip,
    });
    res.json(serializeMessage(message, actor.id));
  }),
);

router.post(
  "/:id/messages/:messageId/reactions",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const { emoji } = z.object({ emoji: z.enum(ALLOWED_REACTIONS) }).parse(req.body);
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    const message = await toggleReaction(
      db,
      ticket.id,
      req.params.messageId,
      handlerActor(req, await myName(db, actor, laneCopy(actor.lane).handlerLabel)),
      emoji,
    );
    publishThreadChanged(ticket, "staff");
    res.json(serializeMessage(message, actor.id));
  }),
);

/** "…is typing" for the requester's panel. Writes nothing. */
router.post(
  "/:id/typing",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const ticket = await loadTicketForHandler(dbOf(req), req.params.id, actor);
    publishTyping(ticket, "staff", laneCopy(actor.lane).handlerLabel);
    res.status(204).end();
  }),
);

const patchSchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedToId: z.string().nullable().optional(),
  departmentId: z.string().optional(),
  subject: z.string().trim().min(3).max(140).optional(),
  /** Why it is being handed over — travels with the mail and the notification,
   *  and stays on the ticket as a line only handlers can see. */
  note: z.string().trim().max(2000).optional(),
});

/** Status, priority, subject — and the hand-over algorithm. */
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "edit");
    const data = patchSchema.parse(req.body);
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    // Departments belong to a tenant, and a ticket never changes tenant — so
    // the queue it can move to is decided by the TICKET's brand, not the
    // handler's. That matters for a platform-level admin working across brands.
    const deptTenant = departmentTenant(actor.lane, ticket.brandId);

    const update: Prisma.TicketUpdateInput = {};
    if (data.subject) update.subject = data.subject;
    if (data.priority) update.priority = data.priority;
    if (data.status) {
      update.status = data.status;
      update.closedAt = data.status === "closed" ? new Date() : null;
    }
    if (data.departmentId) {
      // A ticket filed to the wrong queue is the normal case, not the exception,
      // so any handler may route it onward — including to a department they
      // don't work themselves. That hands access away rather than taking any.
      const departmentId = await resolveDepartment(db, data.departmentId, {
        lane: actor.lane,
        brandId: deptTenant,
        requireSelectable: true,
      });
      update.department = departmentId
        ? { connect: { id: departmentId } }
        : { disconnect: true };
    }
    const movingDepartment = !!data.departmentId && data.departmentId !== ticket.departmentId;
    if (movingDepartment && data.assignedToId === undefined && ticket.assignedToId) {
      // Handing the ticket to another team also hands over ownership. Leaving
      // the old department's agent as assignee would park it with someone who
      // can no longer see it — and because mail goes to the assignee, the team
      // that just received it would never be told.
      update.assignedTo = { disconnect: true };
    }
    if (data.assignedToId !== undefined) {
      if (data.assignedToId) {
        // The DESTINATION department decides who is eligible, so validate
        // against the department the ticket is about to be in — otherwise
        // "move to Billing and give it to Sam" fails on a single request.
        const targetDepartment = data.departmentId ?? ticket.departmentId;
        const eligible = await db.user.findFirst({
          where: {
            id: data.assignedToId,
            ...(await handlerWhere(db, actor.lane, targetDepartment, "edit")),
          },
          select: { id: true },
        });
        if (!eligible) throw badRequest("That person can't be assigned tickets in this department.");
      }
      update.assignedTo = data.assignedToId
        ? { connect: { id: data.assignedToId } }
        : { disconnect: true };
    }

    const updated = (
      await attachEscalationPairs([
        await db.ticket.update({
          where: { id: ticket.id },
          data: update,
          include: ticketInclude,
        }),
      ])
    )[0];

    // Did the handler just route it out of their own reach? The client needs to
    // know: the thread it is showing is one it can no longer re-fetch, so it has
    // to close the pane rather than sit on a ticket that 404s on refresh.
    const scope = await departmentScope(db, actor);
    const handedOff =
      scope !== null &&
      ((movingDepartment && !scope.includes(data.departmentId!)) ||
        (updated.assignedToId !== null && updated.assignedToId !== actor.id));

    const assigneeChanged = updated.assignedToId !== ticket.assignedToId;
    const handoffNote = data.note?.trim() ?? "";
    const actorName =
      assigneeChanged || movingDepartment
        ? await myName(db, actor, laneCopy(actor.lane).handlerLabel)
        : "";
    if (assigneeChanged || movingDepartment) {
      await appendMessage(db, {
        ticketId: updated.id,
        authorType: "system",
        authorName: "System",
        internal: true,
        body: handoffLine(
          actorName,
          {
            movedTo: movingDepartment ? (updated.department?.name ?? null) : undefined,
            assignee: assigneeChanged ? (updated.assignedTo?.fullName ?? null) : undefined,
            self: assigneeChanged && updated.assignedToId === actor.id,
          },
          handoffNote,
        ),
      });
    }

    // Tell the requester only about the things they would want to know.
    if (
      data.status &&
      data.status !== ticket.status &&
      (data.status === "resolved" || data.status === "closed")
    ) {
      // The moment work finishes is the moment to ask how it went — so the
      // notification that says "resolved" IS the prompt to rate, and its link
      // opens the star card rather than just the thread.
      const askForRating = !updated.rating && isRateable(data.status);
      void notifyRequester(withRequester(updated), {
        title: `Request ${updated.reference} ${data.status}`,
        message: askForRating
          ? `${updated.subject} — how did we do? Tap to rate.`
          : updated.subject,
        link: askForRating ? `/dashboard/support?ticket=${updated.id}&rate=1` : undefined,
        templateKey: "ticket_status_changed",
        templateVars: { status: data.status },
      });
    }
    if (movingDepartment) {
      void notifyTicketStaff(db, updated, {
        title: `Request ${updated.reference} moved here`,
        message: handoffNote ? `${actorName}: ${handoffNote}` : updated.subject,
        // Mail goes out only when nobody was handed it in the same breath —
        // otherwise the new holder gets the hand-over mail below instead.
        ...(updated.assignedToId
          ? {}
          : {
              templateKey: "ticket_staff_new",
              templateVars: {
                message_preview: handoffNote
                  ? `${actorName} moved this request into your department.\n\nNote from ${actorName}: “${handoffNote}”`
                  : `${actorName} moved this request into your department.`,
              },
            }),
        excludeUserId: actor.id,
      });
    }
    // The new holder is told directly. When a move leaves nobody holding it, the
    // "moved here" mail above already reached the receiving team, so only a
    // plain unassign needs telling here.
    if (assigneeChanged && (updated.assignedToId || !movingDepartment)) {
      void notifyTicketHandoff(db, updated, {
        actorId: actor.id,
        actorName,
        note: handoffNote,
        movedTo: movingDepartment ? (updated.department?.name ?? null) : null,
      });
    }

    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket.update",
      targetType: "ticket",
      targetId: updated.id,
      metadata: { ...data, handedOff },
      ip: req.ip,
    });

    res.json({ ...serializeTicket(updated), handedOff });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, "delete");
    const db = dbOf(req);
    const ticket = await loadTicketForHandler(db, req.params.id, actor);
    await deleteTicket(db, ticket.id);
    void audit({
      actorId: actor.id,
      actorBrandId: actor.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket.delete",
      targetType: "ticket",
      targetId: ticket.id,
      metadata: { reference: ticket.reference, subject: ticket.subject },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

export default router;
