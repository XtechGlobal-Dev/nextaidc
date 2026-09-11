import { z } from "zod";
import type { Prisma } from "@prisma/tenant-client";
import { HttpError } from "../lib/http.js";
import type { TicketLane } from "../lib/ticketLanes.js";
import type { TenantClient } from "./tenantDb.js";

/* ------------------------------------------------------------------ *
 *  Ticket departments — the shape and the rules, shared by the two
 *  places that manage them.
 *
 *  WHICH QUEUES EXIST is the platform's call, on both lanes:
 *
 *    brand   lane — the platform's own queues (brandId null), in the
 *                   control plane. The super admin manages them from the
 *                   Brand Requests inbox.
 *    support lane — a BRAND's customer queues, in that brand's own
 *                   database (phase 4). The super admin manages them from
 *                   that brand's page, which opens that database. The
 *                   brand's admin only STAFFS them: who works a queue is
 *                   the brand's business; which queues there are is not.
 *                   A brand starts with the ones the platform gives it
 *                   and asks for more.
 *
 *  Every function takes the lane's database (`laneDb`, services/tenantDb.ts).
 * ------------------------------------------------------------------ */

export const departmentInclude = {
  _count: { select: { tickets: true, roles: true, staff: true } },
  staff: { select: { id: true, fullName: true, email: true }, orderBy: { fullName: "asc" } },
} satisfies Prisma.TicketDepartmentInclude;

export type DepartmentRow = Prisma.TicketDepartmentGetPayload<{ include: typeof departmentInclude }>;

export function serializeDepartment(d: DepartmentRow, mine: boolean) {
  return {
    id: d.id,
    lane: d.lane as TicketLane,
    name: d.name,
    description: d.description,
    requesterVisible: d.requesterVisible,
    enabled: d.enabled,
    order: d.order,
    ticketCount: d._count.tickets,
    roleCount: d._count.roles,
    // Members granted this department PERSONALLY. Role-granted members show up
    // in `roleCount` instead — listing them here would imply an admin can
    // remove them from this screen, and they can't: that lives on the role.
    staffCount: d._count.staff,
    staff: d.staff.map((u) => ({ id: u.id, name: u.fullName || u.email, email: u.email })),
    /** False only under `?scope=all`: a queue the caller can hand off to, not work. */
    mine,
  };
}

/** The fields the platform sets. Membership is separate — see `departmentSchema`. */
export const departmentFieldsSchema = z.object({
  name: z.string().trim().min(2, "Give the department a name").max(60),
  description: z.string().trim().max(200).default(""),
  requesterVisible: z.boolean().default(true),
  enabled: z.boolean().default(true),
  order: z.number().int().min(0).max(999).default(0),
});

export const departmentSchema = departmentFieldsSchema.extend({
  /** Staff granted this queue personally. Omit to leave membership alone. */
  staffIds: z.array(z.string()).max(200).optional(),
});

/** Platform queues carry a NULL brandId, which Postgres treats as distinct, so
 *  the unique index can't catch a duplicate name there. Check by hand. */
export async function assertDepartmentNameFree(
  db: TenantClient,
  lane: TicketLane,
  brandId: string | null,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await db.ticketDepartment.findFirst({
    where: {
      lane,
      brandId,
      name,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, "A department with that name already exists");
}

/** Deleting a queue with tickets in it would orphan the threads (departmentId
 *  → null), which quietly hides them from every staff role. Make the operator
 *  move them first. */
export async function assertDepartmentDeletable(
  db: TenantClient,
  dept: { id: string; name: string },
): Promise<void> {
  const tickets = await db.ticket.count({ where: { departmentId: dept.id } });
  if (tickets > 0) {
    throw new HttpError(
      409,
      `${tickets} ticket${tickets === 1 ? " is" : "s are"} filed under "${dept.name}". Move them to another department first, or turn this one off instead.`,
    );
  }
}
