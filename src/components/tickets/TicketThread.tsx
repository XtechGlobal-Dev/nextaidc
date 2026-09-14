import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  Check,
  CheckCheck,
  Copy,
  CornerUpLeft,
  Download,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Lock,
  MessageSquare,
  MoreVertical,
  Pencil,
  Presentation,
  RotateCw,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ImageLightbox } from "@/components/tickets/ImageLightbox";
import { ticketInitials } from "@/components/tickets/ticketUi";
import { REACTION_EMOJI, type TicketAttachment, type TicketMessage } from "@/types/ticket";
import { fileKind, formatBytes } from "@/lib/ticketFiles";

// Ticket conversation shared by every surface. `perspective` only decides which side is "mine".
// Handlers the page leaves out simply don't appear.

const KIND_ICON = {
  image: ImageIcon,
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  media: Film,
  text: FileText,
} as const;

/** Messages this close together, from the same author, are drawn as one run. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** How far from the bottom still counts as "reading the newest". */
const STICK_TO_BOTTOM_PX = 120;

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* ------------------------------ Message text ------------------------------ */

const URL_SOURCE = "(?:https?://[^\\s<]+[^\\s<.,:;\"')\\]}]|www\\.[^\\s<]+[^\\s<.,:;\"')\\]}])";
// Two regexes on purpose: a /g regex carries `lastIndex` between calls, so testing with the splitter would skip every other link.
const URL_SPLIT = new RegExp(`(${URL_SOURCE})`, "gi");
const URL_MATCH = new RegExp(`^${URL_SOURCE}$`, "i");

/** Linkified message text. Split on a URL pattern, never injected as HTML: the body is untrusted input. */
function MessageText({ body }: { body: string }) {
  const parts = useMemo(() => body.split(URL_SPLIT), [body]);
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        URL_MATCH.test(part) ? (
          <a
            key={i}
            href={part.startsWith("www.") ? `https://${part}` : part}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline underline-offset-2"
            onClick={(e) => e.stopPropagation()}
          >
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

/* ------------------------------ Attachments ------------------------------- */

function AttachmentCard({ attachment, mine }: { attachment: TicketAttachment; mine: boolean }) {
  const kind = fileKind(attachment.mime, attachment.name);
  const Icon = KIND_ICON[kind];
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      download={attachment.name}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
        mine
          ? "border-primary/20 bg-card/70 hover:bg-card"
          : "border-border bg-background hover:bg-muted",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded",
          mine ? "bg-primary/10" : "bg-muted",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{attachment.name}</span>
        <span className="block text-[11px] text-muted-foreground">
          {formatBytes(attachment.size)}
        </span>
      </span>
      <Download className="size-3.5 shrink-0 opacity-70" />
    </a>
  );
}

function Attachments({
  attachments,
  mine,
  onOpenImage,
}: {
  attachments: TicketAttachment[];
  mine: boolean;
  onOpenImage: (attachment: TicketAttachment) => void;
}) {
  const images = attachments.filter((a) => a.mime.startsWith("image/"));
  const files = attachments.filter((a) => !a.mime.startsWith("image/"));

  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className={cn("grid gap-1.5", images.length > 1 && "grid-cols-2")}>
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpenImage(a)}
              className="block overflow-hidden rounded-lg border border-border bg-background"
              title={a.name}
            >
              <img
                src={a.url}
                alt={a.name}
                loading="lazy"
                className={cn(
                  "w-full object-cover transition-transform hover:scale-[1.02]",
                  images.length > 1 ? "h-32" : "max-h-64",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        <AttachmentCard key={a.id} attachment={a} mine={mine} />
      ))}
    </div>
  );
}

/* -------------------------------- Quote ---------------------------------- */

const QUOTE_KIND_LABEL = { image: "Photo", file: "Attachment" } as const;

function QuotedMessage({
  message,
  onJump,
}: {
  message: NonNullable<TicketMessage["replyTo"]>;
  onJump: () => void;
}) {
  const label = message.deleted
    ? "Message deleted"
    : message.body ||
      (message.attachmentKind ? QUOTE_KIND_LABEL[message.attachmentKind] : "Message");

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
      className="flex w-full gap-2 rounded-md border-l-[3px] border-l-primary bg-muted/70 px-2 py-1 text-left transition-colors hover:bg-muted"
      title="Go to the message this replies to"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-primary">
          {message.authorName}
          {message.internal && " · internal note"}
        </span>
        <span
          className={cn(
            "flex items-center gap-1 truncate text-[11px] text-muted-foreground",
            message.deleted && "italic",
          )}
        >
          {!message.deleted && message.attachmentKind === "image" && (
            <ImageIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">{label}</span>
        </span>
      </span>
    </button>
  );
}

/* ------------------------------- Reactions -------------------------------- */

function Reactions({
  message,
  mine,
  onReact,
}: {
  message: TicketMessage;
  mine: boolean;
  onReact?: (emoji: string) => void;
}) {
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return null;
  return (
    <div className={cn("-mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={!onReact}
          onClick={() => onReact?.(r.emoji)}
          title={r.names.join(", ")}
          className={cn(
            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors",
            r.mine
              ? "border-primary bg-primary-tint text-primary"
              : "border-border bg-background text-muted-foreground hover:bg-muted",
            !onReact && "cursor-default",
          )}
          aria-pressed={r.mine}
        >
          <span className="text-xs">{r.emoji}</span>
          <span className="font-medium tabular-nums">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

/* ----------------------------- Message actions ---------------------------- */

interface ActionsProps {
  message: TicketMessage;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  onStartEdit?: () => void;
  onDelete?: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

function MessageActions({
  message,
  mine,
  canEdit,
  canDelete,
  onReply,
  onReact,
  onStartEdit,
  onDelete,
  menuOpen,
  onMenuOpenChange,
}: ActionsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasText = message.body.trim().length > 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.body);
      toast.success("Message copied");
    } catch {
      toast.error("Couldn't copy that message");
    }
  }

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 self-center transition-opacity",
        // Reachable on touch, quiet on desktop until the row is hovered.
        "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
        (menuOpen || pickerOpen) && "md:opacity-100",
        mine ? "order-first" : "order-last",
      )}
    >
      {onReact && (
        <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="React to this message"
            >
              <SmilePlus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mine ? "end" : "start"} className="flex min-w-0 gap-0.5 p-1">
            {REACTION_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onReact(emoji);
                  setPickerOpen(false);
                }}
                className="grid size-8 place-items-center rounded-md text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {onReply && (
        <button
          type="button"
          onClick={onReply}
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Reply to this message"
          title="Reply"
        >
          <CornerUpLeft className="size-4" />
        </button>
      )}

      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="More options"
          >
            <MoreVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={mine ? "end" : "start"} className="min-w-[10rem]">
          {onReply && (
            <DropdownMenuItem onSelect={onReply}>
              <CornerUpLeft /> Reply
            </DropdownMenuItem>
          )}
          {hasText && (
            <DropdownMenuItem onSelect={() => void copy()}>
              <Copy /> Copy text
            </DropdownMenuItem>
          )}
          {message.attachments.length > 0 && (
            <DropdownMenuItem
              onSelect={() => {
                for (const a of message.attachments) window.open(a.url, "_blank", "noreferrer");
              }}
            >
              <Download />
              {message.attachments.length === 1 ? "Open attachment" : "Open attachments"}
            </DropdownMenuItem>
          )}
          {canEdit && onStartEdit && (
            <DropdownMenuItem onSelect={onStartEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
          )}
          {canDelete && onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDelete}
                className="text-danger focus:bg-danger-tint focus:text-danger"
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* -------------------------------- Thread ---------------------------------- */

export interface TicketThreadProps {
  messages: TicketMessage[];
  /** Whose side of the conversation this is being read from. */
  perspective: "staff" | "requester";
  loading?: boolean;
  className?: string;
  emptyHint?: string;
  /** When the other side last opened the thread; anything I sent before it gets the second tick. */
  otherReadAt?: string | null;
  /** e.g. "Support is typing…" — shown as a bubble at the foot of the thread. */
  typingLabel?: string | null;
  /** My user id. Several handlers share "mine", so authorship of a specific
   *  message (what edit and delete allow) needs the id. */
  meId?: string | null;
  /** A handler holding `*.delete` may remove anyone's message. */
  canModerate?: boolean;
  /** How long after sending a message may still be edited. */
  editWindowMs?: number;
  onReply?: (message: TicketMessage) => void;
  /** Asks the page to edit this message — the text goes into the composer. */
  onEdit?: (message: TicketMessage) => void;
  onDelete?: (message: TicketMessage) => Promise<void>;
  onReact?: (message: TicketMessage, emoji: string) => Promise<void>;
  /** Re-send a bubble whose send failed. */
  onRetry?: (message: TicketMessage) => void;
  /** Drop a failed bubble without sending it. */
  onDiscard?: (message: TicketMessage) => void;
}

export function TicketThread({
  messages,
  perspective,
  loading = false,
  className,
  emptyHint = "No messages yet.",
  otherReadAt,
  typingLabel,
  meId,
  canModerate = false,
  editWindowMs = 15 * 60 * 1000,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onRetry,
  onDiscard,
}: TicketThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the reader is parked at the newest message. Kept in a ref because
   *  the scroll effect has to read it without re-subscribing on every scroll. */
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lastId = messages[messages.length - 1]?.id;

  /** Every image in the thread, in order — what the lightbox steps through. */
  const images = useMemo(
    () => messages.flatMap((m) => m.attachments.filter((a) => a.mime.startsWith("image/"))),
    [messages],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setUnseenCount(0);
    setShowJump(false);
  }, []);

  // Track where the reader is. Someone who scrolled up to re-read something must
  // not be yanked back down every time a message lands.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= STICK_TO_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
    if (atBottom) setUnseenCount(0);
  }, []);

  // Stick to the newest only if already there. Count the delta so a burst of messages keeps the pill honest.
  const seenCount = useRef(messages.length);
  useEffect(() => {
    const arrived = messages.length - seenCount.current;
    seenCount.current = messages.length;
    if (!lastId) return;
    if (atBottomRef.current) scrollToBottom();
    else if (arrived > 0) setUnseenCount((n) => n + arrived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, messages.length]);

  // A freshly opened thread always starts at the bottom.
  useEffect(() => {
    if (loading) return;
    atBottomRef.current = true;
    scrollToBottom();
  }, [loading, scrollToBottom]);

  // Stay pinned while images load: each one grows to its real height and pushes the newest message down,
  // leaving you a few hundred pixels short without this.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    // The scroller's own box doesn't change; its content's does.
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [loading, lastId]);

  /** Walk back to a quoted message and flash it, so "reply to" is navigable. */
  const jumpTo = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`,
    );
    if (!el) {
      toast.info("That message isn't in view any more.");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlighted(id);
    window.setTimeout(() => setHighlighted((current) => (current === id ? null : current)), 1800);
  }, []);

  if (loading) {
    return (
      <div className={cn("space-y-4 overflow-y-auto p-4", className)}>
        <Skeleton className="h-16 w-2/3 rounded-2xl" />
        <Skeleton className="ml-auto h-20 w-3/5 rounded-2xl" />
        <Skeleton className="h-14 w-1/2 rounded-2xl" />
      </div>
    );
  }

  if (messages.length === 0 && !typingLabel) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 p-8 text-center",
          className,
        )}
      >
        <MessageSquare className="size-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  // The newest thing I said — the only bubble that carries a delivery mark, the
  // way every chat app does it (one mark at the end of your own run, not twenty).
  const myLast = [...messages]
    .reverse()
    .find(
      (m) =>
        !m.internal &&
        // A tombstone saying "seen" is noise: the point of the mark is whether
        // what you said reached them, and a deleted message no longer says it.
        !m.deleted &&
        m.authorType === (perspective === "staff" ? "staff" : "requester"),
    );

  let lastDay = "";

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="ticket-wallpaper min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {messages.map((m, index) => {
          const day = dayLabel(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;

          if (m.authorType === "system") {
            return (
              <Fragment key={m.id}>
                {showDay && <DaySeparator label={day} />}
                <p className="py-2 text-center text-xs text-muted-foreground">{m.body}</p>
              </Fragment>
            );
          }

          const mine =
            perspective === "staff" ? m.authorType === "staff" : m.authorType === "requester";

          // A run of messages from the same person, close together, is drawn as
          // one block: the name is said once and the avatar sits at its foot.
          const previous = messages[index - 1];
          const next = messages[index + 1];
          const runWith = (other?: TicketMessage) =>
            !!other &&
            other.authorType === m.authorType &&
            other.authorName === m.authorName &&
            other.internal === m.internal &&
            Math.abs(new Date(other.createdAt).getTime() - new Date(m.createdAt).getTime()) <
              GROUP_WINDOW_MS;
          const startsRun = showDay || !runWith(previous);
          const endsRun = !runWith(next);

          const isAuthor = mine && (!m.authorId || !meId || m.authorId === meId);
          const withinEditWindow = Date.now() - new Date(m.createdAt).getTime() < editWindowMs;
          const canEditThis = !!onEdit && isAuthor && !m.deleted && !m.pending && withinEditWindow;
          // Own messages are always deletable; a moderator may pull anyone's (a card number in the thread must be removable).
          const canDeleteThis =
            !!onDelete && !m.deleted && !m.pending && (isAuthor || canModerate);

          return (
            <Fragment key={m.id}>
              {showDay && <DaySeparator label={day} />}
              <MessageRow
                message={m}
                mine={mine}
                startsRun={startsRun}
                endsRun={endsRun}
                highlighted={highlighted === m.id}
                onStartEdit={canEditThis && onEdit ? () => onEdit(m) : undefined}
                onDelete={canDeleteThis ? () => void onDelete?.(m) : undefined}
                onReply={onReply && !m.deleted && !m.pending ? () => onReply(m) : undefined}
                onReact={
                  onReact && !m.deleted && !m.pending ? (e) => void onReact(m, e) : undefined
                }
                onJumpToQuoted={jumpTo}
                onOpenImage={(attachment) => {
                  const at = images.findIndex((i) => i.id === attachment.id);
                  setLightboxIndex(at >= 0 ? at : null);
                }}
                menuOpen={menuFor === m.id}
                onMenuOpenChange={(open) => setMenuFor(open ? m.id : null)}
                canEdit={canEditThis}
                canDelete={canDeleteThis}
                onRetry={onRetry ? () => onRetry(m) : undefined}
                onDiscard={onDiscard ? () => onDiscard(m) : undefined}
                deliveryMark={m.id === myLast?.id ? deliveryState(m, otherReadAt ?? null) : null}
              />
            </Fragment>
          );
        })}

        {typingLabel && <TypingBubble label={typingLabel} />}
      </div>

      {/* Back to the newest — with a count when things arrived while away. */}
      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-foreground px-3 py-2 text-xs font-medium text-background shadow-lg transition-transform hover:scale-105"
        >
          <ArrowDown className="size-3.5" />
          {unseenCount > 0
            ? `${unseenCount} new message${unseenCount === 1 ? "" : "s"}`
            : "Latest"}
        </button>
      )}

      <ImageLightbox
        items={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  );
}

/* ------------------------------- One bubble ------------------------------- */

type DeliveryState = "sending" | "failed" | "sent" | "seen";

function deliveryState(m: TicketMessage, otherReadAt: string | null): DeliveryState {
  if (m.pending) return "sending";
  if (m.failed) return "failed";
  if (otherReadAt && new Date(otherReadAt).getTime() >= new Date(m.createdAt).getTime()) {
    return "seen";
  }
  return "sent";
}

interface MessageRowProps {
  message: TicketMessage;
  mine: boolean;
  startsRun: boolean;
  endsRun: boolean;
  highlighted: boolean;
  onStartEdit?: () => void;
  onDelete?: () => void;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  onJumpToQuoted: (id: string) => void;
  onOpenImage: (attachment: TicketAttachment) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canDelete: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  deliveryMark: DeliveryState | null;
}

function MessageRow({
  message: m,
  mine,
  startsRun,
  endsRun,
  highlighted,
  onStartEdit,
  onDelete,
  onReply,
  onReact,
  onJumpToQuoted,
  onOpenImage,
  menuOpen,
  onMenuOpenChange,
  canEdit,
  canDelete,
  onRetry,
  onDiscard,
  deliveryMark,
}: MessageRowProps) {
  return (
    <div
      data-message-id={m.id}
      className={cn(
        "group relative flex gap-2 py-0.5",
        startsRun && "pt-2",
        endsRun && "pb-1.5",
        mine ? "justify-end" : "justify-start",
      )}
    >
      {!mine && (
        <span
          className={cn(
            "mt-auto grid size-8 shrink-0 place-items-center rounded-full bg-primary-tint text-[11px] font-semibold text-primary",
            !endsRun && "invisible",
          )}
          title={m.authorName}
        >
          {ticketInitials(m.authorName)}
        </span>
      )}

      <div className="min-w-0 max-w-[85%] space-y-1">
        {!mine && startsRun && (
          <p className="px-1 text-[11px] font-medium text-muted-foreground">{m.authorName}</p>
        )}

        {/* Actions sit outside the bubble via ordering, not a reversed row (which would also flip the bubble). */}
        <div className="flex items-end gap-1">
          {!m.deleted && (
            <MessageActions
              message={m}
              mine={mine}
              canEdit={canEdit}
              canDelete={canDelete}
              onReply={onReply}
              onReact={onReact}
              onStartEdit={onStartEdit}
              onDelete={onDelete}
              menuOpen={menuOpen}
              onMenuOpenChange={onMenuOpenChange}
            />
          )}

          <div
            className={cn(
              "min-w-0 max-w-[30rem] space-y-2 rounded-2xl px-3 py-2 text-sm shadow-sm transition-shadow",
              m.deleted
                ? "border border-dashed border-border bg-background text-muted-foreground"
                : m.internal
                  ? "border border-warning/50 bg-warning-tint text-foreground"
                  : mine
                    ? "bg-primary-tint text-foreground"
                    : "border border-border bg-background",
              endsRun && !m.deleted && (mine ? "rounded-br-sm" : "rounded-bl-sm"),
              m.pending && "opacity-70",
              m.failed && "border border-danger/60",
              highlighted && "ring-2 ring-primary ring-offset-2",
            )}
          >
            {m.internal && !m.deleted && (
              <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-warning">
                <Lock className="size-3" /> Internal note
              </p>
            )}

            {m.replyTo && (
              <QuotedMessage message={m.replyTo} onJump={() => onJumpToQuoted(m.replyTo!.id)} />
            )}

            {m.deleted ? (
              <p className="flex items-center gap-1.5 italic">
                <X className="size-3.5" /> This message was deleted
              </p>
            ) : (
              <>
                {/* Attachment first, text under it as the caption, like every chat app. */}
                {m.attachments.length > 0 && (
                  <Attachments
                    attachments={m.attachments}
                    mine={mine && !m.internal}
                    onOpenImage={onOpenImage}
                  />
                )}
                {m.body && <MessageText body={m.body} />}
              </>
            )}

            <p
              className={cn(
                "flex items-center justify-end gap-1 text-[10px] leading-none",
                m.deleted
                  ? "text-muted-foreground"
                  : m.internal
                    ? "text-warning"
                    : mine
                      ? "text-primary/70"
                      : "text-muted-foreground",
              )}
            >
              {m.editedAt && !m.deleted && <span className="italic">edited</span>}
              <span>{timeLabel(m.createdAt)}</span>
              {/* One mark, on the newest thing you said — titled, because a tick
                  is only obvious once you already know what it means. */}
              {deliveryMark === "sending" && (
                <Loader2 className="size-3 animate-spin" aria-label="Sending" />
              )}
              {deliveryMark === "sent" && (
                <span title="Sent" className="inline-flex">
                  <Check className="size-3" aria-label="Sent" />
                </span>
              )}
              {deliveryMark === "seen" && (
                <span title="Seen" className="inline-flex">
                  <CheckCheck className="size-3" aria-label="Seen" />
                </span>
              )}
              {deliveryMark === "failed" && (
                <AlertCircle className="size-3 text-danger" aria-label="Not sent" />
              )}
            </p>
          </div>
        </div>

        <Reactions message={m} mine={mine} onReact={onReact} />

        {m.failed && (
          <p
            className={cn(
              "flex items-center gap-2 px-1 text-[11px] text-danger",
              mine ? "justify-end" : "justify-start",
            )}
          >
            Not sent.
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 font-medium underline"
              >
                <RotateCw className="size-3" /> Retry
              </button>
            )}
            {onDiscard && (
              <button type="button" onClick={onDiscard} className="underline">
                Discard
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function TypingBubble({ label }: { label: string }) {
  return (
    <div className="flex items-end gap-2 py-1.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-tint text-primary">
        <MessageSquare className="size-3.5" />
      </span>
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-background px-3 py-2.5">
        <span className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
