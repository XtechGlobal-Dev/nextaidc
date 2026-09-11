import type { Role } from "@prisma/client";
import { isAdminRole, isSuperAdminRole } from "./roles.js";

/* ------------------------------------------------------------------ *
 *  Which support conversation an account belongs to, and on which side
 *  of it.
 *
 *  Support here follows the tenancy ladder the platform already has —
 *  customer → brand → platform — so a ticket is always a conversation
 *  with the tier directly above:
 *
 *    support — a brand's CUSTOMER asks that brand's admin team.
 *    brand   — a BRAND ADMIN asks the platform (the super admin).
 *
 *  The lane is derived from the caller's ROLE and is never accepted from
 *  a request body. That is the whole safety property: there is no shape
 *  of request in which a customer can address the platform, or a brand
 *  admin its own customers. Everything else — scoping, fan-out, the
 *  wording on screen — hangs off these four functions.
 * ------------------------------------------------------------------ */

export type TicketLane = "support" | "brand";

export const TICKET_LANES: readonly TicketLane[] = ["support", "brand"];

/**
 * The lane this account RAISES tickets in, or null when it raises none.
 *
 * A customer (or a reseller, who is also a brand's account holder) asks their
 * brand. A brand ADMIN asks the platform. Nobody else has anywhere to ask:
 * STAFF work inside a brand's team and take it up with their own admin, and the
 * SUPER_ADMIN sits at the top of the ladder with no tier above them.
 */
export function requesterLane(role: Role | string | null | undefined): TicketLane | null {
  if (role === "USER" || role === "RESELLER") return "support";
  if (role === "ADMIN") return "brand";
  return null;
}

/**
 * The lane this account HANDLES, or null when it handles none.
 *
 * The mirror image of the above: a brand's admin team answers its customers,
 * and the platform answers the brands. Note ADMIN appears in BOTH — a brand
 * admin answers below and asks above, which is exactly what being the middle
 * rung of a three-tier hierarchy means.
 *
 * STAFF answer for whoever employs them, which is why the tenant is needed
 * here and nowhere else: a brand's staff work that brand's customer queue, and
 * the platform's own staff — no brand; the super admin's support team — work
 * the platform's inbox beside the super admin. A brand-less staff member is
 * never dropped into customer conversations across every tenant, which is
 * what "no brand" used to fall through to.
 */
export function handlerLane(
  role: Role | string | null | undefined,
  brandId: string | null | undefined,
): TicketLane | null {
  if (isSuperAdminRole(role)) return "brand";
  if (role === "ADMIN") return "support";
  if (role === "STAFF") return brandId ? "support" : "brand";
  return null;
}

/**
 * The permission section that gates a lane's handler inbox.
 *
 * Two sections rather than one, because the two inboxes are refused to opposite
 * people and the existing matrix already knows how to express that:
 *   `tickets`       is in BRAND_SCOPED_SECTIONS — a tenant's customer
 *                   conversations are the tenant's business, so the platform
 *                   owner is refused them, like the customer list itself.
 *   `brand_tickets` is in PLATFORM_ONLY_SECTIONS — brand queries are the
 *                   platform's, so no brand admin or staff member can be
 *                   granted them.
 */
export function handlerSection(lane: TicketLane): string {
  return lane === "brand" ? "brand_tickets" : "tickets";
}

/**
 * Which tenant OWNS a lane's departments, for an account whose own tenant is
 * `brandId`.
 *
 * This is not the same as the tenant a TICKET belongs to, and conflating the
 * two is the easy mistake here. A ticket always carries the requester's brand —
 * that is who is asking. But the queue it is filed into belongs to whoever
 * answers:
 *
 *   support — the requester's own brand, whose team works the queue.
 *   brand   — the PLATFORM (null), because the queues a brand admin files into
 *             are the platform's own, not their tenant's.
 *
 * So a brand admin reads two different department lists depending on which side
 * of the ladder they are looking at, and both go through here.
 */
export function departmentTenant(
  lane: TicketLane,
  brandId: string | null | undefined,
): string | null {
  return lane === "brand" ? null : (brandId ?? null);
}

/**
 * Whether a handler in this lane holds every queue in it without being granted
 * one, i.e. whether department grants apply to them at all.
 *
 * A full admin does: a brand ADMIN runs the whole tenant, and the SUPER_ADMIN
 * runs the platform. STAFF are gated by the departments their role (or a direct
 * grant) holds, which is the point of having departments.
 */
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
  /**
   * The one name every handler's reply is signed with in the requester's view.
   *
   * A team speaks with one voice: a customer sees "Support" rather than which
   * of six agents happened to pick it up, and a brand admin sees "Platform".
   * Handlers still see each other's real names — see serializeMessage.
   */
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
