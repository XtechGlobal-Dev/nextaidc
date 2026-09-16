import { prisma } from "../prisma.js";
import type { Prisma } from "@prisma/client";
import { currentBrandId } from "../lib/brandContext.js";

export interface AuditEvent {
  actorId?: string;
  /** Brand id, or null for platform staff. Defaults to the request's ambient brand, so only pass it when you know better. */
  actorBrandId?: string | null;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  ip?: string;
}

/** Records an admin/ops action. Never throws, so `void audit({...})` is safe without a try/catch. */
export async function audit(e: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: e.actorId ?? null,
        actorBrandId: e.actorBrandId === undefined ? currentBrandId() : e.actorBrandId,
        actorEmail: e.actorEmail ?? "",
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        metadata:
          e.metadata === undefined ? undefined : (e.metadata as Prisma.InputJsonValue),
        ip: e.ip ?? "",
      },
    });
  } catch {
    /* auditing must never break the action it records */
  }
}

export interface ListAuditOpts {
  action?: string;
  /** Set for a brand admin — they must never see another brand's trail. Undefined = platform staff, no restriction. */
  actorBrandId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface ListAuditResult {
  rows: Awaited<ReturnType<typeof prisma.auditLog.findMany>>;
  total: number;
  page: number;
  pageSize: number;
}

function buildAuditWhere(opts: ListAuditOpts): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (opts.actorBrandId) where.actorBrandId = opts.actorBrandId;
  if (opts.action) where.action = opts.action;
  if (opts.search) {
    const q = opts.search;
    where.OR = [
      { actorEmail: { contains: q, mode: "insensitive" } },
      { action: { contains: q, mode: "insensitive" } },
      { targetType: { contains: q, mode: "insensitive" } },
      { targetId: { contains: q, mode: "insensitive" } },
      { ip: { contains: q, mode: "insensitive" } },
    ];
  }
  if (opts.from || opts.to) {
    where.createdAt = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lte: opts.to } : {}),
    };
  }
  return where;
}

export async function listAudit(opts: ListAuditOpts = {}): Promise<ListAuditResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 25), 200);
  const where = buildAuditWhere(opts);

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/** Distinct action names for the filter dropdown, scoped the same way as the rows so a brand admin never sees another brand's actions. */
export async function listAuditActions(actorBrandId?: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    ...(actorBrandId ? { where: { actorBrandId } } : {}),
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}
