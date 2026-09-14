import type { Role } from "@prisma/client";
import { isAdminRole, isSuperAdminRole } from "./roles.js";

// Ticket lanes follow the tenancy ladder: `support` = customer → brand, `brand` = brand admin → platform.
// The lane comes from the caller's ROLE, never a request body — that's the whole safety property.

export type TicketLane = "support" | "brand";

export const TICKET_LANES: readonly TicketLane[] = ["support", "brand"];

/** Lane this account raises tickets in; null for STAFF (ask their own admin) and SUPER_ADMIN (nothing above). */
export function requesterLane(role: Role | string | null | undefined): TicketLane | null {
  if (role === "USER" || role === "RESELLER") return "support";
  if (role === "ADMIN") return "brand";
  return null;
}

/** Lane this account handles. ADMIN is in both (asks above, answers below). STAFF answer for whoever
 *  employs them — brand-less staff work the platform inbox, never every tenant's customers (an old bug). */
export function handlerLane(
  role: Role | string | null | undefined,
  brandId: string | null | undefined,
): TicketLane | null {
  if (isSuperAdminRole(role)) return "brand";
  if (role === "ADMIN") return "support";
  if (role === "STAFF") return brandId ? "support" : "brand";
  return null;
}

/** Permission section gating a lane's inbox. Two sections because the inboxes are refused to opposite people. */
export function handlerSection(lane: TicketLane): string {
  return lane === "brand" ? "brand_tickets" : "tickets";
}

/** Tenant that OWNS a lane's departments — whoever answers, not whoever asks. Easy to conflate with the
 *  ticket's own brand: `brand` lane queues belong to the platform (null). */
export function departmentTenant(
  lane: TicketLane,
  brandId: string | null | undefined,
): string | null {
  return lane === "brand" ? null : (brandId ?? null);
}

/** Full admins hold every queue without a grant; STAFF are gated by department grants. */
export function holdsEveryQueue(role: Role | string | null | undefined): boolean {
  return isAdminRole(role);
}

/** Human wording for each lane, so no screen or email invents its own. */
export interface LaneCopy {
  /** What the handler's inbox is called. */
  inbox: string;
  /** What the requester's own page is called. */
  requesterPage: string;
  /** What one thread is called in a sentence ("a support request"). */
  thing: string;
  /** Who answers, from the requester's point of view. */
  handlerName: string;
  /** Single name handler replies are signed with in the requester's view; handlers still see real names. */
  handlerLabel: string;
  /** Who asks, from the handler's point of view. */
  requesterName: string;
}

const COPY: Record<TicketLane, LaneCopy> = {
  support: {
    inbox: "Support Tickets",
    requesterPage: "Support",
    thing: "support request",
    handlerName: "the support team",
    handlerLabel: "Support",
    requesterName: "customer",
  },
  brand: {
    inbox: "Brand Requests",
    requesterPage: "Platform Support",
    thing: "platform request",
    handlerName: "the platform team",
    handlerLabel: "Platform",
    requesterName: "brand",
  },
};

export function laneCopy(lane: TicketLane): LaneCopy {
  return COPY[lane];
}
