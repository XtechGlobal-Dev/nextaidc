import crypto from "node:crypto";
import type { Role } from "@prisma/client";
import type { Prisma, TicketPriority, TicketStatus } from "@prisma/tenant-client";
import { env } from "../env.js";
import { HttpError, badRequest, forbidden, notFound } from "../lib/http.js";
import { TtlCache } from "../lib/ttlCache.js";
import { brandAppUrl, brandDisplayName } from "../lib/brandUrls.js";
import { runWithBrand } from "../lib/brandContext.js";
import { isAdminRole, isSuperAdminRole } from "../lib/roles.js";
import {
  holdsEveryQueue,
  laneCopy,
  type TicketLane,
} from "../lib/ticketLanes.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, isAllowedAttachment } from "../lib/ticketFiles.js";
import { publishToAdmins, publishToUser } from "./events.js";
import { sendTemplate } from "./email.js";
import { deleteObject } from "./storage.js";
import { cachedBrand } from "./brands.js";
import { notifyIn } from "./notifications.js";
import {
  allTenants,
  controlPlaneAsTenant,
  laneDb,
  planeOf,
  tenantFor,
  type TenantClient,
} from "./tenantDb.js";

// Support tickets, both lanes: `support` lives in the brand's DB, `brand` in the control plane, and
// every function takes the lane's DB. A handler's reach = lane x tenant x department, applied once in `scopeFilter`.

export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/* ------------------------------ First run -------------------------------- */

// Starter customer queues; anything more, the brand asks the platform for.
const DEFAULT_SUPPORT_DEPARTMENTS = [
  { name: "General", description: "Anything else — we'll route it to the right team.", order: 0 },
  { name: "Sales", description: "Plans, upgrades and what's included.", order: 1 },
];

/** Queues a brand admin files a platform request into. */
const DEFAULT_BRAND_DEPARTMENTS = [
  { name: "General", description: "Anything else about running your brand.", order: 0 },
  { name: "Billing & Wallet", description: "Payouts, plan pricing and your wallet balance.", order: 1 },
  { name: "Technical", description: "Domains, senders, integrations and provider issues.", order: 2 },
  { name: "Account", description: "Your brand's settings, staff and access.", order: 3 },
];

/** Seeds starter departments ONLY when the lane has none — a deleted "Sales" must not come back. `db` lets provisioning seed a not-yet-routable DB. */
export async function seedTicketDepartments(
  lane: TicketLane,
  brandId: string | null,
  db?: TenantClient,
): Promise<void> {
  try {
    const target = db ?? (await laneDb(lane, brandId));
    const existing = await target.ticketDepartment.count({ where: { lane, brandId } });
    if (existing > 0) return;
    const defaults = lane === "brand" ? DEFAULT_BRAND_DEPARTMENTS : DEFAULT_SUPPORT_DEPARTMENTS;
    await target.ticketDepartment.createMany({
      data: defaults.map((d) => ({ ...d, lane, brandId })),
    });
  } catch (err) {
    console.error(`[tickets] ${lane} department seed failed:`, err);
  }
}

/** Boot seed: the platform's own queues, then every active brand's customer queues. */
export async function seedAllTicketDepartments(): Promise<void> {
  await seedTicketDepartments("brand", null);
  try {
    for (const { brandId, db } of await allTenants()) await seedTicketDepartments("support", brandId, db);
  } catch (err) {
    console.error("[tickets] brand department seed failed:", err);
  }
}

/* ------------------------------- Reference ------------------------------- */

// No I/O/0/1 — a reference gets read aloud and typed back by hand.
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function randomRef(): string {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `TCK-${out}`;
}

/** A reference that isn't taken in this database. Collisions are vanishing
 *  but not impossible. */
export async function nextReference(db: TenantClient): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = randomRef();
    const clash = await db.ticket.findUnique({ where: { reference: ref }, select: { id: true } });
    if (!clash) return ref;
  }
  // Five collisions in a row means something is very wrong with the RNG; fall
  // back to something guaranteed unique rather than looping forever.
  return `TCK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

/* ----------------------------- Attachments ------------------------------- */

/** An uploaded-but-unattached file the client replays. SIGNED, or anyone could claim an arbitrary S3 key or URL as "their attachment". */
export interface AttachmentDescriptor {
  name: string;
  mime: string;
  size: number;
  key: string;
  url: string;
  sig: string;
}

function attachmentPayload(a: Omit<AttachmentDescriptor, "sig">): string {
  return [a.key, a.url, a.name, a.mime, String(a.size)].join("\n");
}

export function signAttachment(a: Omit<AttachmentDescriptor, "sig">): AttachmentDescriptor {
  const sig = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(attachmentPayload(a))
    .digest("base64url");
  return { ...a, sig };
}

function isValidAttachment(a: AttachmentDescriptor): boolean {
  if (!a || typeof a.sig !== "string") return false;
  const expected = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(attachmentPayload(a))
    .digest("base64url");
  const got = Buffer.from(a.sig);
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Rejects forged/tampered descriptors, disallowed types, and over-long lists. */
export function verifyAttachments(
  list: AttachmentDescriptor[] | undefined,
): AttachmentDescriptor[] {
  const attachments = list ?? [];
  if (attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw badRequest(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
  }
  for (const a of attachments) {
    if (!isValidAttachment(a)) {
      throw badRequest("An attachment could not be verified. Please re-upload it.");
    }
    if (!isAllowedAttachment(a.mime, a.name)) {
      throw badRequest(`"${a.name}" is not an allowed file type.`);
    }
  }
  return attachments;
}

/* ------------------------------- Scoping --------------------------------- */

/** The handler acting. `lane` is derived from `role` by the route, never read from the request. */
export interface TicketActor {
  id: string;
  role: Role | string;
  permissions: string[];
  /** Tenant the handler belongs to; null = the platform's own people. */
  brandId: string | null;
  lane: TicketLane;
}

// Department grants, cached a few seconds (one screen load asks ~6 times). Grant edits
// call forgetDepartmentScopes, so the TTL only bounds staleness nobody caused.
const scopeCache = new TtlCache<string[]>(10_000);

export function forgetDepartmentScopes(): void {
  scopeCache.clear();
}

/** Departments the actor may work. Null = every queue (full admins). Staff get role grants UNION personal grants, empty by default. Two reads because staffRoleId is a plain id, not a relation. */
export async function departmentScope(db: TenantClient, actor: TicketActor): Promise<string[] | null> {
  if (holdsEveryQueue(actor.role)) return null;
  const cacheKey = `${actor.lane}:${actor.id}`;
  const cached = scopeCache.get(cacheKey);
  if (cached) return [...cached];
  const user = await db.user.findUnique({
    where: { id: actor.id },
    select: { staffRoleId: true, ticketDepartments: { select: { id: true, lane: true } } },
  });
  const roleGrants = user?.staffRoleId
    ? ((
        await db.staffRole.findUnique({
          where: { id: user.staffRoleId },
          select: { ticketDepartments: { select: { id: true, lane: true } } },
        })
      )?.ticketDepartments ?? [])
    : [];
  const ids = new Set<string>();
  for (const d of roleGrants) {
    if (d.lane === actor.lane) ids.add(d.id);
  }
  for (const d of user?.ticketDepartments ?? []) {
    if (d.lane === actor.lane) ids.add(d.id);
  }
  return [...scopeCache.set(cacheKey, [...ids])];
}

/** The one `where` that limits a handler to lane, tenant, department and ownership. A held ticket is the holder's alone; full admins see everything. */
export function scopeFilter(
  actor: TicketActor,
  scope: string[] | null,
): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = { lane: actor.lane };
  // The DB already is the brand's; the column is the same wall said twice, and
  // what lets the platform inbox filter by brand.
  if (actor.brandId) where.brandId = actor.brandId;
  if (scope !== null) {
    // `in: []` matches nothing, which is exactly right for a role with no
    // departments granted.
    where.departmentId = { in: scope };
    // Under AND rather than as a bare OR: the list's search puts its own OR on
    // the same `where`, and two top-level ORs would overwrite each other.
    where.AND = [{ OR: [{ assignedToId: null }, { assignedToId: actor.id }] }];
  }
  return where;
}

/** Load a ticket for a handler, 404-ing anything outside their reach. */
export async function loadTicketForHandler(db: TenantClient, id: string, actor: TicketActor) {
  const scope = await departmentScope(db, actor);
  const ticket = await db.ticket.findFirst({
    where: { id, ...scopeFilter(actor, scope) },
    include: ticketInclude,
  });
  // Deliberately 404, not 403: whether a ticket exists in another brand — or in
  // another team's queue — is itself information a handler shouldn't have.
  if (!ticket) throw notFound("Ticket not found");
  return (await attachEscalationPairs([ticket]))[0];
}

/** Load a ticket the CALLER raised, 404-ing anyone else's. */
export async function loadTicketForRequester(db: TenantClient, id: string, requesterId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id, requesterId },
    include: ticketInclude,
  });
  if (!ticket) throw notFound("Ticket not found");
  return (await attachEscalationPairs([ticket]))[0];
}

/* --------------------------- Who answers a queue -------------------------- */

/** The platform owner. The control plane's Role has SUPER_ADMIN where the
 *  tenant's does not, so the clause is built loose and only ever run there. */
const PLATFORM_OWNER = { role: "SUPER_ADMIN" } as unknown as Prisma.UserWhereInput;
/** The control plane's own people carry no brand. Same story. */
const PLATFORM_ONLY = { brandId: null } as unknown as Prisma.UserWhereInput;

/** Roles holding any department that `match`es — by id, because a user's role
 *  is a plain id rather than a relation this query could walk. */
async function rolesGranted(
  db: TenantClient,
  match: Prisma.TicketDepartmentWhereInput,
): Promise<string[]> {
  const roles = await db.staffRole.findMany({
    where: { ticketDepartments: { some: match } },
    select: { id: true },
  });
  return roles.map((r) => r.id);
}

/** STAFF holding the capability and a grant — through their role or personally. */
function staffHolding(
  match: Prisma.TicketDepartmentWhereInput,
  roleIds: string[],
  capabilityKey: string,
  extra: Prisma.UserWhereInput[] = [],
): Prisma.UserWhereInput {
  return {
    role: "STAFF",
    permissions: { has: capabilityKey },
    ...(extra.length ? { AND: extra } : {}),
    OR: [{ staffRoleId: { in: roleIds } }, { ticketDepartments: { some: match } }],
  };
}

// Platform inbox handlers: the super admin plus brand-less staff holding brand_tickets.*
// and a grant on the queue. No queue named = the owner alone.
async function platformHandlerWhere(
  db: TenantClient,
  match: Prisma.TicketDepartmentWhereInput | null,
  capability: "view" | "edit",
): Promise<Prisma.UserWhereInput> {
  if (!match) return PLATFORM_OWNER;
  const roleIds = await rolesGranted(db, match);
  return {
    OR: [PLATFORM_OWNER, staffHolding(match, roleIds, `brand_tickets.${capability}`, [PLATFORM_ONLY])],
  };
}

/** Who answers a lane's tickets (or a department's). One definition for the assignee picker AND the notification fan-out so they can't drift. SUPER_ADMIN never appears on support — a tenant's customers are the tenant's business. */
export async function handlerWhere(
  db: TenantClient,
  lane: TicketLane,
  departmentId: string | null,
  capability: "view" | "edit" = "view",
): Promise<Prisma.UserWhereInput> {
  if (lane === "brand") {
    return platformHandlerWhere(db, departmentId ? { id: departmentId } : null, capability);
  }
  if (!departmentId) return { role: "ADMIN" };
  const match = { id: departmentId };
  return {
    OR: [{ role: "ADMIN" }, staffHolding(match, await rolesGranted(db, match), `tickets.${capability}`)],
  };
}

/** handlerWhere across several departments (null = any) — the inbox's assignee filter. */
export async function handlersWhere(
  db: TenantClient,
  lane: TicketLane,
  departmentIds: string[] | null,
  capability: "view" | "edit" = "view",
): Promise<Prisma.UserWhereInput> {
  const match: Prisma.TicketDepartmentWhereInput =
    departmentIds === null ? { lane } : { id: { in: departmentIds } };
  if (lane === "brand") return platformHandlerWhere(db, match, capability);
  return {
    OR: [{ role: "ADMIN" }, staffHolding(match, await rolesGranted(db, match), `tickets.${capability}`)],
  };
}

/** Guard for anything a handler does beyond reading. */
export function assertCan(
  actor: TicketActor,
  capability: "view" | "create" | "edit" | "delete",
): void {
  if (actor.lane === "brand") {
    // Owner, or brand-less staff with brand_tickets.*; the brandId check is belt and braces.
    if (isSuperAdminRole(actor.role)) return;
    if (
      actor.role === "STAFF" &&
      !actor.brandId &&
      actor.permissions.includes(`brand_tickets.${capability}`)
    ) {
      return;
    }
    throw forbidden("You don't have permission to do that.");
  }
  if (isSuperAdminRole(actor.role)) {
    // Symmetry with requirePermission: a tenant's customer conversations are
    // refused to the platform owner, not merely hidden from them.
    throw forbidden("This section belongs to a brand, not the platform.");
  }
  if (isAdminRole(actor.role)) return;
  if (actor.role === "STAFF" && actor.permissions.includes(`tickets.${capability}`)) return;
  throw forbidden("You don't have permission to do that.");
}

/* ------------------------------ Serializing ------------------------------- */

export const ticketInclude = {
  department: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.TicketInclude;

/** The customer ticket a platform ticket was raised from — thin on purpose:
 *  each side shows the other's reference and state, never the other thread. */
export interface EscalatedFromPair {
  id: string;
  number: number;
  reference: string;
  subject: string;
  status: string;
  requesterName: string;
}

/** The platform ticket a customer ticket was escalated to. */
export interface EscalationPair {
  id: string;
  reference: string;
  status: string;
}

// Everything a bubble needs. `replyTo` is a thin SELECT, not the whole message, or a
// reply thread fans out into a tree of full messages.
export const messageInclude = {
  attachments: true,
  reactions: true,
  replyTo: {
    select: {
      id: true,
      authorType: true,
      authorName: true,
      body: true,
      internal: true,
      deletedAt: true,
      attachments: { select: { id: true, mime: true }, take: 1 },
    },
  },
} satisfies Prisma.TicketMessageInclude;

/** Who raised a ticket, from the snapshot on the row — on the brand lane the requester lives in another DB, so the name/email written at creation is what every reader shows. */
export interface RequesterRef {
  id: string;
  fullName: string;
  email: string;
  role: string;
}

export function requesterOf(t: { requesterId: string; requesterName: string; requesterEmail: string; lane: string }): RequesterRef {
  return {
    id: t.requesterId,
    fullName: t.requesterName,
    email: t.requesterEmail,
    role: t.lane === "brand" ? "ADMIN" : "USER",
  };
}

/** A loaded row, completed with its requester. */
export function withRequester<T extends { requesterId: string; requesterName: string; requesterEmail: string; lane: string }>(
  t: T,
): T & { requester: RequesterRef } {
  return { ...t, requester: requesterOf(t) };
}

export type TicketRow = Prisma.TicketGetPayload<{ include: typeof ticketInclude }> & {
  requester: RequesterRef;
  escalatedFrom?: EscalatedFromPair | null;
  escalation?: EscalationPair | null;
};
type MessageRow = Prisma.TicketMessageGetPayload<{ include: typeof messageInclude }>;
type ReactionRow = MessageRow["reactions"][number];

/** Fills in the other half of each escalation from the other database: one batched read per direction, never a join. An unreachable brand DB leaves its half absent rather than failing the list. */
export async function attachEscalationPairs<
  T extends {
    escalationId: string | null;
    escalatedFromId: string | null;
    escalatedFromBrandId: string | null;
    requesterId: string;
    requesterName: string;
    requesterEmail: string;
    lane: string;
  },
>(rows: T[]): Promise<(T & { requester: RequesterRef; escalatedFrom: EscalatedFromPair | null; escalation: EscalationPair | null })[]> {
  const upIds = rows.map((r) => r.escalationId).filter((id): id is string => !!id);
  const up = new Map<string, EscalationPair>();
  if (upIds.length) {
    const found = await controlPlaneAsTenant()
      .ticket.findMany({ where: { id: { in: upIds } }, select: { id: true, reference: true, status: true } })
      .catch(() => []);
    for (const f of found) up.set(f.id, { id: f.id, reference: f.reference, status: f.status });
  }

  const downByBrand = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.escalatedFromId || !r.escalatedFromBrandId) continue;
    const list = downByBrand.get(r.escalatedFromBrandId) ?? [];
    list.push(r.escalatedFromId);
    downByBrand.set(r.escalatedFromBrandId, list);
  }
  const down = new Map<string, EscalatedFromPair>();
  for (const [brandId, ids] of downByBrand) {
    try {
      const tenant = await tenantFor(brandId);
      const found = await tenant.ticket.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          reference: true,
          subject: true,
          status: true,
          requesterName: true,
          requesterEmail: true,
        },
      });
      for (const f of found) {
        down.set(f.id, {
          id: f.id,
          number: f.number,
          reference: f.reference,
          subject: f.subject,
          status: f.status,
          requesterName: f.requesterName || f.requesterEmail,
        });
      }
    } catch {
      // The brand's database is not reachable right now: its half of the pair
      // reads as absent, and the platform's ticket still opens.
    }
  }

  return rows.map((r) => ({
    ...r,
    requester: requesterOf(r),
    escalation: r.escalationId ? (up.get(r.escalationId) ?? null) : null,
    escalatedFrom: r.escalatedFromId ? (down.get(r.escalatedFromId) ?? null) : null,
  }));
}

export function serializeAttachment(a: {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: Date;
}) {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, url: a.url, createdAt: a.createdAt };
}

/** Group the raw reaction rows into the pills the chat draws: one per emoji,
 *  with a count, who put it there, and whether the VIEWER is one of them. */
function serializeReactions(rows: ReactionRow[], viewerKey: string | null, handlerLabel?: string) {
  const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean; names: string[] }>();
  for (const r of rows) {
    const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, names: [] };
    entry.count += 1;
    if (viewerKey !== null && r.actorKey === viewerKey) entry.mine = true;
    entry.names.push(
      handlerLabel && r.actorType === "staff" ? handlerLabel : r.actorName || "Someone",
    );
    byEmoji.set(r.emoji, entry);
  }
  // Most-reacted first, so the pill that means the most sits nearest the bubble.
  return [...byEmoji.values()].sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

function serializeReplyTo(m: MessageRow, handlerLabel?: string) {
  const r = m.replyTo;
  if (!r) return null;
  // An internal note quoted in a requester-facing view would leak the note. The
  // reply itself still stands; it just loses the quote above it.
  if (handlerLabel && r.internal) return null;
  const attachment = r.attachments[0];
  return {
    id: r.id,
    authorType: r.authorType,
    authorName: handlerLabel && r.authorType === "staff" ? handlerLabel : r.authorName,
    body: r.deletedAt ? "" : preview(r.body, false, 140),
    deleted: !!r.deletedAt,
    internal: handlerLabel ? false : r.internal,
    /** "photo" / "file" — what to say when the quoted message had no text. */
    attachmentKind:
      r.deletedAt || !attachment ? null : attachment.mime.startsWith("image/") ? "image" : "file",
  };
}

/** The handler's view — internal notes included, real author names on every reply. */
export function serializeMessage(m: MessageRow, viewerKey: string | null = null) {
  const deleted = !!m.deletedAt;
  return {
    id: m.id,
    authorType: m.authorType,
    authorId: m.authorId,
    authorName: m.authorName,
    // Cleared server-side, not just in the UI, so deleted text never reaches a client.
    body: deleted ? "" : m.body,
    internal: m.internal,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deleted,
    replyTo: deleted ? null : serializeReplyTo(m),
    attachments: deleted ? [] : m.attachments.map(serializeAttachment),
    reactions: deleted ? [] : serializeReactions(m.reactions, viewerKey),
  };
}

/** Requester's view: handler names collapse to the lane label (a team, not a rota). Internal notes are filtered by the query. */
export function serializeMessageForRequester(
  m: MessageRow,
  lane: TicketLane,
  viewerKey: string | null = null,
) {
  const label = laneCopy(lane).handlerLabel;
  const deleted = !!m.deletedAt;
  return {
    id: m.id,
    authorType: m.authorType,
    authorId: m.authorType === "staff" ? null : m.authorId,
    authorName: m.authorType === "staff" ? label : m.authorName,
    body: deleted ? "" : m.body,
    internal: false,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deleted,
    replyTo: deleted ? null : serializeReplyTo(m, label),
    attachments: deleted ? [] : m.attachments.map(serializeAttachment),
    reactions: deleted ? [] : serializeReactions(m.reactions, viewerKey, label),
  };
}

/** The brand a ticket belongs to, by name — from the brands cache, since a
 *  ticket row names its brand by id only and the brand table is the platform's. */
function brandOf(brandId: string | null): { id: string; name: string; slug: string } | null {
  const b = cachedBrand(brandId);
  return b ? { id: b.id, name: b.name, slug: b.slug } : null;
}

export function serializeTicket(
  t: TicketRow,
  extra: { lastMessage?: string; messageCount?: number } = {},
) {
  return {
    id: t.id,
    number: t.number,
    reference: t.reference,
    subject: t.subject,
    lane: t.lane as TicketLane,
    status: t.status,
    priority: t.priority,
    source: t.source,
    department: t.department,
    /** On lane `brand` WHICH BRAND matters as much as who, so the tenant travels with the ticket. */
    requester: {
      id: t.requester.id,
      name: t.requester.fullName || t.requester.email,
      email: t.requester.email,
      role: t.requester.role,
    },
    brand: brandOf(t.brandId),
    assignedTo: t.assignedTo
      ? { id: t.assignedTo.id, name: t.assignedTo.fullName || t.assignedTo.email }
      : null,
    lastMessageAt: t.lastMessageAt,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    unreadForStaff: t.unreadForStaff,
    unreadForRequester: t.unreadForRequester,
    // Both sides' read marks go to both sides: each one needs the OTHER's to
    // decide whether the message it just sent has been seen.
    staffReadAt: t.staffReadAt,
    requesterReadAt: t.requesterReadAt,
    rating: t.rating,
    ratingComment: t.ratingComment,
    ratedAt: t.ratedAt,
    // Computed once here — three client surfaces must not answer it three ways.
    rateable: isRateable(t.status),
    /** The customer ticket this platform ticket was raised FROM — set only on
     *  an escalation (see escalateTicket), filled by attachEscalationPairs. */
    escalatedFrom: t.escalatedFrom ?? null,
    /** The platform ticket this customer ticket was escalated TO, if any. */
    escalation: t.escalation ?? null,
    ...extra,
  };
}

/** Requester's view: the assignee is masked to the lane label (the side panel once read "Super Admin is looking after this"). Assignment itself is kept; only the identity goes, id included. */
export function serializeTicketForRequester(
  t: TicketRow,
  extra: { lastMessage?: string; messageCount?: number } = {},
) {
  const base = serializeTicket(t, extra);
  return {
    ...base,
    assignedTo: base.assignedTo ? { id: null, name: laneCopy(t.lane as TicketLane).handlerLabel } : null,
    // A customer never sees that their brand escalated to the platform — that's
    // between the brand and the platform.
    escalation: t.lane === "support" ? null : base.escalation,
  };
}

/** A ticket that was folded into the one being read. The source row is gone, so
 *  the snapshot on the merge record is all that is left of it. */
export function serializeMerge(m: {
  id: string;
  sourceNumber: number;
  sourceReference: string;
  sourceSubject: string;
  sourceRequesterName: string;
  sourceCreatedAt: Date;
  messageCount: number;
  mergedByName: string;
  mergedAt: Date;
}) {
  return {
    id: m.id,
    number: m.sourceNumber,
    reference: m.sourceReference,
    subject: m.sourceSubject,
    requesterName: m.sourceRequesterName,
    createdAt: m.sourceCreatedAt,
    messageCount: m.messageCount,
    mergedBy: m.mergedByName,
    mergedAt: m.mergedAt,
  };
}

/* ------------------------------- Previews -------------------------------- */

/** The one-line preview a ticket shows in an inbox list. */
export function messagePreview(
  message: { body: string; deletedAt?: Date | null; attachments: { mime: string }[] } | undefined,
): string {
  if (!message) return "";
  if (message.deletedAt) return "Message deleted";
  if (message.body) return message.body;
  const first = message.attachments[0];
  if (!first) return "";
  return first.mime.startsWith("image/") ? "📷 Photo" : "📎 Attachment";
}

/** Short, safe preview of a message body for a notification or email line. */
export function preview(body: string, hadAttachments = false, max = 300): string {
  const text = (body ?? "").trim();
  if (!text) return hadAttachments ? "(sent an attachment)" : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* --------------------------------- URLs ---------------------------------- */

/** One "my requests" page for both lanes; who's signed in decides which lane it shows. */
export function requesterTicketPath(ticketId: string): string {
  return `/dashboard/support?ticket=${ticketId}`;
}

/** Handler inbox path — brand admins at /dashboard/admin, the platform owner at /superadmin. */
export function handlerTicketPath(lane: TicketLane, ticketId: string): string {
  const base = lane === "brand" ? "/superadmin/tickets" : "/dashboard/admin/tickets";
  return `${base}?ticket=${ticketId}`;
}

// Mail wears the recipient's own brand. The exception: mail to the platform owner about a
// brand's query comes from the platform, or the super admin's inbox fills with tenant-branded mail.
function mailBrandFor(ticket: TicketRow, side: "requester" | "handler"): string | null {
  if (side === "handler" && ticket.lane === "brand") return null;
  return ticket.brandId ?? null;
}

/* ------------------------------ Departments ------------------------------ */

/** Validates the department by lane AND tenant, not just existence — otherwise a caller could file a ticket into another brand's queue by id. */
export async function resolveDepartment(
  db: TenantClient,
  departmentId: string | null | undefined,
  opts: {
    lane: TicketLane;
    brandId: string | null;
    requireSelectable?: boolean;
    requireRequesterVisible?: boolean;
  },
): Promise<string | null> {
  if (!departmentId) {
    if (opts.requireSelectable) throw badRequest("Choose a department for your request.");
    return null;
  }
  const dept = await db.ticketDepartment.findFirst({
    where: { id: departmentId, lane: opts.lane, brandId: opts.brandId },
  });
  if (!dept) throw badRequest("That department isn't available.");
  if (opts.requireSelectable && !dept.enabled) throw badRequest("That department isn't available.");
  if (opts.requireRequesterVisible && !dept.requesterVisible) {
    throw badRequest("That department isn't available.");
  }
  return dept.id;
}

/* ---------------------------- Writing a message --------------------------- */

export interface AppendMessageInput {
  ticketId: string;
  authorType: "requester" | "staff" | "system";
  authorId?: string | null;
  authorName: string;
  body: string;
  internal?: boolean;
  attachments?: AttachmentDescriptor[];
  /** Quoted message. Validated with {@link resolveReplyTo} before it is stored. */
  replyToId?: string | null;
  /** False for requester-facing callers, so nobody can quote a staff note. */
  canQuoteInternal?: boolean;
}

/** The quoted message, or null. Must live in THIS ticket (or a foreign id reads a thread the client can't open), and a requester may not quote an internal note. */
export async function resolveReplyTo(
  db: TenantClient,
  ticketId: string,
  replyToId: string | null | undefined,
  opts: { canQuoteInternal?: boolean } = {},
): Promise<string | null> {
  if (!replyToId) return null;
  const target = await db.ticketMessage.findFirst({
    where: { id: replyToId, ticketId },
    select: { id: true, internal: true },
  });
  if (!target || (target.internal && !opts.canQuoteInternal)) {
    throw badRequest("The message you're replying to is no longer available.");
  }
  return target.id;
}

/** Writes a message + attachments and moves the ticket's activity markers. Empty messages are rejected here so no route has to. */
export async function appendMessage(db: TenantClient, input: AppendMessageInput) {
  const body = input.body.trim();
  const attachments = input.attachments ?? [];
  if (!body && attachments.length === 0) throw badRequest("Type a message or attach a file.");

  const replyToId = await resolveReplyTo(db, input.ticketId, input.replyToId, {
    canQuoteInternal: input.canQuoteInternal,
  });

  const message = await db.ticketMessage.create({
    data: {
      ticketId: input.ticketId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      authorName: input.authorName,
      body,
      internal: input.internal ?? false,
      replyToId,
      attachments: {
        create: attachments.map((a) => ({
          ticketId: input.ticketId,
          name: a.name,
          mime: a.mime,
          size: a.size,
          key: a.key,
          url: a.url,
          uploadedById: input.authorId ?? null,
        })),
      },
    },
    include: messageInclude,
  });

  // An internal note is handlers talking to each other: it must not mark the
  // thread unread for the requester, and it must not count as a reply.
  if (!input.internal) {
    await db.ticket.update({
      where: { id: input.ticketId },
      data: {
        lastMessageAt: message.createdAt,
        ...(input.authorType === "requester"
          ? { unreadForStaff: true, unreadForRequester: false }
          : { unreadForRequester: true, unreadForStaff: false }),
      },
    });
  }

  return message;
}

// Message-level actions (edit, delete, react), shared by both lanes and sides.

/** Edit window. Short on purpose — a thread is a record, and silently changing replied-to text is worse than a visible correction. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/** Who is acting on a message — the same shape on both sides of both lanes. */
export interface MessageActor {
  /** Identity reactions are unique per — always a user id here. */
  key: string;
  type: "requester" | "staff";
  name: string;
  userId: string;
  /** A handler with `*.delete` may remove anyone's message on their tickets. */
  canModerate?: boolean;
}

/** Load a message that belongs to this ticket, or 404. */
async function loadMessage(db: TenantClient, ticketId: string, messageId: string, actor: MessageActor) {
  const message = await db.ticketMessage.findFirst({
    where: {
      id: messageId,
      ticketId,
      // A requester must not be able to reach a handler note by id, in any handler.
      ...(actor.type === "requester" ? { internal: false } : {}),
    },
    include: messageInclude,
  });
  if (!message) throw notFound("Message not found");
  return message;
}

function isAuthor(m: { authorType: string; authorId: string | null }, actor: MessageActor): boolean {
  return m.authorType === actor.type && m.authorId === actor.userId;
}

export async function editMessage(
  db: TenantClient,
  ticketId: string,
  messageId: string,
  actor: MessageActor,
  body: string,
) {
  const message = await loadMessage(db, ticketId, messageId, actor);
  if (message.deletedAt) throw badRequest("That message was deleted.");
  if (!isAuthor(message, actor)) throw forbidden("You can only edit your own messages.");
  if (Date.now() - message.createdAt.getTime() > MESSAGE_EDIT_WINDOW_MS) {
    throw badRequest("This message is too old to edit. Send a new one instead.");
  }
  const next = body.trim();
  // Editing the text away would leave a bubble with nothing in it; that is what
  // delete is for. A message carrying files may legitimately lose its caption.
  if (!next && message.attachments.length === 0) {
    throw badRequest("A message can't be empty — delete it instead.");
  }
  if (next === message.body) return message;

  return db.ticketMessage.update({
    where: { id: message.id },
    data: { body: next, editedAt: new Date() },
    include: messageInclude,
  });
}

/** Soft-delete: the row stays so quoting replies still read, but text, files and reactions go. */
export async function deleteMessage(
  db: TenantClient,
  ticketId: string,
  messageId: string,
  actor: MessageActor,
) {
  const message = await loadMessage(db, ticketId, messageId, actor);
  if (message.deletedAt) return message;
  if (!isAuthor(message, actor) && !actor.canModerate) {
    throw forbidden("You can only delete your own messages.");
  }

  const keys = message.attachments.map((a) => a.key);
  const updated = await db.$transaction(async (inLane) => {
    await inLane.ticketAttachment.deleteMany({ where: { messageId: message.id } });
    await inLane.ticketMessageReaction.deleteMany({ where: { messageId: message.id } });
    return inLane.ticketMessage.update({
      where: { id: message.id },
      data: { body: "", deletedAt: new Date() },
      include: messageInclude,
    });
  });

  // Bucket cleanup after the rows are gone: an orphaned object costs pennies, a
  // failed delete that blocked the action costs the person the action.
  for (const key of keys) void deleteObject(key);
  return updated;
}

/** The emoji a message may carry. A closed set keeps the pills predictable and
 *  stops the column becoming a place to paste arbitrary text. */
export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"] as const;

/** Add the emoji, or remove it if this actor already put it there. */
export async function toggleReaction(
  db: TenantClient,
  ticketId: string,
  messageId: string,
  actor: MessageActor,
  emoji: string,
) {
  if (!ALLOWED_REACTIONS.includes(emoji as (typeof ALLOWED_REACTIONS)[number])) {
    throw badRequest("That reaction isn't available.");
  }
  const message = await loadMessage(db, ticketId, messageId, actor);
  if (message.deletedAt) throw badRequest("That message was deleted.");

  const existing = await db.ticketMessageReaction.findUnique({
    where: { messageId_actorKey_emoji: { messageId: message.id, actorKey: actor.key, emoji } },
    select: { id: true },
  });
  if (existing) {
    await db.ticketMessageReaction.delete({ where: { id: existing.id } });
  } else {
    await db.ticketMessageReaction.create({
      data: {
        messageId: message.id,
        actorKey: actor.key,
        actorType: actor.type,
        actorName: actor.name,
        emoji,
      },
    });
  }

  return db.ticketMessage.findUniqueOrThrow({
    where: { id: message.id },
    include: messageInclude,
  });
}

/* ---------------------------- Read marks + live --------------------------- */

/** Marks one side read and nudges the other — only on the transition, or the two tabs ping-pong forever (a nudge re-fetches, a re-fetch marks read). */
export async function markThreadRead(
  db: TenantClient,
  ticket: Pick<
    TicketRow,
    "id" | "requesterId" | "unreadForStaff" | "unreadForRequester" | "lane" | "brandId"
  >,
  side: "staff" | "requester",
): Promise<void> {
  const now = new Date();
  if (side === "staff") {
    if (!ticket.unreadForStaff) return;
    await db.ticket.update({
      where: { id: ticket.id },
      data: { unreadForStaff: false, staffReadAt: now },
    });
    publishToUser(ticket.requesterId, { type: "ticket", ticketId: ticket.id });
  } else {
    if (!ticket.unreadForRequester) return;
    await db.ticket.update({
      where: { id: ticket.id },
      data: { unreadForRequester: false, requesterReadAt: now },
    });
    publishToAdmins({ type: "ticket", ticketId: ticket.id });
  }
}

/** Nudges the other side after an edit/delete/reaction — these don't move lastMessageAt, so nothing else would trigger a re-read. */
export function publishThreadChanged(
  ticket: { id: string; requesterId: string },
  from: "staff" | "requester",
): void {
  const event = { type: "ticket", ticketId: ticket.id };
  if (from === "staff") publishToUser(ticket.requesterId, event);
  else publishToAdmins(event);
}

/** Tell the other side that someone is typing. Fire-and-forget: it carries no
 *  data, expires on its own in the client, and is never worth an error. */
export function publishTyping(
  ticket: { id: string; requesterId: string },
  from: "staff" | "requester",
  name: string,
): void {
  const event = { type: "ticket-typing", ticketId: ticket.id, from, name };
  if (from === "staff") publishToUser(ticket.requesterId, event);
  else publishToAdmins(event);
}

/* ------------------------------- Notifying -------------------------------- */

interface Recipient {
  id: string;
  email: string;
  fullName: string;
}

// Recipients by channel: `inApp` is everyone who can OPEN the thread (bell matches the
// click); `email` is the team while unassigned, then only the holder (mail to everyone gets filtered by everyone).
async function ticketStaffRecipients(
  db: TenantClient,
  ticket: TicketRow,
): Promise<{ inApp: Recipient[]; email: Recipient[] }> {
  const select = { id: true, email: true, fullName: true } as const;
  const lane = ticket.lane as TicketLane;

  const team = await db.user.findMany({
    where: await handlerWhere(db, lane, ticket.departmentId),
    select,
  });

  if (!ticket.assignedToId) return { inApp: team, email: team };

  // The assignee may sit outside `team` — an admin can hand a ticket to anyone,
  // and a department grant can be revoked afterwards. Either way they own it.
  const owner =
    team.find((u) => u.id === ticket.assignedToId) ??
    (await db.user.findUnique({ where: { id: ticket.assignedToId }, select }));

  // Once held, colleagues can't open it, so no bell for them; full admins still hear.
  // No department = handlerWhere narrows to those admins alone.
  const admins = await db.user.findMany({
    where: await handlerWhere(db, lane, null),
    select,
  });
  const inApp = owner && !admins.some((u) => u.id === owner.id) ? [...admins, owner] : admins;
  return { inApp, email: owner ? [owner] : [] };
}

/** Every account that must be told about a ticket, whichever lane it is on. */
function ticketVars(ticket: TicketRow, extra: Record<string, string> = {}) {
  return {
    ticket_reference: ticket.reference,
    ticket_subject: ticket.subject,
    department: ticket.department?.name ?? "Unassigned",
    priority: ticket.priority,
    requester_name: ticket.requester.fullName || ticket.requester.email,
    requester_email: ticket.requester.email,
    /** Which tenant is asking — the thing a platform-side handler needs first. */
    brand_name: cachedBrand(ticket.brandId)?.name ?? brandDisplayName(null),
    ...extra,
  };
}

/** Notifies the handler side: bell for everyone who can open it, email (when `templateKey`) for the owner. `excludeUserId` keeps the actor off both lists. */
export async function notifyTicketStaff(
  db: TenantClient,
  ticket: TicketRow,
  n: {
    title: string;
    message: string;
    /** Omit for in-app only (low-signal events, e.g. a requester closing). */
    templateKey?: string;
    templateVars?: Record<string, string>;
    excludeUserId?: string | null;
  },
): Promise<void> {
  try {
    const lane = ticket.lane as TicketLane;
    const audience = await ticketStaffRecipients(db, ticket);
    const inApp = audience.inApp.filter((r) => r.id !== n.excludeUserId);
    const recipients = audience.email.filter((r) => r.id !== n.excludeUserId);
    const link = handlerTicketPath(lane, ticket.id);

    await notifyIn(
      db,
      inApp.map((r) => r.id),
      { type: "ticket", title: n.title, message: n.message, link },
    );
    publishToAdmins({ type: "ticket", ticketId: ticket.id });

    if (n.templateKey) {
      const mailBrand = mailBrandFor(ticket, "handler");
      const vars = {
        ...ticketVars(ticket, n.templateVars),
        ticket_url: brandAppUrl(handlerTicketPath(lane, ticket.id), mailBrand),
      };
      for (const r of recipients) {
        // The try/catch matters: a mailer that throws synchronously would abort the
        // loop and skip everyone after a bad address.
        try {
          runWithBrand(mailBrand, () => {
            void sendTemplate(n.templateKey!, r.email, {
              ...vars,
              user_name: r.fullName || r.email,
            }).catch((err) => console.error("[tickets] handler email failed:", err));
          });
        } catch (err) {
          console.error("[tickets] handler email failed:", err);
        }
      }
    }
  } catch (err) {
    // A ticket must never fail because its notification did.
    console.error("[tickets] handler notify failed:", err);
  }
}

/** Notifies the requester. On both lanes they live in their brand's DB, so the bell goes there — whichever DB holds the ticket. */
export async function notifyRequester(
  ticket: TicketRow,
  opts: {
    title: string;
    message: string;
    /** Overrides where the bell sends them — e.g. straight into the rating card. */
    link?: string;
    templateKey?: string;
    templateVars?: Record<string, string>;
  },
): Promise<void> {
  try {
    const home = await planeOf(ticket.brandId);
    await notifyIn(home, [ticket.requesterId], {
      type: "ticket",
      title: opts.title,
      message: opts.message,
      link: opts.link ?? requesterTicketPath(ticket.id),
    });
    publishToUser(ticket.requesterId, { type: "ticket", ticketId: ticket.id });

    if (opts.templateKey && ticket.requester.email) {
      const mailBrand = mailBrandFor(ticket, "requester");
      const vars = {
        ...ticketVars(ticket, opts.templateVars),
        user_name: ticket.requester.fullName || ticket.requester.email,
        ticket_url: brandAppUrl(opts.link ?? requesterTicketPath(ticket.id), mailBrand),
        // What to call whoever is answering, in the requester's own words.
        handler_name: laneCopy(ticket.lane as TicketLane).handlerName,
      };
      runWithBrand(mailBrand, () => {
        void sendTemplate(opts.templateKey!, ticket.requester.email, vars).catch((err) =>
          console.error("[tickets] requester email failed:", err),
        );
      });
    }
  } catch (err) {
    console.error("[tickets] requester notify failed:", err);
  }
}

/** How long a thread has to sit quiet before a new message also goes out as mail. */
export const IDLE_BEFORE_EMAIL_MS = 60 * 60 * 1000;

/** Email as well as bell only once the thread has been quiet an hour — a live conversation is read on screen. `lastMessageAt` must be the value from BEFORE the new message. */
export function shouldEmailForMessage(ticket: { lastMessageAt: Date }): boolean {
  return Date.now() - ticket.lastMessageAt.getTime() >= IDLE_BEFORE_EMAIL_MS;
}

/** The internal one-liner a hand-over leaves in the thread. Pure, so the wording is testable. */
export function handoffLine(
  actorName: string,
  change: {
    /** Name of the department it moved to; omit when it didn't move. */
    movedTo?: string | null;
    /** New assignee's name, null when unassigned, omit when unchanged. */
    assignee?: string | null;
    /** The actor assigned it to themselves. */
    self?: boolean;
  },
  note = "",
): string {
  let line: string;
  if (change.movedTo) {
    line = `${actorName} moved this to ${change.movedTo}`;
    if (change.self) line += " and took it";
    else if (change.assignee) line += ` and assigned it to ${change.assignee}`;
    else if (change.assignee === null) line += " — nobody holds it yet";
  } else if (change.self) {
    line = `${actorName} took this`;
  } else if (change.assignee) {
    line = `${actorName} assigned this to ${change.assignee}`;
  } else {
    line = `${actorName} unassigned this — nobody holds it now`;
  }
  const trimmed = note.trim();
  return trimmed ? `${line}: “${trimmed}”` : `${line}.`;
}

/** Hand-over notice: the new holder hears; if nobody holds it, the lane's admins hear (a dropped ticket must land on someone's desk). Taking it yourself tells no one. */
export async function notifyTicketHandoff(
  db: TenantClient,
  ticket: TicketRow,
  h: { actorId: string; actorName: string; note?: string; movedTo?: string | null },
): Promise<void> {
  try {
    const lane = ticket.lane as TicketLane;
    const select = { id: true, email: true, fullName: true } as const;
    let recipients: Recipient[];
    if (ticket.assignedToId) {
      if (ticket.assignedToId === h.actorId) return;
      const owner = await db.user.findUnique({ where: { id: ticket.assignedToId }, select });
      recipients = owner ? [owner] : [];
    } else {
      recipients = (
        await db.user.findMany({ where: await handlerWhere(db, lane, null), select })
      ).filter((r) => r.id !== h.actorId);
    }
    if (recipients.length === 0) return;

    const note = (h.note ?? "").trim();
    const assigned = !!ticket.assignedToId;
    const change = assigned
      ? "Assigned to you"
      : h.movedTo
        ? `Moved to ${h.movedTo} — unassigned`
        : "Unassigned";
    const detail = assigned
      ? h.movedTo
        ? `moved this ticket to ${h.movedTo} and assigned it to you`
        : "assigned this ticket to you"
      : h.movedTo
        ? `moved this ticket to ${h.movedTo}; nobody holds it now`
        : "unassigned this ticket; nobody holds it now";

    await notifyIn(
      db,
      recipients.map((r) => r.id),
      {
        type: "ticket",
        title: `${change} · ${ticket.reference}`,
        message: note ? `${h.actorName}: ${note}` : `${h.actorName} ${detail}`,
        link: handlerTicketPath(lane, ticket.id),
      },
    );
    publishToAdmins({ type: "ticket", ticketId: ticket.id });

    const mailBrand = mailBrandFor(ticket, "handler");
    const vars = {
      ...ticketVars(ticket),
      ticket_url: brandAppUrl(handlerTicketPath(lane, ticket.id), mailBrand),
      actor_name: h.actorName,
      change,
      change_detail: detail,
      note: note ? `Note from ${h.actorName}: “${note}”` : "",
    };
    for (const r of recipients) {
      try {
        runWithBrand(mailBrand, () => {
          void sendTemplate("ticket_staff_handoff", r.email, {
            ...vars,
            user_name: r.fullName || r.email,
          }).catch((err) => console.error("[tickets] handoff email failed:", err));
        });
      } catch (err) {
        console.error("[tickets] handoff email failed:", err);
      }
    }
  } catch (err) {
    console.error("[tickets] handoff notify failed:", err);
  }
}

/* ------------------------------- Escalation ------------------------------- */

const ESCALATION_SUBJECT_MAX = 140;

/** Escalates a customer ticket: a NEW brand-lane ticket in the control plane, linked by id across the two DBs. The platform never reads the customer thread — only the admin's account of it. One escalation per ticket (409 on a repeat). */
export async function escalateTicket(
  db: TenantClient,
  ticket: TicketRow,
  actor: { id: string; name: string; brandId: string },
  input: { departmentId: string; note: string },
): Promise<TicketRow> {
  if (ticket.lane !== "support") throw badRequest("Only a customer's request can be escalated.");
  const main = controlPlaneAsTenant();
  const existing = await main.ticket.findUnique({
    where: { escalatedFromId: ticket.id },
    select: { reference: true },
  });
  if (existing) throw new HttpError(409, `Already escalated to the platform as ${existing.reference}.`);

  const departmentId = await resolveDepartment(main, input.departmentId, {
    lane: "brand",
    brandId: null,
    requireSelectable: true,
    requireRequesterVisible: true,
  });

  const admin = await db.user.findUnique({ where: { id: actor.id }, select: { email: true } });
  const customer = ticket.requester.fullName || ticket.requester.email;
  const subject = `Escalation of #${ticket.number}: ${ticket.subject}`.slice(0, ESCALATION_SUBJECT_MAX);
  const created = await main.ticket.create({
    data: {
      reference: await nextReference(main),
      subject,
      lane: "brand",
      priority: ticket.priority,
      brandId: actor.brandId,
      departmentId,
      requesterId: actor.id,
      requesterBrandId: actor.brandId,
      requesterName: actor.name,
      requesterEmail: admin?.email ?? "",
      source: "app",
      escalatedFromId: ticket.id,
      escalatedFromBrandId: actor.brandId,
    },
  });
  await db.ticket.update({ where: { id: ticket.id }, data: { escalationId: created.id } });

  const note = input.note.trim();
  const body = [
    `Escalated from ${ticket.reference} (#${ticket.number}) — “${ticket.subject}”`,
    `Customer: ${customer} <${ticket.requester.email}>`,
    ...(note ? ["", note] : []),
  ].join("\n");
  await appendMessage(main, {
    ticketId: created.id,
    authorType: "requester",
    authorId: actor.id,
    authorName: actor.name,
    body,
  });
  // And the customer's thread records where it went — for the team only.
  await appendMessage(db, {
    ticketId: ticket.id,
    authorType: "system",
    authorName: "System",
    internal: true,
    body: `${actor.name} escalated this to the platform as ${created.reference}${note ? `: “${note}”` : "."}`,
  });

  const escalation = (
    await attachEscalationPairs([
      await main.ticket.findUniqueOrThrow({ where: { id: created.id }, include: ticketInclude }),
    ])
  )[0];
  void notifyTicketStaff(main, escalation, {
    title: `Escalation · ${escalation.reference}`,
    message: `${cachedBrand(actor.brandId)?.name ?? actor.name}: ${escalation.subject}`,
    templateKey: "ticket_staff_new",
    templateVars: { message_preview: preview(body) },
  });
  return escalation;
}

/* -------------------------------- Rating ---------------------------------- */

export const MIN_STARS = 1;
export const MAX_STARS = 5;

/** 1-2 stars pages the team by email; 3+ is a statistic. Defined once so reporting can't drift. */
export const POOR_RATING_MAX = 2;

/** Only finished work is rateable — scoring an open thread says nothing useful. */
export function isRateable(status: TicketStatus | string): boolean {
  return status === "resolved" || status === "closed";
}

/** Records a rating. Re-rating is allowed while resolved/closed; handlers hear only when the score CHANGES, and a poor score also mails (it's a request for another look). */
export async function rateTicket(
  db: TenantClient,
  ticket: TicketRow,
  stars: number,
  comment: string,
): Promise<TicketRow> {
  if (!isRateable(ticket.status)) {
    throw badRequest("You can rate a request once the team has resolved it.");
  }
  if (!Number.isInteger(stars) || stars < MIN_STARS || stars > MAX_STARS) {
    throw badRequest(`Choose between ${MIN_STARS} and ${MAX_STARS} stars.`);
  }

  const changed = ticket.rating !== stars;
  const updated = withRequester(
    await db.ticket.update({
      where: { id: ticket.id },
      data: { rating: stars, ratingComment: comment.trim().slice(0, 1000), ratedAt: new Date() },
      include: ticketInclude,
    }),
  );

  if (changed) {
    const who = updated.requester.fullName || updated.requester.email;
    void notifyTicketStaff(db, updated, {
      title: `${"★".repeat(stars)}${"☆".repeat(MAX_STARS - stars)} · ${updated.reference}`,
      message: `${who} rated this ${stars}/${MAX_STARS}${
        updated.ratingComment ? `: ${preview(updated.ratingComment, false, 120)}` : ""
      }`,
      ...(stars <= POOR_RATING_MAX
        ? {
            templateKey: "ticket_rated_unhelpful",
            templateVars: {
              stars: `${stars}/${MAX_STARS}`,
              rating_comment: updated.ratingComment || "(no comment left)",
            },
          }
        : {}),
    });
  }

  return { ...updated, escalatedFrom: ticket.escalatedFrom ?? null, escalation: ticket.escalation ?? null };
}

/* ------------------------------ Ticket-level ------------------------------ */

/** Delete a ticket and best-effort remove its files from the bucket. */
export async function deleteTicket(db: TenantClient, id: string): Promise<void> {
  const attachments = await db.ticketAttachment.findMany({
    where: { ticketId: id },
    select: { key: true },
  });
  await db.ticket.delete({ where: { id } });
  // After the row is gone: an orphaned object costs pennies, a failed delete
  // that blocked the admin's action costs them the action.
  for (const a of attachments) void deleteObject(a.key);
}

/** Folds `sourceId` into `targetId` (target's reference survives) and deletes the source. SAME requester only — merging two people's threads would show each the other's messages. */
export async function mergeTickets(
  db: TenantClient,
  targetId: string,
  sourceId: string,
  actor: TicketActor,
): Promise<TicketRow> {
  if (targetId === sourceId) throw badRequest("Pick a different ticket to merge in.");
  // Both reads are scoped: a ticket outside the actor's reach 404s here the same
  // way it does when opened, so a merge can't cross a lane or a tenant.
  const [target, source] = await Promise.all([
    loadTicketForHandler(db, targetId, actor),
    loadTicketForHandler(db, sourceId, actor),
  ]);

  if (target.requesterId !== source.requesterId) {
    throw badRequest("Only tickets from the same requester can be merged.");
  }

  // A finished ticket that swallows a live one is live again — otherwise the
  // requester's open question would sit under a "Resolved" badge.
  const reopen =
    (target.status === "resolved" || target.status === "closed") &&
    (source.status === "open" || source.status === "pending");

  const mergedBy = await db.user.findUnique({
    where: { id: actor.id },
    select: { fullName: true, email: true },
  });

  const merged = await db.$transaction(async (inLane) => {
    const moved = await inLane.ticketMessage.updateMany({
      where: { ticketId: source.id },
      data: { ticketId: target.id },
    });
    // Attachments carry their own ticketId (for per-ticket cleanup), so they
    // have to follow their messages explicitly.
    await inLane.ticketAttachment.updateMany({
      where: { ticketId: source.id },
      data: { ticketId: target.id },
    });
    const note = await inLane.ticketMessage.create({
      data: {
        ticketId: target.id,
        authorType: "system",
        authorName: "System",
        body: `Merged ticket #${source.number} “${source.subject}” into this conversation.`,
      },
      select: { createdAt: true },
    });
    const updated = withRequester(
      await inLane.ticket.update({
        where: { id: target.id },
        data: {
          lastMessageAt: note.createdAt,
          ...(reopen ? { status: "open" as const, closedAt: null } : {}),
        },
        include: ticketInclude,
      }),
    );
    // The source row is about to go, and this is the only record of what it was.
    await inLane.ticketMerge.create({
      data: {
        ticketId: target.id,
        sourceNumber: source.number,
        sourceReference: source.reference,
        sourceSubject: source.subject,
        sourceRequesterName: source.requester.fullName || source.requester.email,
        sourceCreatedAt: source.createdAt,
        messageCount: moved.count,
        mergedById: actor.id,
        mergedByName: mergedBy?.fullName || mergedBy?.email || "",
      },
    });
    // Nothing is left under the source now; the row can go without touching any
    // files (they moved with their messages).
    await inLane.ticket.delete({ where: { id: source.id } });
    return updated;
  });

  publishToAdmins({ type: "ticket", ticketId: target.id });
  publishToUser(target.requesterId, { type: "ticket", ticketId: target.id });
  return { ...merged, escalatedFrom: target.escalatedFrom ?? null, escalation: target.escalation ?? null };
}

export type { TicketStatus, TicketPriority, TicketLane };
