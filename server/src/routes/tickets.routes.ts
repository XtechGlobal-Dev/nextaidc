import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
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
  markThreadRead,
  messageInclude,
  messagePreview,
  nextReference,
  notifyRequester,
  notifyTicketStaff,
  preview,
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

/* ------------------------------------------------------------------ *
 *  The requester's own page — "my requests".
 *
 *  ONE router for both lanes, because which lane you are on is not a
 *  choice you make: it is who you are.
 *
 *    a customer (USER / RESELLER) asks their brand's team    → support
 *    a brand ADMIN asks the platform                          → brand
 *
 *  Nobody else has a tier above them to ask — STAFF take it up with
 *  their own admin, and the platform owner is the top of the ladder —
 *  so for them this whole surface 403s rather than showing an empty
 *  list. See lib/ticketLanes.ts.
 *
 *  Where the thread lives follows the lane (phase 4): a customer's in
 *  their brand's own database, a brand admin's platform request in the
 *  control plane. `laneDb` picks, once per request, and every read below
 *  is scoped to `requesterId = the caller`, so a requester can only ever
 *  reach their own threads; internal handler notes are filtered out of
 *  every one of them.
 * ------------------------------------------------------------------ */

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

/**
 * Resolve the caller's lane, or refuse the surface outright.
 *
 * Deliberately a 403 rather than an empty list: a staff member or the platform
 * owner asking for "my requests" has not hit an empty state, they have hit
 * something that does not apply to them, and saying so is how the UI knows to
 * hide the nav item rather than render a page that can never fill.
 */
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

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(150),
  size: z.number().int().nonnegative(),
  key: z.string().min(1),
  url: z.string().min(1),
  sig: z.string().min(1),
});

/**
 * Who the caller is asking, in the words their own screen should use.
 *
 * The client needs this before it renders a heading: the same page is a
 * customer's "Support" and a brand admin's "Platform Support", and guessing
 * from the role in two places is how the two drift apart.
 */
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
        // Whose queues these are depends on the lane, not just on the caller:
        // a customer picks from their own brand's, a brand admin from the
        // platform's. See departmentTenant.
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
      where: { requesterId: req.user!.sub, lane: req.ticketLane! },
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
        // Internal notes are invisible here, so they must not be counted either
        // — a thread showing "6 messages" of which the requester can see three
        // is worse than no count at all.
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
    });

    res.status(201).json(serializeTicketForRequester(ticket));
  }),
);

/** One of my threads. Opening it clears my unread marker. */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = req.ticketDb!;
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);

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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);
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
      // `ticket` was read BEFORE appendMessage moved lastMessageAt, so it says
      // when the thread last spoke. Mail only once it has been quiet for an
      // hour — a live conversation is read on screen, and the bell rings anyway.
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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);

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

/* --------------------------- Acting on a message -------------------------- *
 *  Replying lives on POST /:id/messages above; these are the things a chat
 *  does to a message that has already been sent. All of them are scoped to my
 *  own ticket, and the service decides whether I may touch that message.
 * ------------------------------------------------------------------------- */

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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);
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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);
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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);
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
    const ticket = await loadTicketForRequester(db, req.params.id, req.user!.sub);
    res.json(serializeTicketForRequester(await rateTicket(db, ticket, data.rating, data.comment)));
  }),
);

/**
 * "…is typing". Deliberately a no-content ping: it writes nothing, publishes a
 * tag to the handler's tabs and expires on its own in the client, so a chatty
 * keyboard can't cost anything but a socket write.
 */
router.post(
  "/:id/typing",
  asyncHandler(async (req, res) => {
    const ticket = await loadTicketForRequester(req.ticketDb!, req.params.id, req.user!.sub);
    publishTyping(ticket, "requester", ticket.requester.fullName || "The requester");
    res.status(204).end();
  }),
);

export default router;
