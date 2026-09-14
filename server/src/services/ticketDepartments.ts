import { z } from "zod";
import type { Prisma } from "@prisma/tenant-client";
import { HttpError } from "../lib/http.js";
import type { TicketLane } from "../lib/ticketLanes.js";
import type { TenantClient } from "./tenantDb.js";

// Ticket department shape and rules. Which queues exist is the platform's call on both lanes;
// a brand admin only staffs them. Every function takes the lane's DB (`laneDb`).

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
    // Personal grants only. Role-granted members live in `roleCount` — listing
    // them here would imply they can be removed from this screen (they can't).
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

/** Deleting a queue with tickets would null their departmentId and hide them from every staff role — make the operator move them first. */
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
