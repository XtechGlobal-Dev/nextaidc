// Support ticket shapes. Two lanes (support: customer → brand admins; brand: brand admin → platform);
// the API picks the lane from the caller's role, never the client. Mirrors server/src/lib/ticketLanes.ts.

export type TicketLane = "support" | "brand";

/** Where a ticket came from: the requester themselves, or a handler on their
 *  behalf (a phone call, a conversation that started elsewhere). */
export type TicketSource = "app" | "admin";

export type TicketStatus = "open" | "pending" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

/** "system" is the thread's own narration — a merge, a hand-over line. */
export type TicketAuthorType = "requester" | "staff" | "system";

/** Star score, 1-5. Mirrors MIN_STARS / MAX_STARS on the server. */
export const MIN_STARS = 1;
export const MAX_STARS = 5;
/** At or below this, a score is a complaint rather than a statistic. */
export const POOR_RATING_MAX = 2;

/** On-screen names for each side. Served by the API so they can't drift from the emails and
 *  notifications the server writes for the same lane. */
export interface TicketLaneCopy {
  inbox: string;
  requesterPage: string;
  thing: string;
  handlerName: string;
  /** The one name every handler's reply is signed with, in the requester's view. */
  handlerLabel: string;
  requesterName: string;
}

export interface TicketLaneInfo {
  lane: TicketLane;
  copy: TicketLaneCopy;
}

export interface TicketAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

/** The emoji a message may carry — mirrors ALLOWED_REACTIONS on the server. */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "🙏", "✅"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/** One emoji on a message, already grouped by the API. */
export interface TicketReaction {
  emoji: string;
  count: number;
  /** True when the person reading this put it there — the pill reads as pressed. */
  mine: boolean;
  names: string[];
}

/** The thin snapshot of a quoted message shown above a reply. */
export interface TicketReplyRef {
  id: string;
  authorType: TicketAuthorType;
  authorName: string;
  body: string;
  deleted: boolean;
  internal: boolean;
  attachmentKind: "image" | "file" | null;
}

export interface TicketMessage {
  id: string;
  authorType: TicketAuthorType;
  /** Null for a handler in the requester's view — they see one team, not a rota. */
  authorId?: string | null;
  authorName: string;
  body: string;
  /** Handler-only note. Never present in a requester-facing response. */
  internal: boolean;
  createdAt: string;
  /** Set once the author corrected it — drives the "(edited)" mark. */
  editedAt?: string | null;
  /** Taken back by its author (or a moderator). Renders as a tombstone. */
  deleted?: boolean;
  replyTo?: TicketReplyRef | null;
  attachments: TicketAttachment[];
  reactions?: TicketReaction[];
  /** Client-only, never from the API: an optimistic bubble not yet acked, or a failed send that can retry. */
  pending?: boolean;
  failed?: boolean;
}

export interface TicketDepartment {
  id: string;
  name: string;
  description: string;
}

/** One staff member working a department, as the handler's list returns them. */
export interface TicketDepartmentMember {
  id: string;
  name: string;
  email: string;
}

/** The handler's view of a department — adds the switches only an admin flips. */
export interface AdminTicketDepartment extends TicketDepartment {
  lane: TicketLane;
  requesterVisible: boolean;
  enabled: boolean;
  order: number;
  ticketCount: number;
  /** Roles that grant this queue to every one of their members. */
  roleCount: number;
  /** Staff granted this queue personally (not via their role). */
  staffCount: number;
  staff: TicketDepartmentMember[];
  /** Whether the caller works this queue. Only meaningful under `scope: "all"`, where the reassign
   *  picker shows queues you can route to but not work. */
  mine: boolean;
}

export interface Ticket {
  id: string;
  /** Running number in the order tickets were opened — "#42". */
  number: number;
  reference: string;
  subject: string;
  lane: TicketLane;
  status: TicketStatus;
  priority: TicketPriority;
  source: TicketSource;
  department: { id: string; name: string } | null;
  requester: { id: string; name: string; email: string; role: string };
  /** Tenant the request came from — travels with the ticket because the platform inbox needs it
   *  first. Null for a platform-level account. */
  brand: { id: string; name: string; slug: string } | null;
  /** Who took the ticket, or null. On the REQUESTER's copy `id` is null and `name` is the team label —
   *  nothing to pair back to an account. Handlers get the real id/name. */
  assignedTo: { id: string | null; name: string } | null;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
  unreadForStaff: boolean;
  unreadForRequester: boolean;
  /** When each side last opened the thread — what the "Seen" tick reads from. */
  staffReadAt?: string | null;
  requesterReadAt?: string | null;
  /** 1-5 stars, or null when unrated — which is not the same as a zero. */
  rating: number | null;
  ratingComment: string;
  ratedAt: string | null;
  /** Whether it is far enough along to be rated. Computed server-side so every
   *  surface agrees on when to ask. */
  rateable: boolean;
  /** Escalation pair. Platform copy: the customer ticket it came from. Customer ticket: the platform
   *  ticket it went up as — handlers only, never in the customer's own view. */
  escalatedFrom?: {
    id: string;
    number: number;
    reference: string;
    subject: string;
    status: TicketStatus;
    requesterName: string;
  } | null;
  escalation?: { id: string; reference: string; status: TicketStatus } | null;
  /** List responses only — preview of the newest message. */
  lastMessage?: string;
  messageCount?: number;
}

/** What the platform sets on a brand's department. Who WORKS it is the brand's
 *  own call, made from their inbox. */
export interface BrandTicketDepartmentInput {
  name: string;
  description?: string;
  requesterVisible?: boolean;
  enabled?: boolean;
  order?: number;
}

/** Just-updated ticket. `handedOff` = the change routed it out of the caller's reach, so the pane
 *  must close rather than re-fetch a 404. */
export interface UpdatedTicket extends Ticket {
  handedOff?: boolean;
}

/** A ticket that was merged into the one being read. The original is gone (its
 *  messages now sit in this thread), so this is a snapshot of what it was. */
export interface TicketMergeRecord {
  id: string;
  number: number;
  reference: string;
  subject: string;
  requesterName: string;
  createdAt: string;
  messageCount: number;
  mergedBy: string;
  mergedAt: string;
}

export interface TicketThread {
  ticket: Ticket;
  messages: TicketMessage[];
  /** Handler view only — the requester's thread doesn't carry it. */
  merges?: TicketMergeRecord[];
}

/** Uploaded-but-unsent file, replayed verbatim on send. `sig` proves the client didn't invent the S3
 *  key — pass it through untouched. */
export interface AttachmentDescriptor {
  name: string;
  mime: string;
  size: number;
  key: string;
  url: string;
  sig: string;
}

export interface TicketUploadPolicy {
  maxBytes: number;
  maxVideoBytes: number;
  maxFiles: number;
  extensions: string[];
}

export interface TicketStats {
  open: number;
  pending: number;
  resolved: number;
  closed: number;
  total: number;
  unread: number;
  assignedToMe: number;
  /** Open or waiting tickets nobody has taken yet. */
  unassigned: number;
  /** "all" for a full admin, otherwise how many queues the role holds. */
  departments: number | "all";
  csat: { average: number | null; count: number };
  /** Mean wait for the first handler reply: tickets opened in the last 30 days,
   *  and in the 30 days before that (null where there were none). */
  firstResponse: { avgSeconds: number | null; prevAvgSeconds: number | null };
}

/** A canned answer a handler can drop into the composer. */
export interface TicketSavedReply {
  id: string;
  title: string;
  /** May carry blanks like {{customer_name}} — filled in when inserted. */
  body: string;
  /** Null = offered on every queue in this lane. */
  department: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Whether the caller may change or remove it. */
  canEdit: boolean;
}

export interface TicketListPage {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TicketAgent {
  id: string;
  name: string;
  role: string;
  /** The queues this person works. Empty for a full admin, who works them all —
   *  check `role` first. */
  departments: { id: string; name: string }[];
}

export interface TicketRatingDepartment {
  id: string | null;
  name: string;
  rated: number;
  average: number | null;
}

export interface TicketRatingSummary {
  rated: number;
  average: number | null;
  poor: number;
  /** How many tickets landed on each score, keyed 1-5. */
  distribution: Record<number, number>;
  byDepartment: TicketRatingDepartment[];
}

export interface TicketRatingsPage {
  ratings: Ticket[];
  total: number;
  page: number;
  pageSize: number;
  summary: TicketRatingSummary | null;
}
