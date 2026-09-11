import { useCallback, useRef, useState } from "react";
import { uid } from "@/lib/utils";
import type {
  AttachmentDescriptor,
  TicketAttachment,
  TicketMessage,
  TicketReplyRef,
} from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Optimistic sending, shared by every ticket surface.
 *
 *  A message appears in the conversation the moment you press send,
 *  carrying a clock until the server confirms it — which is what makes
 *  a chat feel like a chat rather than a form. If the send fails the
 *  bubble stays put and turns red with a Retry, instead of the text
 *  being thrown back into the box for you to type again.
 *
 *  The files are already in the bucket by then (the composer uploads
 *  while you type), so a retry re-posts the same descriptors and costs
 *  nothing extra.
 * ------------------------------------------------------------------ */

export interface OutboxDraft {
  /**
   * The thread this was written in, captured at submit time. A reply must land
   * where it was typed even if the reader has opened another ticket since — and
   * a retry, minutes later, must still go to the right conversation.
   */
  ticketId: string;
  body: string;
  attachments: AttachmentDescriptor[];
  replyToId: string | null;
  /** Handler side only — a note the requester never sees. */
  internal?: boolean;
  /** The message being quoted, so the pending bubble can draw its quote. */
  replyTo?: TicketMessage | null;
}

interface OutboxItem {
  key: string;
  draft: OutboxDraft;
  message: TicketMessage;
}

/** What a just-uploaded file looks like on the pending bubble. The URL is the
 *  real one — the bytes landed before the message was sent — so images render
 *  immediately rather than after a round trip. */
function localAttachment(d: AttachmentDescriptor): TicketAttachment {
  return {
    id: uid("pending-att"),
    name: d.name,
    mime: d.mime,
    size: d.size,
    url: d.url,
    createdAt: new Date().toISOString(),
  };
}

function localReplyRef(m: TicketMessage): TicketReplyRef {
  const attachment = m.attachments[0];
  return {
    id: m.id,
    authorType: m.authorType,
    authorName: m.authorName,
    body: m.body.slice(0, 140),
    deleted: false,
    internal: m.internal,
    attachmentKind: !attachment ? null : attachment.mime.startsWith("image/") ? "image" : "file",
  };
}

export interface UseOutboxOptions {
  /** Post the message. Resolve with what the server stored. */
  send: (draft: OutboxDraft) => Promise<TicketMessage>;
  /** Called with the confirmed message (and the draft it came from, which still
   *  carries the ticket it was written in), so the page can append it. */
  onSent: (message: TicketMessage, draft: OutboxDraft) => void;
  /** Which side the pending bubble sits on. */
  authorType: "requester" | "staff";
  /** Name on the pending bubble. Only ever seen by the person who sent it. */
  authorName: string;
}

export interface Outbox {
  /** Pending and failed bubbles, to append after the server's messages. */
  messages: TicketMessage[];
  submit: (draft: OutboxDraft) => Promise<void>;
  retry: (message: TicketMessage) => void;
  discard: (message: TicketMessage) => void;
}

export function useOutbox({ send, onSent, authorType, authorName }: UseOutboxOptions): Outbox {
  const [items, setItems] = useState<OutboxItem[]>([]);
  // The handlers are recreated on every render of the page; keeping them in a
  // ref means `submit` stays stable and the composer isn't re-rendered for it.
  const handlers = useRef({ send, onSent });
  handlers.current = { send, onSent };

  const post = useCallback(async (item: OutboxItem) => {
    setItems((prev) =>
      prev.map((i) =>
        i.key === item.key ? { ...i, message: { ...i.message, pending: true, failed: false } } : i,
      ),
    );
    try {
      const message = await handlers.current.send(item.draft);
      // Drop the placeholder and hand the real message to the page in one go,
      // so the bubble is never on screen twice.
      setItems((prev) => prev.filter((i) => i.key !== item.key));
      handlers.current.onSent(message, item.draft);
    } catch {
      setItems((prev) =>
        prev.map((i) =>
          i.key === item.key
            ? { ...i, message: { ...i.message, pending: false, failed: true } }
            : i,
        ),
      );
    }
  }, []);

  const submit = useCallback(
    async (draft: OutboxDraft) => {
      const key = uid("outbox");
      const item: OutboxItem = {
        key,
        draft,
        message: {
          id: key,
          authorType,
          authorName,
          body: draft.body,
          internal: draft.internal ?? false,
          createdAt: new Date().toISOString(),
          replyTo: draft.replyTo ? localReplyRef(draft.replyTo) : null,
          attachments: draft.attachments.map(localAttachment),
          reactions: [],
          pending: true,
        },
      };
      setItems((prev) => [...prev, item]);
      // Not awaited: the composer clears the moment the bubble is on screen, and
      // a failure lands on the bubble (retry / discard), never back in the box.
      void post(item);
    },
    [authorName, authorType, post],
  );

  const retry = useCallback(
    (message: TicketMessage) => {
      const item = items.find((i) => i.key === message.id);
      if (item) void post(item);
    },
    [items, post],
  );

  const discard = useCallback((message: TicketMessage) => {
    setItems((prev) => prev.filter((i) => i.key !== message.id));
  }, []);

  return { messages: items.map((i) => i.message), submit, retry, discard };
}
