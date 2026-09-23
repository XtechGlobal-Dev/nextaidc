import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden, notImplemented } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { livekitConfigured, mintAccessToken, roomNameFor } from "../services/livekit.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { ticketUpload, storeTicketUpload } from "../middleware/ticketUpload.js";
import {
  departmentTenant,
  laneCopy,
  requesterLane,
  type TicketLane,
} from "../lib/ticketLanes.js";
import {
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_VIDEO_BYTES,
  MESSAGE_TOO_LONG,
} from "../lib/ticketFiles.js";
import { laneDb, type TenantClient } from "../services/tenantDb.js";
import {
  ALLOWED_REACTIONS,
  MAX_STARS,
  MIN_STARS,
  appendMessage,
  attachEscalationPairs,
  deleteMessage,
  editMessage,
  loadTicketForRequester,
  requesterWhere,
  type TicketRequester,
  markThreadRead,
  messageInclude,
  messagePreview,
  nextReference,
  notifyRequester,
  notifyTicketStaff,
  preview,
  publishCallSignal,
  publishThreadChanged,
  publishTyping,
  rateTicket,
  resolveDepartment,
  serializeMessageForRequester,
  serializeTicketForRequester,
  shouldEmailForMessage,
  ticketInclude,
  toggleReaction,
  verifyAttachments,
  type MessageActor,
  withRequester,
} from "../services/tickets.js";
import { cachedBrand } from "../services/brands.js";

// "My requests" for both lanes — lane is decided by role (customer → brand's team,
// brand admin → platform; everyone else 403s). `laneDb` picks the DB (tenant vs Main);
// every read is scoped to requesterId = caller and internal notes are filtered out.

const router = express.Router();

router.use(requireAuth);

/** A burst of new threads is either a mistake or abuse; replies are cheap. */
const createLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "You've opened several requests already. Please continue in an existing one.",
});
const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

/** The lane this caller raises in, and the database that lane lives in —
 *  both resolved once per request. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ticketLane?: TicketLane;
      ticketDb?: TenantClient;
    }
  }
}

// Resolve the lane or 403. Deliberately not an empty list — the 403 is how the UI
// knows to hide the nav item for staff / the platform owner.
async function requireRequesterLane(req: Request, _res: Response, next: NextFunction) {
  const lane = requesterLane(req.user!.role);
  if (!lane) {
    return next(
      forbidden(
        "Your account doesn't raise support requests. Handle the ones you receive from your inbox instead.",
      ),
    );
  }
  try {
    req.ticketLane = lane;
    req.ticketDb = await laneDb(lane, req.user!.brandId);
    next();
  } catch (err) {
    next(err);
  }
}

router.use(requireRequesterLane);

/** The caller as a requester: on the brand lane that reaches the whole brand's requests, not one person's. */
function requesterOf(req: Request): TicketRequester {
  return { id: req.user!.sub, brandId: req.user!.brandId ?? null, lane: req.ticketLane! };
}

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(150),
  size: z.number().int().nonnegative(),
  key: z.string().min(1),
  url: z.string().min(1),
  sig: z.string().min(1),
});

// Lane + heading copy for the client, so it doesn't guess from the role and drift.
router.get("/lane", (req, res) => {
  const lane = req.ticketLane!;
  res.json({ lane, copy: laneCopy(lane) });
});

/** Departments the caller may file into — their lane, their tenant, only the
 *  enabled queues that are offered to requesters at all. */
router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    const departments = await req.ticketDb!.ticketDepartment.findMany({
      where: {
        lane: req.ticketLane!,
        // Queues belong to whoever answers: the brand on support, the platform on brand.
        brandId: departmentTenant(req.ticketLane!, req.user!.brandId),
        enabled: true,
        requesterVisible: true,
      },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true },
    });
    res.json(departments);
  }),
);

/** Limits the composer enforces before a file leaves the browser. */
router.get("/upload-policy", (_req, res) => {
  res.json({
    maxBytes: MAX_ATTACHMENT_BYTES,
    maxVideoBytes: MAX_VIDEO_BYTES,
    maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
    extensions: ALLOWED_EXTENSIONS,
  });
});

router.post(
  "/uploads",
  uploadLimit,
  ticketUpload.single("file"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await storeTicketUpload(req));
  }),
);

/** My requests, newest activity first. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await req.ticketDb!.ticket.findMany({
      where: requesterWhere(requesterOf(req)),
      orderBy: { lastMessageAt: "desc" },
      include: {
        ...ticketInclude,
        messages: {
          where: { internal: false },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            body: true,
            deletedAt: true,
            attachments: { select: { mime: true }, take: 1 },
          },
        },
        // Internal notes are hidden here, so don't count them either.
        _count: { select: { messages: { where: { internal: false } } } },
      },
    });
    res.json(
      (await attachEscalationPairs(rows)).map((t) =>
        serializeTicketForRequester(t, {
          lastMessage: messagePreview(t.messages[0]),
          messageCount: t._count.messages,
        }),
      ),
    );
  }),
);

const createSchema = z.object({
  subject: z.string().trim().min(3, "Give your request a short subject").max(140),
  departmentId: z.string().min(1, "Choose a department"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  message: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG).default(""),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});

router.post(
  "/",
  createLimit,
  asyncHandler(async (req, res) => {
    const lane = req.ticketLane!;
    const db = req.ticketDb!;
    const data = createSchema.parse(req.body);
    // The tenant is the caller's own, never anything they sent: on `support`
    // it decides which team answers, and on `brand` it says who is asking.
    const brandId = req.user!.brandId ?? null;
    const departmentId = await resolveDepartment(db, data.departmentId, {
      lane,
      // The queue belongs to whoever ANSWERS (the platform on the brand lane),
      // while the ticket below is stamped with whoever is ASKING.
      brandId: departmentTenant(lane, brandId),
      requireSelectable: true,
      requireRequesterVisible: true,
    });
    const attachments = verifyAttachments(data.attachments);
    if (!data.message.trim() && attachments.length === 0) {
      throw badRequest("Describe your issue so the team can help.");
    }

    const me = await db.user.findUnique({
      where: { id: req.user!.sub },
      select: { fullName: true, email: true },
    });
    const myName = me?.fullName || me?.email || "Requester";

    const created = await db.ticket.create({
      data: {
        reference: await nextReference(db),
        subject: data.subject,
        lane,
        priority: data.priority,
        brandId,
        departmentId,
        requesterId: req.user!.sub,
        // Who asked, as of now — what the row keeps once the requester's
        // account is no longer reachable from this database.
        requesterBrandId: brandId,
        requesterName: myName,
        requesterEmail: me?.email ?? "",
        source: "app",
      },
    });

    await appendMessage(db, {
      ticketId: created.id,
      authorType: "requester",
      authorId: req.user!.sub,
      authorName: myName,
      body: data.message,
      attachments,
    });

    const ticket = withRequester(
      await db.ticket.findUniqueOrThrow({
        where: { id: created.id },
        include: ticketInclude,
      }),
    );

    // Who raised it reads differently on the two lanes: a customer's team wants
    // the person's name, the platform wants to know which brand is asking.
    const who = lane === "brand" ? (cachedBrand(brandId)?.name ?? myName) : myName;
    void notifyTicketStaff(db, ticket, {
      title: `${lane === "brand" ? "New brand request" : "New ticket"} · ${ticket.reference}`,
      message: `${who}: ${ticket.subject}`,
      templateKey: "ticket_staff_new",
      templateVars: { message_preview: preview(data.message, attachments.length > 0) },
    });
    void notifyRequester(ticket, {
      title: `Request ${ticket.reference} received`,
      message: ticket.subject,
      templateKey: "ticket_created",
      // Confirmation by mail only. The bell belongs to whoever has to answer:
      // ringing it for the person who just filed the request lights their own
      // inbox up — and on the brand lane that bell hangs off the very Support
      // Tickets entry they filed it from.
      inApp: false,
    });

    res.status(201).json(serializeTicketForRequester(ticket));
  }),
);

/** One of my threads. Opening it clears my unread marker. */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));

    const messages = await db.ticketMessage.findMany({
      where: { ticketId: ticket.id, internal: false },
      orderBy: { createdAt: "asc" },
      include: messageInclude,
    });

    // Also stamps `requesterReadAt` and nudges the handler's tab, so their
    // "Seen" tick appears the moment the requester opens the thread.
    await markThreadRead(db, ticket, "requester");

    res.json({
      ticket: serializeTicketForRequester({ ...ticket, unreadForRequester: false }),
      messages: messages.map((m) =>
        serializeMessageForRequester(m, ticket.lane as TicketLane, req.user!.sub),
      ),
    });
  }),
);

const replySchema = z.object({
  body: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG).default(""),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  /** The message being quoted, if this is a reply to one. */
  replyToId: z.string().nullable().optional(),
});

router.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const data = replySchema.parse(req.body);
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));
    if (ticket.status === "closed") {
      throw badRequest("This request is closed. Reopen it to keep the conversation going.");
    }

    const attachments = verifyAttachments(data.attachments);
    const myName = ticket.requester.fullName || ticket.requester.email;
    const message = await appendMessage(db, {
      ticketId: ticket.id,
      authorType: "requester",
      authorId: req.user!.sub,
      authorName: myName,
      body: data.body,
      attachments,
      replyToId: data.replyToId,
    });

    // Whatever it was waiting on, the ball is back with the team: a reply on a
    // "waiting on you" or resolved request reopens it.
    if (ticket.status === "pending" || ticket.status === "resolved") {
      await db.ticket.update({ where: { id: ticket.id }, data: { status: "open" } });
    }

    void notifyTicketStaff(db, ticket, {
      title: `Reply on ${ticket.reference}`,
      message: `${myName}: ${preview(data.body, attachments.length > 0, 120)}`,
      // `ticket` predates appendMessage, so lastMessageAt is the previous activity.
      // Only mail after an hour of quiet; a live conversation is read on screen.
      ...(shouldEmailForMessage(ticket)
        ? {
            templateKey: "ticket_staff_reply",
            templateVars: { message_preview: preview(data.body, attachments.length > 0) },
          }
        : {}),
    });

    res
      .status(201)
      .json(serializeMessageForRequester(message, ticket.lane as TicketLane, req.user!.sub));
  }),
);

/** Close or reopen my own request. */
router.post(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const { status } = z.object({ status: z.enum(["closed", "open"]) }).parse(req.body);
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));

    const updated = withRequester(
      await db.ticket.update({
        where: { id: ticket.id },
        data: { status, closedAt: status === "closed" ? new Date() : null },
        include: ticketInclude,
      }),
    );
    void notifyTicketStaff(db, updated, {
      title: `Request ${updated.reference} ${status === "closed" ? "closed" : "reopened"}`,
      message: updated.subject,
      // A reopen is someone saying "this isn't sorted" — that earns a mail. A
      // requester closing their own request needs no more than the inbox dot.
      ...(status === "open"
        ? {
            templateKey: "ticket_staff_new",
            templateVars: { message_preview: "The requester reopened this request." },
          }
        : {}),
    });
    res.json(
      serializeTicketForRequester({
        ...updated,
        escalatedFrom: ticket.escalatedFrom,
        escalation: ticket.escalation,
      }),
    );
  }),
);

// Acting on an already-sent message. Scoped to my own ticket; the service decides
// whether I may touch that message.

function requesterActor(ticket: { requester: { fullName: string; email: string } }, id: string): MessageActor {
  return {
    key: id,
    type: "requester",
    name: ticket.requester.fullName || ticket.requester.email,
    userId: id,
  };
}

/** Fix a typo in my own message, inside the edit window. */
router.patch(
  "/:id/messages/:messageId",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const { body } = z
      .object({ body: z.string().trim().max(MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG) })
      .parse(req.body);
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));
    const message = await editMessage(
      db,
      ticket.id,
      req.params.messageId,
      requesterActor(ticket, req.user!.sub),
      body,
    );
    publishThreadChanged(ticket, "requester");
    res.json(serializeMessageForRequester(message, ticket.lane as TicketLane, req.user!.sub));
  }),
);

/** Take my own message back. The bubble stays as a tombstone. */
router.delete(
  "/:id/messages/:messageId",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));
    const message = await deleteMessage(
      db,
      ticket.id,
      req.params.messageId,
      requesterActor(ticket, req.user!.sub),
    );
    publishThreadChanged(ticket, "requester");
    res.json(serializeMessageForRequester(message, ticket.lane as TicketLane, req.user!.sub));
  }),
);

/** Toggle one emoji on one message. */
router.post(
  "/:id/messages/:messageId/reactions",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const { emoji } = z.object({ emoji: z.enum(ALLOWED_REACTIONS) }).parse(req.body);
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));
    const message = await toggleReaction(
      db,
      ticket.id,
      req.params.messageId,
      requesterActor(ticket, req.user!.sub),
      emoji,
    );
    publishThreadChanged(ticket, "requester");
    res.json(serializeMessageForRequester(message, ticket.lane as TicketLane, req.user!.sub));
  }),
);

/** Rate the outcome. Only accepted once the work is finished — the service
 *  enforces that, so both lanes and every surface agree on when to ask. */
router.post(
  "/:id/rating",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const data = z
      .object({
        rating: z.coerce.number().int().min(MIN_STARS).max(MAX_STARS),
        comment: z.string().trim().max(1000).default(""),
      })
      .parse(req.body);
    const ticket = await loadTicketForRequester(db, req.params.id, requesterOf(req));
    res.json(serializeTicketForRequester(await rateTicket(db, ticket, data.rating, data.comment)));
  }),
);

/** "…is typing" ping. Writes nothing and expires client-side, so a chatty keyboard costs only a socket write. */
router.post(
  "/:id/typing",
  asyncHandler(async (req, res) => {
    const ticket = await loadTicketForRequester(req.ticketDb!, req.params.id, requesterOf(req));
    publishTyping(ticket, "requester", ticket.requester.fullName || "The requester");
    res.status(204).end();
  }),
);

const callTokenSchema = z.object({ mode: z.enum(["audio", "video"]).default("audio") });

/** A join token for this ticket's call room. Side effects (the "call started" line,
 *  ringing the team) come from LiveKit's webhook once someone actually connects. */
router.post(
  "/:id/call-token",
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    if (!livekitConfigured()) throw notImplemented("Calls aren't set up yet.");
    const { mode } = callTokenSchema.parse(req.body ?? {});
    const ticket = await loadTicketForRequester(req.ticketDb!, req.params.id, requesterOf(req));
    if (ticket.status === "closed") {
      throw badRequest("This request is closed. Reopen it to start a call.");
    }
    const grant = await mintAccessToken({
      roomName: roomNameFor(ticket.lane as TicketLane, ticket.brandId, ticket.id),
      side: "requester",
      userId: req.user!.sub,
      name: ticket.requester.fullName || ticket.requester.email,
      mode,
    });
    res.json({ ...grant, mode });
  }),
);

/** The caller has joined an empty room: ring the team. Live push for whoever is
 *  online, a bell for everyone else. */
router.post(
  "/:id/call/ring",
  asyncHandler(async (req, res) => {
    const { mode } = callTokenSchema.parse(req.body ?? {});
    const ticket = await loadTicketForRequester(req.ticketDb!, req.params.id, requesterOf(req));
    const name = ticket.requester.fullName || ticket.requester.email;
    await publishCallSignal(req.ticketDb!, ticket, "requester", {
      type: "call-invite",
      mode,
      fromName: name,
    });
    await notifyTicketStaff(req.ticketDb!, ticket, {
      title: `Incoming ${mode} call`,
      message: `${name} is calling about "${ticket.subject}".`,
    });
    res.status(204).end();
  }),
);

const callEndSchema = z.object({ reason: z.enum(["hangup", "declined", "missed"]).default("hangup") });

/** Hang-up / decline / no-answer: tells the other side to stop ringing or leave. */
router.post(
  "/:id/call/end",
  asyncHandler(async (req, res) => {
    const { reason } = callEndSchema.parse(req.body ?? {});
    const ticket = await loadTicketForRequester(req.ticketDb!, req.params.id, requesterOf(req));
    await publishCallSignal(req.ticketDb!, ticket, "requester", {
      type: "call-ended",
      reason,
      fromName: ticket.requester.fullName || ticket.requester.email,
    });
    res.status(204).end();
  }),
);

export default router;
