import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  FileText,
  LifeBuoy,
  Loader2,
  Lock,
  MoreVertical,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatComposer } from "@/components/tickets/ChatComposer";
import { CallChatSlot } from "@/components/tickets/CallChatSlot";
import { TicketThread } from "@/components/tickets/TicketThread";
import { TicketRatingDialog } from "@/components/tickets/TicketRatingDialog";
import { TicketCallControls } from "@/components/tickets/TicketCallControls";
import { useCallStore } from "@/stores/useCallStore";
import type { CallMode } from "@/lib/livekit";
import { StarRating } from "@/components/tickets/StarRating";
import { MailEmptyIllustration } from "@/components/tickets/TicketIllustrations";
import {
  MenuOption,
  NewMessageDot,
  STATUS_WASH,
  TicketAvatar,
  TicketPriorityBadge,
  TicketStatusBadge,
  TicketStatusDot,
  TicketTile,
} from "@/components/tickets/ticketUi";
import { useOutbox } from "@/components/tickets/useOutbox";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { expectedLaneInfo, expectedRequesterLane, sameLaneInfo } from "@/types/ticket";
import { useLiveTick, useTypingIndicator } from "@/hooks/useLiveData";
import { useActiveTicketThread } from "@/hooks/useActiveTicketThread";
import { formatBytes } from "@/lib/ticketFiles";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import type {
  AttachmentDescriptor,
  Ticket,
  TicketDepartment,
  TicketLaneInfo,
  TicketMessage,
  TicketPriority,
} from "@/types/ticket";

// "My requests" — one page for both lanes (customer → brand team, brand admin → platform). /lane supplies the
// lane + its wording so it can't drift from the server's emails. Deep links: ?ticket=<id>, ?rate=1.

/** How many files the attachments card shows before "See all". */
const ATTACHMENTS_PREVIEW = 2;

/** The quick filters above the list. "Resolved" folds resolved and closed
 *  together — to a requester those are the same thing. */
const LIST_FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "pending", label: "Awaiting your reply" },
  { key: "done", label: "Resolved" },
] as const;
type ListFilter = (typeof LIST_FILTERS)[number]["key"];

function matchesFilter(t: Ticket, f: ListFilter): boolean {
  if (f === "all") return true;
  if (f === "done") return t.status === "resolved" || t.status === "closed";
  return t.status === f;
}

/** One labelled, read-only field in the details card — the same shape as the handlers' editable ones,
 *  so the two views of a request line up. */
function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex h-9 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium">
        {children}
      </div>
    </div>
  );
}

export default function SupportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("ticket");
  // The open conversation counts as seen: its notifications are read, not toasted.
  useActiveTicketThread(selectedId);

  const role = useAuthStore((s) => s.user?.role);
  // Seeded from the role so the first paint already says "Platform Support" for a brand
  // admin instead of flashing the customer wording; /lane's answer is still the truth.
  const [lane, setLane] = useState<TicketLaneInfo | null>(() =>
    expectedLaneInfo(expectedRequesterLane(role)),
  );
  /** Set when the API says this account raises no requests at all (staff, or the
   *  platform owner — there is no tier above them to ask). */
  const [notForYou, setNotForYou] = useState<string | null>(null);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [thread, setThread] = useState<{ ticket: Ticket; messages: TicketMessage[] } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [composing, setComposing] = useState(false);
  const navigate = useNavigate();
  // `?new=1` — the inbox's "Ask the platform" button lands here with the composer already open.
  const wantsNew = searchParams.get("new") === "1";
  useEffect(() => {
    if (!wantsNew || !lane) return;
    setComposing(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [wantsNew, lane, searchParams, setSearchParams]);
  const [rating, setRating] = useState(false);
  const startCall = useCallStore((s) => s.start);
  function placeCall(mode: CallMode) {
    if (!thread) return;
    startCall({
      ticketId: thread.ticket.id,
      subject: thread.ticket.subject,
      otherName: lane?.copy?.handlerName ?? "the team",
      mode,
      perspective: "requester",
      incoming: false,
    });
  }
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [allAttachments, setAllAttachments] = useState(false);
  /** The message the composer is quoting, if any. */
  const [replyTo, setReplyTo] = useState<TicketMessage | null>(null);
  /** The message whose text is in the composer being edited, if any. */
  const [editing, setEditing] = useState<TicketMessage | null>(null);

  const liveTick = useLiveTick();
  const typingLabel = useTypingIndicator(thread?.ticket.id);

  // Which conversation this account is on, and what to call it. Asked once —
  // it only changes if the account's role does, which means a fresh session.
  useEffect(() => {
    api.tickets
      .lane()
      .then((info) => setLane((prev) => (sameLaneInfo(prev, info) ? prev : info)))
      .catch((e) => {
        setNotForYou(
          e instanceof ApiError && e.status === 403
            ? e.message
            : "Couldn't load your support requests.",
        );
        setLoadingList(false);
      });
  }, []);

  const loadList = useCallback(async () => {
    try {
      const list = await api.tickets.list();
      setTickets(list);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return; // handled by `notForYou`
      toast.error(e instanceof ApiError ? e.message : "Couldn't load your requests");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!lane) return;
    void loadList();
  }, [lane, loadList, liveTick]);

  const loadThread = useCallback(async (id: string, showSpinner = true) => {
    if (showSpinner) setLoadingThread(true);
    try {
      setThread(await api.tickets.get(id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't open that request");
      setThread(null);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  // Opening a different request shows a spinner; a live nudge on the one already
  // open refreshes it in place, so a new reply doesn't blank the conversation.
  useEffect(() => {
    if (!selectedId || !lane) {
      setThread(null);
      return;
    }
    // Opening it is seeing it: drop the "new message" marker on its list row at
    // once, not after the next list refresh.
    setTickets((prev) =>
      prev.some((t) => t.id === selectedId && t.unreadForRequester)
        ? prev.map((t) => (t.id === selectedId ? { ...t, unreadForRequester: false } : t))
        : prev,
    );
    void loadThread(selectedId, thread?.ticket.id !== selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, lane, liveTick, loadThread]);

  useEffect(() => {
    setAllAttachments(false);
    setReplyTo(null);
    setEditing(null);
  }, [selectedId]);

  function select(id: string | null) {
    setReplyTo(null);
    setEditing(null);
    // A brand admin's requests are listed in their Support Tickets inbox, not here: leaving a conversation goes back there.
    if (!id && lane?.lane === "brand") {
      navigate("/dashboard/admin/tickets");
      return;
    }
    setSearchParams(id ? { ticket: id } : {}, { replace: true });
  }

  // Optimistic send. `ticketId` is captured per send so a reply lands on the thread it was written in, even if another opened since.
  const outbox = useOutbox({
    authorType: "requester",
    authorName: "You",
    send: (draft) =>
      api.tickets.reply(draft.ticketId, {
        body: draft.body,
        attachments: draft.attachments,
        replyToId: draft.replyToId,
      }),
    onSent: (message) => {
      setThread((prev) => (prev ? { ...prev, messages: [...prev.messages, message] } : prev));
      void loadList();
    },
  });

  async function sendReply(body: string, attachments: AttachmentDescriptor[]) {
    if (!thread) return;
    const quoted = replyTo;
    setReplyTo(null);
    await outbox.submit({
      ticketId: thread.ticket.id,
      body,
      attachments,
      replyToId: quoted?.id ?? null,
      replyTo: quoted,
    });
  }

  /** Swap one message for its updated copy after an edit, delete or reaction. */
  function replaceMessage(message: TicketMessage) {
    setThread((prev) =>
      prev
        ? { ...prev, messages: prev.messages.map((m) => (m.id === message.id ? message : m)) }
        : prev,
    );
  }

  async function editMessage(message: TicketMessage, body: string) {
    if (!thread) return;
    replaceMessage(await api.tickets.editMessage(thread.ticket.id, message.id, body));
  }

  async function deleteMessage(message: TicketMessage) {
    if (!thread) return;
    try {
      replaceMessage(await api.tickets.deleteMessage(thread.ticket.id, message.id));
      // A quote of it elsewhere in the thread now reads "deleted" too.
      void loadThread(thread.ticket.id, false);
      toast.success("Message deleted");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete that message");
    }
  }

  async function reactToMessage(message: TicketMessage, emoji: string) {
    if (!thread) return;
    try {
      replaceMessage(await api.tickets.react(thread.ticket.id, message.id, emoji));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that reaction");
    }
  }

  async function rateTicket(stars: number, comment: string) {
    if (!thread) return;
    const ticket = await api.tickets.rate(thread.ticket.id, stars, comment);
    setThread((prev) => (prev ? { ...prev, ticket } : prev));
    // The list row shows the score too, and the team was just notified.
    void loadList();
  }

  // Opened by the header star, or by the "how did we do?" notification, whose
  // link carries ?rate=1 so the card is the first thing they see.
  useEffect(() => {
    if (searchParams.get("rate") !== "1" || !thread) return;
    if (thread.ticket.rateable) setRating(true);
    // Consume the flag so a refresh (or closing the dialog) doesn't reopen it.
    const next = new URLSearchParams(searchParams);
    next.delete("rate");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, thread]);

  // Answering a ring: the incoming-call toast opens the ticket with ?answer=<mode>.
  // Waits for THIS ticket's thread — a previously open one must not answer in its place.
  useEffect(() => {
    const answer = searchParams.get("answer");
    if (!answer || !thread || thread.ticket.id !== selectedId) return;
    startCall({
      ticketId: thread.ticket.id,
      subject: thread.ticket.subject,
      otherName: lane?.copy?.handlerName ?? "the team",
      mode: answer === "video" ? "video" : "audio",
      perspective: "requester",
      incoming: true,
    });
    const next = new URLSearchParams(searchParams);
    next.delete("answer");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, thread, selectedId, startCall, lane]);

  async function toggleClosed() {
    // One click, one request: the button is disabled while this runs, and a
    // second call that slips in before React re-renders is dropped here.
    if (!thread || togglingStatus) return;
    const next = thread.ticket.status === "closed" ? "open" : "closed";
    setTogglingStatus(true);
    try {
      const ticket = await api.tickets.setStatus(thread.ticket.id, next);
      setThread((prev) => (prev ? { ...prev, ticket } : prev));
      void loadList();
      if (next === "closed" && ticket.rateable && ticket.rating === null) {
        // Closing is the moment they know how it went — ask right away rather
        // than hoping they find the star in the header later.
        setRating(true);
      } else {
        toast.success(next === "closed" ? "Request closed" : "Request reopened");
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the request");
    } finally {
      setTogglingStatus(false);
    }
  }

  async function copyReference(reference?: string) {
    const value = reference ?? thread?.ticket.reference;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Reference copied");
    } catch {
      toast.error("Couldn't copy — select it and copy by hand");
    }
  }

  const openCount = useMemo(
    () => tickets.filter((t) => t.status === "open" || t.status === "pending").length,
    [tickets],
  );

  /** The table under the search box: "#12", "12", or a few words of the subject. */
  const visibleTickets = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^#/, "");
    return tickets.filter(
      (t) =>
        matchesFilter(t, filter) &&
        (!q ||
          String(t.number) === q ||
          t.subject.toLowerCase().includes(q) ||
          t.reference.toLowerCase().includes(q)),
    );
  }, [tickets, search, filter]);

  // New search or filter, first page.
  useEffect(() => {
    setPage(1);
  }, [search, filter]);

  const pageTickets = useMemo(
    () => visibleTickets.slice((page - 1) * pageSize, page * pageSize),
    [visibleTickets, page, pageSize],
  );

  /** How many sit behind each quick filter, for the counts on the chips. */
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        LIST_FILTERS.map((f) => [f.key, tickets.filter((t) => matchesFilter(t, f.key)).length]),
      ) as Record<ListFilter, number>,
    [tickets],
  );

  // Header falls back to the list row so subject + badges show instantly while the thread fetches.
  const headerTicket: Ticket | null =
    thread?.ticket ?? (selectedId ? (tickets.find((t) => t.id === selectedId) ?? null) : null);

  /** Every file in the conversation, for the sidebar card. */
  const attachments = useMemo(
    () => (thread ? thread.messages.flatMap((m) => m.attachments) : []),
    [thread],
  );

  // This account raises no requests (staff → their admin; platform owner is top of the ladder) — say so instead of an empty list.
  if (notForYou) {
    return (
      <div>
        <PageHeader title="Support" subtitle="Raising requests" />
        <Card className="flex min-h-[20rem] flex-col items-center justify-center gap-3 p-8 text-center">
          <LifeBuoy className="size-10 text-muted-foreground/50" />
          <p className="text-base font-semibold">Nothing to raise here</p>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{notForYou}</p>
        </Card>
      </div>
    );
  }

  // A brand admin has no list here: their requests to the platform sit in their Support Tickets inbox,
  // next to their customers' tickets. This page only hosts one conversation, or the composer.
  if (lane?.lane === "brand" && !selectedId && !composing && !wantsNew) {
    return <Navigate to="/dashboard/admin/tickets" replace />;
  }

  const copy = lane?.copy;
  // A brand admin came from their inbox; a customer from their list.
  const backLabel = lane?.lane === "brand" ? "Back to Support Tickets" : "All requests";
  const conversation = thread ? [...thread.messages, ...outbox.messages] : [];

  return (
    <div>
      {/* Title and "New request" only while you're on the list. Inside a conversation
          they're dead space above the chat — the back arrow is the way out. Same rule
          as the handlers' inbox. */}
      {!selectedId && (
        <PageHeader
          title={lane?.lane === "brand" ? "Platform request" : (copy?.requesterPage ?? "Support")}
          subtitle={
            openCount > 0
              ? `${openCount} open request${openCount === 1 ? "" : "s"} with ${copy?.handlerName ?? "the team"}`
              : `Raise a request and chat with ${copy?.handlerName ?? "the team"}`
          }
          actions={
            <Button onClick={() => setComposing(true)} disabled={!lane}>
              <Plus className="size-4" /> New request
            </Button>
          }
        />
      )}

      {selectedId ? (
        /* ------------------------------ Thread -----------------------------
           The same shape as the handlers' inbox (conversation left, facts right, one
           header bar): a brand admin moves between their inbox and their own request
           without the screen changing shape under them. */
        <div
          className={cn(
            "grid gap-4 lg:items-start",
            (thread || loadingThread) && "lg:grid-cols-[minmax(0,1fr)_19rem]",
          )}
        >
          <Card className="flex h-[calc(100dvh-12rem)] min-h-[28rem] flex-col overflow-hidden">
            {!thread && !loadingThread ? (
              <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
                <MailEmptyIllustration className="mb-6" />
                <p className="text-lg font-semibold">Couldn't open that request</p>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  It may have been removed, or merged into another of your requests.
                </p>
                <Button variant="outline" className="mt-4" onClick={() => select(null)}>
                  <ArrowLeft className="size-4" /> {backLabel}
                </Button>
              </div>
            ) : (
              <>
                <header className="border-b border-border px-4 py-3">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => select(null)}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={backLabel}
                      title={backLabel}
                    >
                      <ArrowLeft className="size-4" />
                    </button>
                    {headerTicket && <TicketAvatar name={headerTicket.requester.name} size="lg" />}
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-semibold">
                        {headerTicket?.subject ?? "Loading…"}
                      </h2>
                      {headerTicket && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <Badge variant="outline" className="font-mono text-[11px]">
                            #{headerTicket.number}
                          </Badge>
                          <button
                            type="button"
                            onClick={() => void copyReference(headerTicket.reference)}
                            className="font-mono hover:text-foreground"
                            title="Copy reference"
                          >
                            {headerTicket.reference}
                          </button>
                          <TicketStatusBadge status={headerTicket.status} />
                          <TicketPriorityBadge priority={headerTicket.priority} />
                          <span>{headerTicket.department?.name ?? "General"}</span>
                          {/* A brand admin's escalation: which of THEIR customers'
                              tickets it was raised from, with a way back to it. */}
                          {headerTicket.escalatedFrom && (
                            <Link
                              to={`/dashboard/admin/tickets?ticket=${headerTicket.escalatedFrom.id}`}
                              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium hover:text-foreground"
                              title="Raised from one of your customers' tickets — open it in your inbox"
                            >
                              <ArrowUpRight className="size-3" /> From #{headerTicket.escalatedFrom.number}{" "}
                              · {headerTicket.escalatedFrom.requesterName}
                            </Link>
                          )}
                          <span title={new Date(headerTicket.createdAt).toLocaleString()}>
                            Opened {formatDate(headerTicket.createdAt)}
                          </span>
                        </div>
                      )}
                    </div>
                    {thread && (
                      <div className="flex shrink-0 items-center gap-1">
                        <TicketCallControls
                          ticketId={thread.ticket.id}
                          subject={thread.ticket.subject}
                          otherName={lane?.copy?.handlerName ?? "the team"}
                          perspective="requester"
                          canCall={thread.ticket.status !== "closed"}
                          onPlace={placeCall}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label="More actions"
                            >
                              <MoreVertical className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[15rem] rounded-xl p-1.5">
                            <MenuOption
                              icon={<Copy className="size-4" />}
                              label="Copy reference"
                              hint={thread.ticket.reference}
                              onSelect={() => void copyReference(thread.ticket.reference)}
                            />
                            {thread.ticket.rateable && (
                              <MenuOption
                                icon={<Star className="size-4" />}
                                tone="bg-warning-tint text-warning"
                                label={
                                  thread.ticket.rating === null
                                    ? "Rate this request"
                                    : "Change your rating"
                                }
                                hint={
                                  thread.ticket.rating === null
                                    ? "Tell the team how it went"
                                    : `You gave ${thread.ticket.rating} of 5`
                                }
                                onSelect={() => setRating(true)}
                              />
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                          variant={thread.ticket.status === "closed" ? "primary" : "outline"}
                          size="sm"
                          onClick={() => void toggleClosed()}
                          disabled={togglingStatus}
                          aria-busy={togglingStatus}
                          className="gap-1.5"
                        >
                          {togglingStatus ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : thread.ticket.status === "closed" ? (
                            <RotateCcw className="size-3.5" />
                          ) : (
                            <CheckCircle2 className="size-3.5" />
                          )}
                          {togglingStatus
                            ? thread.ticket.status === "closed"
                              ? "Reopening…"
                              : "Closing…"
                            : thread.ticket.status === "closed"
                              ? "Reopen request"
                              : "Close request"}
                        </Button>
                      </div>
                    )}
                  </div>
                </header>

                {/* The call window sits over this whole column (bar, messages, composer)
                    while a call is on for this ticket — the chat box becomes the call (see CallWindow). */}
                <div data-call-anchor={selectedId} className="flex min-h-0 flex-1 flex-col">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
                    <p className="text-sm font-medium">
                      Conversation
                      {thread && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {conversation.length}
                          {conversation.length === 1 ? " message" : " messages"}
                        </span>
                      )}
                    </p>
                  </div>

                  {/* Both move into the call window's Chat panel while it is open. */}
                  <CallChatSlot ticketId={selectedId}>
                    <TicketThread
                      className="min-h-0 flex-1"
                      messages={conversation}
                      perspective="requester"
                      loading={loadingThread}
                      // The second tick appears once the team has opened the thread.
                      otherReadAt={thread?.ticket.staffReadAt}
                      typingLabel={typingLabel}
                      meId={thread?.ticket.requester.id}
                      onReply={(m) => {
                        setEditing(null);
                        setReplyTo(m);
                      }}
                      onEdit={(m) => {
                        setReplyTo(null);
                        setEditing(m);
                      }}
                      onDelete={deleteMessage}
                      onReact={reactToMessage}
                      onRetry={outbox.retry}
                      onDiscard={outbox.discard}
                    />

                    <ChatComposer
                      onSend={sendReply}
                      optimistic
                      upload={(file, onProgress, signal) => api.tickets.upload(file, onProgress, signal)}
                      disabled={thread?.ticket.status === "closed"}
                      disabledReason="This request is closed. Reopen it to keep chatting."
                      placeholder={`Reply to ${copy?.handlerName ?? "the team"}…`}
                      replyTo={replyTo}
                      onCancelReply={() => setReplyTo(null)}
                      editing={editing}
                      onCancelEdit={() => setEditing(null)}
                      onSaveEdit={async (m, body) => {
                        await editMessage(m, body);
                        setEditing(null);
                      }}
                      onTyping={() => {
                        if (thread) void api.tickets.typing(thread.ticket.id).catch(() => {});
                      }}
                    />
                  </CallChatSlot>
                </div>
              </>
            )}
          </Card>

          {/* --------------------------- Request details ---------------------- */}
          {(thread || loadingThread) && (
            <div className="space-y-4">
              <Card className="overflow-hidden">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold">Request details</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Status, priority and who's on it.
                  </p>
                </div>

                {!thread ? (
                  <div className="space-y-4 p-4">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="space-y-1.5">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-9 rounded-lg" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="space-y-4 p-4">
                      <DetailField label="Status">
                        <TicketStatusDot status={thread.ticket.status} />
                      </DetailField>
                      <DetailField label="Priority">
                        <TicketPriorityBadge priority={thread.ticket.priority} />
                      </DetailField>
                      <DetailField label="Department">
                        {thread.ticket.department?.name ?? "General"}
                      </DetailField>
                      <DetailField label="Handled by">{copy?.handlerName ?? "The team"}</DetailField>
                      {thread.ticket.closedAt && (
                        <DetailField label="Closed">
                          <span title={new Date(thread.ticket.closedAt).toLocaleString()}>
                            {formatDate(thread.ticket.closedAt)}
                          </span>
                        </DetailField>
                      )}
                    </div>
                    {/* Say it's picked up, never by WHOM — the server masks the assignee to the team label, so this line needs no name. */}
                    <p className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                      <Users className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {thread.ticket.assignedTo ? (
                          <>
                            Someone from{" "}
                            <span className="font-medium text-foreground">
                              {copy?.handlerName ?? "the team"}
                            </span>{" "}
                            is looking after this.
                          </>
                        ) : (
                          <>
                            With{" "}
                            <span className="font-medium text-foreground">
                              {copy?.handlerName ?? "the team"}
                            </span>{" "}
                            — nobody has taken it yet.
                          </>
                        )}
                      </span>
                    </p>
                  </>
                )}
              </Card>

              {/* ---------------------------- You ---------------------------- */}
              {thread && (
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="text-sm font-semibold">Your details</h3>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <TicketAvatar name={thread.ticket.requester.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{thread.ticket.requester.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {thread.ticket.requester.email}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-border border-t border-border text-xs">
                    <div className="px-4 py-2.5">
                      <p className="text-muted-foreground">Handled by</p>
                      <p className="mt-0.5 truncate font-medium">{copy?.handlerName ?? "The team"}</p>
                    </div>
                    <div className="px-4 py-2.5">
                      <p className="text-muted-foreground">Opened</p>
                      <p
                        className="mt-0.5 font-medium"
                        title={new Date(thread.ticket.createdAt).toLocaleString()}
                      >
                        {formatDate(thread.ticket.createdAt)}
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              {/* -------------------------- Attachments --------------------- */}
              {thread && attachments.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <Paperclip className="size-4 text-muted-foreground" />
                      Attachments ({attachments.length})
                    </h3>
                  </div>
                  <div className="p-4">
                    <ul className="space-y-2">
                      {(allAttachments
                        ? attachments
                        : attachments.slice(0, ATTACHMENTS_PREVIEW)
                      ).map((f) => (
                        <li
                          key={f.id}
                          className="flex items-center gap-3 rounded-xl border border-border p-2.5"
                        >
                          {f.mime.startsWith("image/") ? (
                            <img src={f.url} alt="" className="size-14 shrink-0 rounded-lg object-cover" />
                          ) : (
                            <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                              <FileText className="size-5" />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{f.name}</p>
                            <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
                          </div>
                          <a
                            href={f.url}
                            download={f.name}
                            target="_blank"
                            rel="noreferrer"
                            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={`Download ${f.name}`}
                          >
                            <Download className="size-4" />
                          </a>
                        </li>
                      ))}
                    </ul>
                    {attachments.length > ATTACHMENTS_PREVIEW && (
                      <button
                        type="button"
                        onClick={() => setAllAttachments((v) => !v)}
                        className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-medium text-primary transition-colors hover:bg-primary-tint-soft"
                      >
                        {allAttachments ? (
                          <>
                            Show less <ChevronUp className="size-4" />
                          </>
                        ) : (
                          <>
                            See all {attachments.length} <ChevronDown className="size-4" />
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      ) : (
        /* ------------------------------- List ------------------------------ */
        <Card className="flex min-h-[28rem] flex-col overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number or subject…"
                className="h-10 bg-muted/50 pl-10"
                aria-label="Search your requests"
              />
            </div>
            <div className="flex items-center gap-2">
              <div
                role="tablist"
                aria-label="Filter requests"
                className="flex flex-1 items-center gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1 lg:flex-none"
              >
                {LIST_FILTERS.map((f) => {
                  const active = filter === f.key;
                  const n = filterCounts[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setFilter(f.key)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {f.label}
                      {n > 0 && (
                        <span
                          className={cn(
                            "rounded-full px-1.5 text-[11px] tabular-nums",
                            active ? "bg-primary-tint text-primary" : "bg-background/70",
                          )}
                        >
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => void loadList()}
                className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Refresh"
              >
                <RefreshCw className="size-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {loadingList ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-[4.5rem] rounded-xl" />
                <Skeleton className="h-[4.5rem] rounded-xl" />
                <Skeleton className="h-[4.5rem] rounded-xl" />
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
                <MailEmptyIllustration className="mb-5" />
                <p className="text-lg font-semibold">How can we help?</p>
                <p className="mt-1.5 max-w-[24rem] text-sm leading-relaxed text-muted-foreground">
                  Something not working, a billing question, or a change you'd like made? Start a
                  request and {copy?.handlerName ?? "the team"} picks it up — you'll get a reply
                  right here and by email.
                </p>
                <Button className="mt-5" onClick={() => setComposing(true)} disabled={!lane}>
                  <Plus className="size-4" /> New request
                </Button>
              </div>
            ) : visibleTickets.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-14 text-center">
                <span className="mb-4 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Search className="size-5" />
                </span>
                <p className="text-base font-semibold">Nothing here</p>
                <p className="mt-1 max-w-[20rem] text-sm text-muted-foreground">
                  {search
                    ? "Try the request's number, or a word from its subject."
                    : "No requests under this filter."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Show all requests
                </Button>
              </div>
            ) : (
              <>
                {/* Phone — card rows. */}
                <ul className="space-y-2 p-3 md:hidden">
                  {pageTickets.map((t) => (
                    <li key={t.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => select(t.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            select(t.id);
                          }
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-4 rounded-xl border bg-card px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-primary-tint-soft focus-visible:border-primary focus-visible:outline-none",
                          t.status === "pending" ? "border-warning/40" : "border-border",
                        )}
                      >
                        <TicketTile ticket={t} unread={t.unreadForRequester} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p
                              className={cn(
                                "truncate text-[15px] leading-tight",
                                t.unreadForRequester ? "font-bold" : "font-semibold",
                              )}
                            >
                              {t.subject}
                            </p>
                            {t.unreadForRequester && <NewMessageDot inline />}
                          </div>
                          <p className="mt-0.5 truncate text-sm text-muted-foreground">
                            {t.lastMessage || "No messages yet"}
                          </p>
                          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span className="font-mono">#{t.number}</span>
                            {t.department && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{t.department.name}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>Updated {timeAgo(t.lastMessageAt)}</span>
                          </p>
                        </div>
                        <span className="shrink-0">
                          <TicketStatusDot status={t.status} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>

                {/* Desktop — the same table the team works from. */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-card">
                      <tr className="border-b border-border bg-muted/30 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">#</th>
                        <th className="px-4 py-3 font-medium">Request</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Priority</th>
                        <th className="px-4 py-3 font-medium">Department</th>
                        <th className="px-4 py-3 font-medium">Opened</th>
                        <th className="px-4 py-3 text-right font-medium">Last activity</th>
                        <th className="px-2 py-3">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageTickets.map((t) => (
                        <tr
                          key={t.id}
                          tabIndex={0}
                          onClick={() => select(t.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              select(t.id);
                            }
                          }}
                          className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-primary-tint-soft focus-visible:bg-primary-tint-soft focus-visible:outline-none"
                        >
                          <td className="whitespace-nowrap px-4 py-5 text-[15px] font-semibold">
                            #{t.number}
                          </td>
                          <td className="max-w-[28rem] px-4 py-5">
                            <div className="flex items-start gap-3">
                              <TicketTile ticket={t} unread={t.unreadForRequester} className="mt-0.5" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p
                                    className={cn(
                                      "truncate text-[15px] leading-tight",
                                      t.unreadForRequester ? "font-bold" : "font-semibold",
                                    )}
                                  >
                                    {t.subject}
                                  </p>
                                  {t.unreadForRequester && (
                                    <span className="shrink-0 rounded-full bg-primary-tint px-2 py-0.5 text-[11px] font-semibold text-primary">
                                      New reply
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {t.lastMessage || "No messages yet"}
                                </p>
                                <span className="mt-1.5 inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                  {t.reference}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-5">
                            <span
                              className={cn(
                                "inline-flex h-9 items-center rounded-lg border px-3",
                                STATUS_WASH[t.status],
                              )}
                            >
                              <TicketStatusDot status={t.status} />
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-5">
                            {t.rateable ? (
                              t.rating !== null ? (
                                <StarRating value={t.rating} size="sm" />
                              ) : (
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                                  <Star className="size-3.5" /> Rate this
                                </span>
                              )
                            ) : (
                              <span className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-3">
                                <TicketPriorityBadge priority={t.priority} />
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-5 text-muted-foreground">
                            {t.department?.name ?? "General"}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-5 text-muted-foreground"
                            title={new Date(t.createdAt).toLocaleString()}
                          >
                            {formatDate(t.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-5 text-right text-muted-foreground">
                            {timeAgo(t.lastMessageAt)}
                          </td>
                          <td
                            className="w-px px-2 py-2 text-right"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label={`Actions for request #${t.number}`}
                                >
                                  <MoreVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="min-w-[15rem] rounded-xl p-1.5"
                              >
                                <MenuOption
                                  icon={<Eye className="size-4" />}
                                  tone="bg-primary-tint text-primary"
                                  label="View details"
                                  hint="Open the conversation"
                                  onSelect={() => select(t.id)}
                                />
                                <MenuOption
                                  icon={<Copy className="size-4" />}
                                  label="Copy reference"
                                  hint={t.reference}
                                  onSelect={() => void copyReference(t.reference)}
                                />
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {!loadingList && visibleTickets.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={visibleTickets.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                noun="requests"
              />
            </div>
          )}
        </Card>
      )}

      {thread && (
        <TicketRatingDialog
          open={rating}
          onOpenChange={setRating}
          ticket={thread.ticket}
          onRate={rateTicket}
        />
      )}


      {lane && (
        <NewRequestDialog
          open={composing}
          onOpenChange={setComposing}
          lane={lane}
          onCreated={(ticket) => {
            setComposing(false);
            void loadList();
            select(ticket.id);
          }}
        />
      )}
    </div>
  );
}

// New request dialog — reuses the thread composer so the first message (and its files) works exactly like every later one.

function NewRequestDialog({
  open,
  onOpenChange,
  lane,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: TicketLaneInfo;
  onCreated: (ticket: Ticket) => void;
}) {
  const [departments, setDepartments] = useState<TicketDepartment[]>([]);
  const [loading, setLoading] = useState(false);
  const [subject, setSubject] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api.tickets
      .departments()
      .then((rows) => {
        setDepartments(rows);
        if (rows.length === 1) setDepartmentId(rows[0].id);
      })
      .catch(() => setError("Couldn't load the department list."))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSubject("");
      setDepartmentId("");
      setPriority("normal");
      setError(null);
    }
  }, [open]);

  async function create(message: string, attachments: AttachmentDescriptor[]) {
    const fail = (msg: string) => {
      setError(msg);
      throw new Error(msg);
    };
    if (subject.trim().length < 3) fail("Give your request a short subject.");
    if (!departmentId) fail("Choose which team should pick this up.");
    setError(null);
    const ticket = await api.tickets.create({
      subject: subject.trim(),
      departmentId,
      priority,
      message,
      attachments,
    });
    toast.success(`Request ${ticket.reference} sent`);
    onCreated(ticket);
  }

  const selectedDepartment = departments.find((d) => d.id === departmentId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>
            Tell {lane.copy.handlerName} what you need. Attach screenshots or files if they help.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 pt-4">
          <div className="space-y-2">
            <label htmlFor="ticket-subject" className="text-sm font-medium">
              Subject <span className="text-danger">*</span>
            </label>
            <Input
              id="ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's this about?"
              maxLength={140}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                What's it about? <span className="text-danger">*</span>
              </label>
              {loading ? (
                <Skeleton className="h-10 rounded-lg" />
              ) : (
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger aria-label="Department">
                    <SelectValue placeholder="Choose a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selectedDepartment?.description && (
                <p className="text-xs text-muted-foreground">{selectedDepartment.description}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Priority</label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
                <SelectTrigger aria-label="Priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {departments.length === 0 && !loading && (
            <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-xs text-foreground">
              <Lock className="size-3.5 shrink-0 text-warning" />
              Support isn't set up yet. Please try again shortly.
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <ChatComposer
          className="mt-4"
          onSend={create}
          upload={(file, onProgress, signal) => api.tickets.upload(file, onProgress, signal)}
          disabled={departments.length === 0}
          disabledReason="Support requests aren't available right now."
          placeholder="Describe what's happening — what you expected, what actually happened, and when it started…"
          // The description is the point of this form, not a chat line: open it
          // at a paragraph's worth of room, and don't let a stray Enter send it.
          minHeight={100}
          maxHeight={260}
          submitOnEnter={false}
          sendLabel="Send request"
          label="Describe your issue"
          required
        />
      </DialogContent>
    </Dialog>
  );
}
