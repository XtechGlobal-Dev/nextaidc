import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Download,
  Eye,
  FileText,
  Flag,
  GitMerge,
  LayoutGrid,
  Link2,
  Loader2,
  Mail,
  MessageSquareText,
  MoreVertical,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  UserRound,
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
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatComposer } from "@/components/tickets/ChatComposer";
import { TicketThread } from "@/components/tickets/TicketThread";
import { StarRating } from "@/components/tickets/StarRating";
import {
  InboxEmptyIllustration,
  MailEmptyIllustration,
} from "@/components/tickets/TicketIllustrations";
import {
  MenuOption,
  MenuTitle,
  NewMessageDot,
  PRIORITY_HINT,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_HINT_STAFF,
  STATUS_LABEL_STAFF,
  STATUS_TONE,
  STATUS_WASH,
  TicketAvatar,
  TicketBrandBadge,
  TicketPriorityBadge,
  TicketStatusBadge,
  TicketStatusDot,
  TicketTile,
  ToneDot,
} from "@/components/tickets/ticketUi";
import { fillSavedReply } from "@/components/tickets/savedReplies";
import { useOutbox } from "@/components/tickets/useOutbox";
import { DepartmentsDialog } from "@/pages/admin/tickets/DepartmentsDialog";
import { NewTicketDialog } from "@/pages/admin/tickets/NewTicketDialog";
import { MergeTicketDialog } from "@/pages/admin/tickets/MergeTicketDialog";
import { EscalateTicketDialog } from "@/pages/admin/tickets/EscalateTicketDialog";
import { HandoffNoteDialog } from "@/pages/admin/tickets/HandoffNoteDialog";
import { SavedRepliesDialog } from "@/pages/admin/tickets/SavedRepliesDialog";
import { api, ApiError, type AdminTicketListParams } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { isAdminRole, isSuperAdminRole } from "@/lib/roles";
import { adminHref } from "@/lib/onboardingRoute";
import { useLiveTick, useTypingIndicator } from "@/hooks/useLiveData";
import { useActiveTicketThread } from "@/hooks/useActiveTicketThread";
import { formatBytes } from "@/lib/ticketFiles";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import type {
  AdminTicketDepartment,
  AttachmentDescriptor,
  Ticket,
  TicketAgent,
  TicketLaneInfo,
  TicketMergeRecord,
  TicketMessage,
  TicketPriority,
  TicketSavedReply,
  TicketStats,
  TicketStatus,
} from "@/types/ticket";

// Handler's inbox, both lanes: brand admins see their customers' tickets, the platform owner sees the brands'.
// The lane is resolved server-side from the role (/lane), never chosen here — so the two can't be confused.

const STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "unresolved", label: "Unresolved" },
  { key: "open", label: "Open" },
  { key: "pending", label: "Waiting on requester" },
  { key: "resolved", label: "Resolved" },
  { key: "closed", label: "Closed" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

// "All" not "Unresolved" — hiding resolved threads by default makes a just-finished request look like it vanished.
const DEFAULT_STATUS: StatusFilter = "all";

const ANY_DEPARTMENT = "__any__";
const ANY_BRAND = "__any__";

/** How many files the attachments card shows before "See all". */
const ATTACHMENTS_PREVIEW = 2;

type PriorityFilter = "any" | TicketPriority;

const PRIORITY_FILTERS: { key: PriorityFilter; label: string }[] = [
  { key: "any", label: "All priorities" },
  { key: "urgent", label: "Urgent" },
  { key: "high", label: "High" },
  { key: "normal", label: "Normal" },
  { key: "low", label: "Low" },
];

// Thread filter: everything, requester-visible replies only, or internal notes only.
const MESSAGE_FILTERS = [
  { key: "all", label: "All messages" },
  { key: "replies", label: "Replies only" },
  { key: "notes", label: "Internal notes" },
] as const;

type MessageFilter = (typeof MESSAGE_FILTERS)[number]["key"];

/** The compact pickers on the filter row: icon, current value, chevron. */
const FILTER_TRIGGER =
  "h-10 w-auto gap-2 rounded-lg bg-card px-3 text-sm font-medium [&>span]:text-foreground";

const ASSIGNED_ANY = "any";
const ASSIGNED_ME = "me";
const ASSIGNED_NONE = "unassigned";
/** Assignee-select sentinel: "hand this to the platform". Not a person, so it never patches the
 *  ticket — it opens the escalation dialog, which raises a linked request with the super admin. */
const ASSIGN_TO_PLATFORM = "__platform__";

function isStaffFilter(value: string): boolean {
  return value !== ASSIGNED_ANY && value !== ASSIGNED_ME && value !== ASSIGNED_NONE;
}

export default function AdminTicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("ticket");
  // The open conversation counts as seen: its notifications are read, not toasted.
  useActiveTicketThread(selectedId);
  // Mirror for the list loader below (a stable callback).
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const role = useAuthStore((s) => s.user?.role);
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const agentName = useAuthStore((s) => s.user?.fullName || s.user?.email || "Support");
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const isAdmin = isAdminRole(role);
  const liveTick = useLiveTick();

  const [lane, setLane] = useState<TicketLaneInfo | null>(null);
  const [notForYou, setNotForYou] = useState<string | null>(null);

  // Admins pass everything in their lane; STAFF use `tickets.*` (brand) or `brand_tickets.*` (platform), see handlerLane.
  // Nothing is editable until /lane answers — read-only for a beat beats a flash of the wrong buttons.
  const section = lane?.lane === "brand" ? "brand_tickets" : "tickets";
  const canEdit = isAdmin || (!!lane && hasPermission(`${section}.edit`));
  const canCreate = isAdmin || (!!lane && hasPermission(`${section}.create`));
  const canDelete = isAdmin || (!!lane && hasPermission(`${section}.delete`));
  /** On the brand lane the tenant column is the point; on a brand's own inbox
   *  every row is the same tenant, so it would be a column of one value. */
  const showBrandColumn = lane?.lane === "brand";

  const [status, setStatus] = useState<StatusFilter>(DEFAULT_STATUS);
  const [departmentId, setDepartmentId] = useState<string>(ANY_DEPARTMENT);
  const [brandId, setBrandId] = useState<string>(ANY_BRAND);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [assigned, setAssigned] = useState<string>(ASSIGNED_ANY);
  const [priority, setPriority] = useState<PriorityFilter>("any");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [departments, setDepartments] = useState<AdminTicketDepartment[]>([]);
  // Every queue in the lane, for reassignment — the right team is often one you're not on. The filter uses `departments`.
  const [allDepartments, setAllDepartments] = useState<AdminTicketDepartment[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listPending, setListPending] = useState(false);

  const [thread, setThread] = useState<{
    ticket: Ticket;
    messages: TicketMessage[];
    merges?: TicketMergeRecord[];
  } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [agents, setAgents] = useState<TicketAgent[]>([]);
  const [filterAgents, setFilterAgents] = useState<TicketAgent[]>([]);
  const [savedReplies, setSavedReplies] = useState<TicketSavedReply[]>([]);
  const [internalNote, setInternalNote] = useState(false);
  const [replyTo, setReplyTo] = useState<TicketMessage | null>(null);
  const [editing, setEditing] = useState<TicketMessage | null>(null);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("all");
  const [allAttachments, setAllAttachments] = useState(false);
  const typingLabel = useTypingIndicator(thread?.ticket.id);

  const [showDepartments, setShowDepartments] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [showSavedReplies, setShowSavedReplies] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Ticket | null>(null);
  const [exporting, setExporting] = useState(false);
  // Reassign/move staged until the hand-over note dialog confirms; the selects never patch directly.
  const [handoff, setHandoff] = useState<{
    ticket: Ticket;
    patch: { assignedToId?: string | null; departmentId?: string };
    title: string;
    audience: string;
    confirmLabel: string;
    done: string;
  } | null>(null);

  useEffect(() => {
    api.admin.tickets
      .lane()
      .then(setLane)
      .catch((e) => {
        setNotForYou(
          e instanceof ApiError && e.status === 403
            ? e.message
            : "Couldn't load the support inbox.",
        );
        setLoadingList(false);
      });
  }, []);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  // Loads can land out of order; only the newest sequence number may touch the screen.
  const listSeq = useRef(0);

  const listParams = useMemo(
    (): AdminTicketListParams => ({
      status,
      departmentId: departmentId === ANY_DEPARTMENT ? undefined : departmentId,
      brandId: brandId === ANY_BRAND ? undefined : brandId,
      q: debouncedSearch || undefined,
      assigned:
        assigned === ASSIGNED_ME || assigned === ASSIGNED_NONE
          ? (assigned as "me" | "unassigned")
          : undefined,
      assignedToId: isStaffFilter(assigned) ? assigned : undefined,
      priority: priority === "any" ? undefined : priority,
    }),
    [status, departmentId, brandId, debouncedSearch, assigned, priority],
  );

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setListPending(true);
    try {
      const res = await api.admin.tickets.list({ ...listParams, page, pageSize });
      if (seq !== listSeq.current) return;
      // The open ticket is being read now; a list response that raced the open must not re-mark it unread.
      const open = selectedIdRef.current;
      setTickets(
        open
          ? res.tickets.map((t) =>
              t.id === open && t.unreadForStaff ? { ...t, unreadForStaff: false } : t,
            )
          : res.tickets,
      );
      setTotal(res.total);
    } catch (e) {
      if (seq !== listSeq.current) return;
      if (e instanceof ApiError && e.status === 403) return; // handled by `notForYou`
      toast.error(e instanceof ApiError ? e.message : "Couldn't load requests");
    } finally {
      if (seq === listSeq.current) {
        setLoadingList(false);
        setListPending(false);
      }
    }
  }, [listParams, page, pageSize]);

  // New filters, first page — a page number from the old result set means nothing.
  useEffect(() => {
    setPage(1);
  }, [listParams]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.admin.tickets.stats());
    } catch {
      // The tiles keep their last numbers; the list's own error is the one worth
      // a toast.
    }
  }, []);

  useEffect(() => {
    if (!lane) return;
    void loadList();
  }, [lane, loadList, liveTick]);

  useEffect(() => {
    if (!lane) return;
    void loadStats();
  }, [lane, loadStats, liveTick]);

  const loadSavedReplies = useCallback(async () => {
    try {
      setSavedReplies(await api.admin.tickets.savedReplies.list());
    } catch {
      // The menu simply stays empty; nothing on this screen depends on it.
    }
  }, []);

  useEffect(() => {
    if (!lane) return;
    void loadSavedReplies();
  }, [lane, loadSavedReplies]);

  useEffect(() => {
    if (!lane) return;
    api.admin.tickets.departments.list().then(setDepartments).catch(() => setDepartments([]));
    api.admin.tickets.departments
      .list("all")
      // Falling back to the scoped list keeps reassignment working (within your
      // own queues) rather than leaving the picker empty.
      .then(setAllDepartments)
      .catch(() => setAllDepartments([]));
  }, [lane, liveTick]);

  // The assignee filter lists the people who work the chosen queue, or everyone
  // across the caller's queues when none is chosen.
  useEffect(() => {
    if (!lane) return;
    let cancelled = false;
    api.admin.tickets
      .agents(departmentId === ANY_DEPARTMENT ? undefined : departmentId)
      .then((rows) => {
        if (!cancelled) setFilterAgents(rows);
      })
      .catch(() => {
        if (!cancelled) setFilterAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [lane, departmentId]);

  // Switching queue can drop the person you were filtering by — fall back to
  // "anyone" rather than filter on someone who isn't in the list.
  useEffect(() => {
    if (!isStaffFilter(assigned)) return;
    if (filterAgents.length > 0 && !filterAgents.some((a) => a.id === assigned)) {
      setAssigned(ASSIGNED_ANY);
    }
  }, [filterAgents, assigned]);

  const loadThread = useCallback(async (id: string, showSpinner = true) => {
    if (showSpinner) setLoadingThread(true);
    try {
      const data = await api.admin.tickets.get(id);
      setThread(data);
      // Possible assignees with their queues; fetched per thread so a just-added colleague shows on next open.
      api.admin.tickets
        .agents()
        .then(setAgents)
        .catch(() => setAgents([]));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't open that request");
      setThread(null);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId || !lane) {
      setThread(null);
      return;
    }
    // Opening it is seeing it: drop the marker on its list row at once.
    setTickets((prev) =>
      prev.some((t) => t.id === selectedId && t.unreadForStaff)
        ? prev.map((t) => (t.id === selectedId ? { ...t, unreadForStaff: false } : t))
        : prev,
    );
    void loadThread(selectedId, thread?.ticket.id !== selectedId);
    setInternalNote(false);
    // A quote belongs to the conversation it was picked in.
    setReplyTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, lane, liveTick, loadThread]);

  useEffect(() => {
    setMessageFilter("all");
    setEditing(null);
    setAllAttachments(false);
  }, [selectedId]);

  function select(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("ticket", id);
    else next.delete("ticket");
    setSearchParams(next, { replace: true });
  }

  function clearFilters() {
    setStatus(DEFAULT_STATUS);
    setDepartmentId(ANY_DEPARTMENT);
    setBrandId(ANY_BRAND);
    setAssigned(ASSIGNED_ANY);
    setPriority("any");
    setSearch("");
  }

  /** After a reply, an edit, a delete or a new request: rows and counts together. */
  const refreshInbox = useCallback(() => {
    void loadList();
    void loadStats();
  }, [loadList, loadStats]);

  async function exportCsv() {
    setExporting(true);
    try {
      await api.admin.tickets.exportCsv(listParams);
      toast.success("Your CSV is downloading");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't export the requests");
    } finally {
      setExporting(false);
    }
  }

  // Optimistic send: the reply shows at once, a slow one shows a clock, a failed one stays with Retry.
  const outbox = useOutbox({
    authorType: "staff",
    authorName: "You",
    send: (draft) =>
      api.admin.tickets.reply(draft.ticketId, {
        body: draft.body,
        internal: draft.internal,
        attachments: draft.attachments,
        replyToId: draft.replyToId,
      }),
    onSent: (message, draft) => {
      setThread((prev) => (prev ? { ...prev, messages: [...prev.messages, message] } : prev));
      // A real reply moves the request to "waiting on requester" and claims it,
      // so the header has to be re-read — an internal note changes neither.
      if (!message.internal) void loadThread(draft.ticketId, false);
      refreshInbox();
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
      internal: internalNote,
      replyToId: quoted?.id ?? null,
      replyTo: quoted,
    });
  }

  function replaceMessage(message: TicketMessage) {
    setThread((prev) =>
      prev
        ? { ...prev, messages: prev.messages.map((m) => (m.id === message.id ? message : m)) }
        : prev,
    );
  }

  async function editMessage(message: TicketMessage, body: string) {
    if (!thread) return;
    replaceMessage(await api.admin.tickets.editMessage(thread.ticket.id, message.id, body));
  }

  async function deleteMessage(message: TicketMessage) {
    if (!thread) return;
    try {
      replaceMessage(await api.admin.tickets.deleteMessage(thread.ticket.id, message.id));
      // Any quote of it elsewhere in the thread now reads "deleted" too.
      void loadThread(thread.ticket.id, false);
      toast.success("Message deleted");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete that message");
    }
  }

  async function reactToMessage(message: TicketMessage, emoji: string) {
    if (!thread) return;
    try {
      replaceMessage(await api.admin.tickets.react(thread.ticket.id, message.id, emoji));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that reaction");
    }
  }

  /** Resolves true when the pane is still showing the (now updated) request. */
  async function patchTicket(
    patch: {
      status?: TicketStatus;
      priority?: TicketPriority;
      assignedToId?: string | null;
      departmentId?: string;
      note?: string;
    },
    done = "Request updated",
  ): Promise<boolean> {
    if (!thread) return false;
    try {
      const { handedOff, ...ticket } = await api.admin.tickets.update(thread.ticket.id, patch);
      if (handedOff) {
        // Out of our reach now and unreadable — close the pane before it 404s on refresh.
        const what = patch.departmentId
          ? `Moved to ${allDepartments.find((d) => d.id === patch.departmentId)?.name ?? "another team"}`
          : patch.assignedToId
            ? `Assigned to ${agents.find((a) => a.id === patch.assignedToId)?.name ?? "a colleague"}`
            : "Handed over";
        toast.success(`${what} — it's out of your inbox now`);
        select(null);
        refreshInbox();
        return false;
      }
      setThread((prev) => (prev ? { ...prev, ticket } : prev));
      refreshInbox();
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the request");
      return false;
    }
  }

  /** Change a request from its row in the list — the same PATCH, with no thread
   *  on screen to keep in step. */
  async function patchRow(
    ticket: Ticket,
    patch: {
      status?: TicketStatus;
      priority?: TicketPriority;
      assignedToId?: string | null;
      departmentId?: string;
      note?: string;
    },
    done = "Request updated",
  ): Promise<void> {
    try {
      const { handedOff } = await api.admin.tickets.update(ticket.id, patch);
      toast.success(handedOff ? `${done} — it's out of your inbox now` : done);
      refreshInbox();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the request");
    }
  }

  // Reassign destinations, own queues first. Always includes the current queue so the trigger never renders blank.
  const reassignDepartments = useMemo(() => {
    const source = allDepartments.length > 0 ? allDepartments : departments;
    const enabled = source.filter((d) => d.enabled || d.id === thread?.ticket.department?.id);
    return [...enabled].sort((a, b) => Number(b.mine) - Number(a.mine) || a.order - b.order);
  }, [allDepartments, departments, thread?.ticket.department?.id]);

  /** Stage a move to another department, pending the hand-over note. */
  function stageMove(ticket: Ticket, nextDepartmentId: string) {
    const to =
      reassignDepartments.find((d) => d.id === nextDepartmentId)?.name ?? "another department";
    setHandoff({
      ticket,
      patch: { departmentId: nextDepartmentId },
      title: `Move #${ticket.number} to ${to}`,
      audience: `${
        ticket.assignedTo ? `${ticket.assignedTo.name} comes off it. ` : ""
      }The ${to} team is emailed and notified, and it waits there for someone to take it.`,
      confirmLabel: "Move request",
      done: `Moved to ${to}`,
    });
  }

  // Stage an assignment. `value` is "__unassigned__", an agent id, or "<agent>|<department>" (moves the ticket to their queue too).
  function stageAssign(ticket: Ticket, value: string, people: TicketAgent[]) {
    if (value === "__unassigned__") {
      setHandoff({
        ticket,
        patch: { assignedToId: null },
        title: `Unassign #${ticket.number}`,
        audience: "The queue's admins are emailed and notified so someone picks it up.",
        confirmLabel: "Unassign",
        done: "Request unassigned",
      });
      return;
    }
    const [assignedToId, nextDepartmentId] = value.split("|");
    const who = people.find((a) => a.id === assignedToId)?.name ?? "them";
    const self = assignedToId === meId;
    if (!nextDepartmentId) {
      setHandoff({
        ticket,
        patch: { assignedToId },
        title: self ? `Take #${ticket.number}` : `Assign #${ticket.number} to ${who}`,
        audience: self
          ? "Nobody else is notified — the note just stays on the request for the team."
          : `${who} is emailed and notified.`,
        confirmLabel: self ? "Take it" : "Assign",
        done: self ? "You've taken this request" : `Assigned to ${who}`,
      });
      return;
    }
    const to =
      reassignDepartments.find((d) => d.id === nextDepartmentId)?.name ?? "their department";
    setHandoff({
      ticket,
      patch: { assignedToId, departmentId: nextDepartmentId },
      title: `Assign #${ticket.number} to ${who} and move to ${to}`,
      audience: `${who} is emailed and notified; the ${to} team sees it in their inbox.`,
      confirmLabel: "Assign and move",
      done: `Assigned to ${who} and moved to ${to}`,
    });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await api.admin.tickets.remove(deleteTarget.id);
    toast.success(`Request #${deleteTarget.number} deleted`);
    if (thread?.ticket.id === deleteTarget.id) select(null);
    setDeleteTarget(null);
    refreshInbox();
  }

  async function copyText(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  }

  // Assignees grouped by department; picking someone on another team moves the ticket to their queue, since a person can only hold a ticket in a queue they can see.
  const assigneeGroups = useMemo(
    () => groupAssignees(agents, thread?.ticket.department?.id ?? null, reassignDepartments),
    [agents, reassignDepartments, thread?.ticket.department?.id],
  );

  /** The tenants present in the current page, for the brand filter on lane `brand`. */
  const brandOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const t of tickets) if (t.brand) byId.set(t.brand.id, t.brand);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tickets]);

  const filtersActive =
    status !== DEFAULT_STATUS ||
    departmentId !== ANY_DEPARTMENT ||
    brandId !== ANY_BRAND ||
    assigned !== ASSIGNED_ANY ||
    priority !== "any" ||
    debouncedSearch !== "";

  // Empty-state copy depends on why: no queue for this role, no traffic yet, or filters matching nothing.
  const listEmpty: { title: string; body: string; action?: ReactNode } = (() => {
    if (stats?.departments === 0) {
      return {
        title: "No department yet",
        body: "Your role isn't assigned to a support department yet — ask an admin to add one.",
      };
    }
    if (stats && stats.total === 0) {
      return {
        title: "No requests yet",
        body:
          lane?.lane === "brand"
            ? "Requests your brands raise with the platform will appear here."
            : "Your customers' conversations will appear here as they arrive.",
      };
    }
    return {
      title: "No matching requests",
      body: "Try a different status, department or search term.",
      action: filtersActive ? (
        <Button variant="outline" className="mt-4" onClick={clearFilters}>
          Clear filters
        </Button>
      ) : undefined,
    };
  })();

  // Header uses the list row's data instantly; the fetch only fills in the messages.
  const headerTicket: Ticket | null =
    thread?.ticket ?? (selectedId ? (tickets.find((t) => t.id === selectedId) ?? null) : null);

  const allMessages = useMemo(
    () => (thread ? [...thread.messages, ...outbox.messages] : []),
    [thread, outbox.messages],
  );

  const visibleMessages = useMemo(() => {
    if (messageFilter === "notes") return allMessages.filter((m) => m.internal);
    // "Replies" is the requester's view of the thread: no notes, and none of the
    // system lines ("merged", "moved") that only narrate it.
    if (messageFilter === "replies") {
      return allMessages.filter((m) => !m.internal && m.authorType !== "system");
    }
    return allMessages;
  }, [allMessages, messageFilter]);

  /** The saved replies that fit this request — global ones and its queue's —
   *  with the blanks already filled from the thread. */
  const composerReplies = useMemo(() => {
    if (!thread) return [];
    const deptId = thread.ticket.department?.id ?? null;
    return savedReplies
      .filter((r) => r.department === null || r.department.id === deptId)
      .map((r) => ({
        id: r.id,
        title: r.department ? `${r.title} · ${r.department.name}` : r.title,
        body: fillSavedReply(r.body, thread.ticket, agentName),
      }));
  }, [savedReplies, thread, agentName]);

  /** Every file the requester or the team attached, for the sidebar. */
  const threadAttachments = useMemo(
    () => (thread ? thread.messages.flatMap((m) => m.attachments) : []),
    [thread],
  );

  if (notForYou) {
    return (
      <div>
        <PageHeader title="Support Tickets" subtitle="Handling requests" />
        <Card className="flex min-h-[20rem] flex-col items-center justify-center gap-3 p-8 text-center">
          <MessageSquareText className="size-10 text-muted-foreground/50" />
          <p className="text-base font-semibold">Not your inbox</p>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{notForYou}</p>
        </Card>
      </div>
    );
  }

  const copy = lane?.copy;
  const ratingsHref = adminHref("/dashboard/admin/tickets/ratings", role);

  return (
    <div>
      {/* Title and actions only while you're on the list. Inside a conversation
          they're dead space above the chat — the back arrow is the way out. */}
      {!selectedId && (
        <PageHeader
          title={copy?.inbox ?? "Support Tickets"}
          subtitle={
            lane?.lane === "brand"
              ? "Requests your brands have raised with the platform"
              : "Manage and respond to all customer requests"
          }
          actions={
            <>
              {isAdmin && (
                <Button variant="outline" onClick={() => setShowDepartments(true)}>
                  <Building2 className="size-4" /> Departments
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link to={ratingsHref}>
                  <Star className="size-4" /> Ratings
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setShowSavedReplies(true)}>
                <MessageSquareText className="size-4" /> Saved replies
              </Button>
              <Button
                variant="outline"
                onClick={() => void exportCsv()}
                disabled={exporting || loadingList || total === 0}
                title={
                  total === 0
                    ? "Nothing to export"
                    : "Download every request matching the current filters"
                }
              >
                {exporting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                Export CSV
              </Button>
              {canCreate && (
                <Button onClick={() => setShowNew(true)} disabled={!lane}>
                  <Plus className="size-4" /> New request
                </Button>
              )}
            </>
          }
        />
      )}

      {selectedId ? (
        // Thread view takes the whole width so the table isn't competing with it.
        <div
          className={cn(
            "grid gap-4 lg:items-start",
            (thread || loadingThread) && "lg:grid-cols-[minmax(0,1fr)_19rem]",
          )}
        >
          <Card className="flex h-[calc(100dvh-12rem)] min-h-[28rem] flex-col overflow-hidden">
            {!thread && !loadingThread ? (
              <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
                <InboxEmptyIllustration className="mb-6" />
                <p className="text-lg font-semibold">Couldn't open that request</p>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  It may have been deleted, or moved to a department you don't work.
                </p>
                <Button variant="outline" className="mt-4" onClick={() => select(null)}>
                  <ArrowLeft className="size-4" /> Back to requests
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
                      aria-label="Back to requests"
                      title="Back to requests"
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
                          <span className="font-mono">{headerTicket.reference}</span>
                          {/* Escalation's other half. On the platform lane it's never a link — the customer thread isn't reachable. */}
                          {headerTicket.escalation && (
                            <Link
                              to={`/dashboard/support?ticket=${headerTicket.escalation.id}`}
                              className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-tint px-2 py-0.5 text-[11px] font-medium text-warning hover:underline"
                              title="Escalated to the platform — open the linked request"
                            >
                              <ArrowUpRight className="size-3" /> Escalated ·{" "}
                              {headerTicket.escalation.reference}
                            </Link>
                          )}
                          {headerTicket.escalatedFrom && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium"
                              title={`Escalated from the brand's customer ticket #${headerTicket.escalatedFrom.number} — ${headerTicket.escalatedFrom.subject}`}
                            >
                              <ArrowUpRight className="size-3" /> From #
                              {headerTicket.escalatedFrom.number} ·{" "}
                              {headerTicket.escalatedFrom.requesterName}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <UserRound className="size-3" /> {headerTicket.requester.name}
                          </span>
                          <a
                            href={`mailto:${headerTicket.requester.email}`}
                            className="inline-flex items-center gap-1 hover:text-primary"
                          >
                            <Mail className="size-3" /> {headerTicket.requester.email}
                          </a>
                          {showBrandColumn && <TicketBrandBadge brand={headerTicket.brand} />}
                          <TicketPriorityBadge priority={headerTicket.priority} />
                          {/* What the requester thought, where the person about
                              to reply will actually see it. */}
                          {headerTicket.rating !== null && (
                            <span
                              title={
                                headerTicket.ratingComment
                                  ? `“${headerTicket.ratingComment}”`
                                  : `Rated ${headerTicket.rating}/5`
                              }
                            >
                              <StarRating value={headerTicket.rating} size="sm" />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {headerTicket && (
                      <div className="flex shrink-0 items-center gap-1">
                        {canEdit && thread && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setShowMerge(true)}
                            title="Merge another of this requester's threads into this one"
                          >
                            <GitMerge className="size-3.5" /> Merge
                          </Button>
                        )}
                        {/* Anyone on the brand's team who can edit — the request goes up in their name. */}
                        {canEdit &&
                          thread &&
                          lane?.lane === "support" &&
                          !headerTicket.escalation && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => setShowEscalate(true)}
                              title="Hand this to the platform — opens a linked request in your name"
                            >
                              <ArrowUpRight className="size-3.5" /> Escalate
                            </Button>
                          )}
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
                          <DropdownMenuContent align="end" className="min-w-[11rem]">
                            <DropdownMenuItem
                              className="gap-2"
                              onSelect={() =>
                                void copyText(headerTicket.reference, "Reference copied")
                              }
                            >
                              <Copy className="size-4" /> Copy reference
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2"
                              onSelect={() =>
                                void copyText(
                                  `${window.location.origin}${window.location.pathname}?ticket=${headerTicket.id}`,
                                  "Link copied",
                                )
                              }
                            >
                              <Link2 className="size-4" /> Copy link
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-danger hover:bg-danger-tint hover:text-danger"
                            onClick={() => thread && setDeleteTarget(thread.ticket)}
                            aria-label="Delete request"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </header>

                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <p className="text-sm font-medium">
                    Conversation
                    {thread && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {visibleMessages.length}
                        {messageFilter !== "all" && ` of ${allMessages.length}`}
                        {visibleMessages.length === 1 && messageFilter === "all"
                          ? " message"
                          : " messages"}
                      </span>
                    )}
                  </p>
                  <Select
                    value={messageFilter}
                    onValueChange={(v) => setMessageFilter(v as MessageFilter)}
                  >
                    <SelectTrigger className="h-8 w-[10.5rem] text-xs" aria-label="Show messages">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MESSAGE_FILTERS.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <TicketThread
                  className="min-h-0 flex-1"
                  messages={visibleMessages}
                  emptyHint={
                    messageFilter === "notes"
                      ? "No internal notes on this request yet."
                      : messageFilter === "replies"
                        ? "No replies yet."
                        : undefined
                  }
                  perspective="staff"
                  loading={loadingThread}
                  // The second tick appears once the requester has opened it.
                  otherReadAt={thread?.ticket.requesterReadAt}
                  typingLabel={typingLabel}
                  meId={meId}
                  // Pulling a requester's message (a card number, a screenshot
                  // they regret) is moderation, so it rides on `*.delete`.
                  canModerate={canDelete}
                  // Quoting and editing are both "the box is about that message",
                  // so starting one ends the other.
                  onReply={
                    canEdit
                      ? (m) => {
                          setEditing(null);
                          setReplyTo(m);
                        }
                      : undefined
                  }
                  onEdit={
                    canEdit
                      ? (m) => {
                          setReplyTo(null);
                          setEditing(m);
                        }
                      : undefined
                  }
                  onDelete={canEdit ? deleteMessage : undefined}
                  onReact={canEdit ? reactToMessage : undefined}
                  onRetry={outbox.retry}
                  onDiscard={outbox.discard}
                />

                <ChatComposer
                  onSend={sendReply}
                  optimistic
                  upload={(file, onProgress, signal) =>
                    api.admin.tickets.upload(file, onProgress, signal)
                  }
                  disabled={!canEdit}
                  disabledReason="Your role can view requests but not reply to them."
                  placeholder={`Reply to the ${copy?.requesterName ?? "requester"}…`}
                  internal={{ value: internalNote, onChange: setInternalNote }}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  savedReplies={composerReplies}
                  onManageSavedReplies={() => setShowSavedReplies(true)}
                  editing={editing}
                  onCancelEdit={() => setEditing(null)}
                  onSaveEdit={async (m, body) => {
                    await editMessage(m, body);
                    setEditing(null);
                  }}
                  onTyping={() => {
                    // An internal note isn't a conversation with the requester,
                    // so it must not tell them someone is typing to them.
                    if (thread && !internalNote) {
                      void api.admin.tickets.typing(thread.ticket.id).catch(() => {});
                    }
                  }}
                />
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
                    {canEdit
                      ? "Change the status, priority or who's on it."
                      : "Status, priority and who's on it."}
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
                      <DetailField label="Status" htmlFor={canEdit ? "ticket-status" : undefined}>
                        {canEdit ? (
                          <Select
                            value={thread.ticket.status}
                            onValueChange={(v) =>
                              void patchTicket(
                                { status: v as TicketStatus },
                                `Marked ${STATUS_LABEL_STAFF[v as TicketStatus].toLowerCase()}`,
                              )
                            }
                          >
                            <SelectTrigger id="ticket-status" className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(STATUS_LABEL_STAFF) as TicketStatus[]).map((s) => (
                                <SelectItem key={s} value={s}>
                                  <span className="flex items-center gap-2">
                                    <ToneDot className={STATUS_TONE[s].dot} />
                                    {STATUS_LABEL_STAFF[s]}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <TicketStatusBadge status={thread.ticket.status} staff />
                        )}
                      </DetailField>

                      <DetailField
                        label="Priority"
                        htmlFor={canEdit ? "ticket-priority" : undefined}
                      >
                        {canEdit ? (
                          <Select
                            value={thread.ticket.priority}
                            onValueChange={(v) =>
                              void patchTicket(
                                { priority: v as TicketPriority },
                                `Priority set to ${PRIORITY_LABEL[v as TicketPriority].toLowerCase()}`,
                              )
                            }
                          >
                            <SelectTrigger id="ticket-priority" className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => (
                                <SelectItem key={p} value={p}>
                                  <span className="flex items-center gap-2">
                                    <ToneDot className={PRIORITY_TONE[p].dot} />
                                    {PRIORITY_LABEL[p]} priority
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <TicketPriorityBadge priority={thread.ticket.priority} />
                        )}
                      </DetailField>

                      <DetailField
                        label="Department"
                        htmlFor={canEdit ? "ticket-department" : undefined}
                      >
                        {canEdit ? (
                          <Select
                            value={thread.ticket.department?.id ?? ""}
                            onValueChange={(v) => stageMove(thread.ticket, v)}
                          >
                            <SelectTrigger id="ticket-department" className="h-9 text-xs">
                              <SelectValue placeholder="No department" />
                            </SelectTrigger>
                            <SelectContent>
                              {reassignDepartments.map((d) => (
                                <SelectItem key={d.id} value={d.id}>
                                  {d.name}
                                  {!d.mine && (
                                    <span className="ml-1.5 text-muted-foreground">· hand off</span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-sm">{thread.ticket.department?.name ?? "None"}</p>
                        )}
                      </DetailField>

                      <DetailField
                        label="Assigned to"
                        htmlFor={canEdit ? "ticket-assignee" : undefined}
                      >
                        {canEdit ? (
                          <Select
                            value={thread.ticket.assignedTo?.id ?? "__unassigned__"}
                            onValueChange={(v) =>
                              v === ASSIGN_TO_PLATFORM
                                ? setShowEscalate(true)
                                : stageAssign(thread.ticket, v, agents)
                            }
                          >
                            <SelectTrigger id="ticket-assignee" className="h-9 text-xs">
                              <SelectValue placeholder="Unassigned" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__unassigned__">Unassigned</SelectItem>
                              <SelectGroup>
                                <SelectLabel>
                                  {thread.ticket.department
                                    ? `${thread.ticket.department.name} team`
                                    : "Can take this request"}
                                </SelectLabel>
                                {assigneeGroups.team.map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                  </SelectItem>
                                ))}
                                {/* Holder who left the team stays selectable so the trigger never goes blank.
                                    Id is checked, not asserted — a SelectItem with no value silently breaks the dropdown. */}
                                {thread.ticket.assignedTo?.id &&
                                  !assigneeGroups.team.some(
                                    (a) => a.id === thread.ticket.assignedTo?.id,
                                  ) && (
                                    <SelectItem value={thread.ticket.assignedTo.id}>
                                      {thread.ticket.assignedTo.name}
                                      <span className="ml-1.5 text-muted-foreground">
                                        · no longer on this team
                                      </span>
                                    </SelectItem>
                                  )}
                              </SelectGroup>
                              {assigneeGroups.others.map((g) => (
                                <SelectGroup key={g.department.id}>
                                  <SelectLabel>{g.department.name}</SelectLabel>
                                  {g.agents.map((a) => (
                                    <SelectItem key={a.id} value={`${a.id}|${g.department.id}`}>
                                      {a.name}
                                      <span className="ml-1.5 text-muted-foreground">
                                        · moves to {g.department.name}
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                              {/* A brand's team can hand any customer request, whatever its department, up to the
                                  super admin. The ticket stays here with its assignee; a linked request opens on the
                                  platform, so once escalated the entry only reports where it went. */}
                              {lane?.lane === "support" && (
                                <SelectGroup>
                                  <SelectLabel>Platform</SelectLabel>
                                  <SelectItem
                                    value={ASSIGN_TO_PLATFORM}
                                    disabled={!!thread.ticket.escalation}
                                  >
                                    Platform (super admin)
                                    <span className="ml-1.5 text-muted-foreground">
                                      {thread.ticket.escalation
                                        ? `· escalated as ${thread.ticket.escalation.reference}`
                                        : "· escalate"}
                                    </span>
                                  </SelectItem>
                                </SelectGroup>
                              )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-sm">
                            {thread.ticket.assignedTo?.name ?? "Unassigned"}
                          </p>
                        )}
                      </DetailField>
                    </div>

                    {/* A department is a shared queue — say so, or "assigned to Sam" reads as "only Sam can see it". */}
                    {thread.ticket.department && assigneeGroups.team.length > 0 && (
                      <p
                        className="flex items-start gap-1.5 border-t border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
                        title={assigneeGroups.team.map((a) => a.name).join(", ")}
                      >
                        <Users className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          Shared with the {thread.ticket.department.name} team —{" "}
                          {assigneeGroups.team.length}{" "}
                          {assigneeGroups.team.length === 1 ? "person sees" : "people see"} this
                          conversation
                          {thread.ticket.assignedTo
                            ? `, ${thread.ticket.assignedTo.name} is handling it`
                            : ", nobody has taken it yet"}
                          .
                        </span>
                      </p>
                    )}
                  </>
                )}
              </Card>

              {/* ---------------------------- Merged in --------------------- */}
              {thread && thread.merges && thread.merges.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <GitMerge className="size-4 text-primary" />
                      Merged into this request
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {thread.merges.length === 1
                        ? "One request was folded in. Its messages are in the conversation."
                        : `${thread.merges.length} requests were folded in. Their messages are in the conversation.`}
                    </p>
                  </div>
                  <ul className="divide-y divide-border">
                    {thread.merges.map((m) => {
                      const who = m.requesterName || thread.ticket.requester.name;
                      return (
                        <li key={m.id} className="flex items-start gap-3 px-4 py-3">
                          <TicketAvatar name={who} className="mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={m.subject}>
                              {m.subject}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {who} · <span className="font-mono">#{m.number}</span> · {m.reference}
                            </p>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {m.messageCount} {m.messageCount === 1 ? "message" : "messages"} ·
                              merged {timeAgo(m.mergedAt)}
                              {m.mergedBy && ` by ${m.mergedBy}`}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              {/* --------------------------- Requester ---------------------- */}
              {thread && (
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="text-sm font-semibold">
                      {lane?.lane === "brand" ? "Brand" : "Customer"}
                    </h3>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <TicketAvatar name={thread.ticket.requester.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{thread.ticket.requester.name}</p>
                      <button
                        type="button"
                        onClick={() => void copyText(thread.ticket.requester.email, "Email copied")}
                        className="block max-w-full truncate text-xs text-muted-foreground hover:text-foreground"
                        title="Copy email"
                      >
                        {thread.ticket.requester.email}
                      </button>
                    </div>
                    {/* On the platform's inbox the tenant is the useful hop —
                        open the brand, not the person. */}
                    {lane?.lane === "brand" && thread.ticket.brand && (
                      <Button variant="outline" size="icon" className="size-9 shrink-0" asChild>
                        <Link
                          to={`/superadmin/brands/${thread.ticket.brand.id}`}
                          aria-label={`Open ${thread.ticket.brand.name}`}
                          title={`Open ${thread.ticket.brand.name}`}
                        >
                          <Building2 className="size-4" />
                        </Link>
                      </Button>
                    )}
                    {lane?.lane === "support" && (
                      <Button variant="outline" size="icon" className="size-9 shrink-0" asChild>
                        <Link
                          to={adminHref(
                            `/dashboard/admin/customers/${thread.ticket.requester.id}`,
                            role,
                          )}
                          aria-label="Open customer"
                          title="Open customer"
                        >
                          <UserRound className="size-4" />
                        </Link>
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-border border-t border-border text-xs">
                    <div className="px-4 py-2.5">
                      <p className="text-muted-foreground">
                        {lane?.lane === "brand" ? "Brand" : "Raised by"}
                      </p>
                      <p className="mt-0.5 truncate font-medium">
                        {lane?.lane === "brand"
                          ? (thread.ticket.brand?.name ?? "Platform")
                          : thread.ticket.source === "admin"
                            ? "Your team"
                            : "Themselves"}
                      </p>
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
              {thread && threadAttachments.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <Paperclip className="size-4 text-muted-foreground" />
                      Attachments ({threadAttachments.length})
                    </h3>
                  </div>
                  <ul className="space-y-2 p-3">
                    {(allAttachments
                      ? threadAttachments
                      : threadAttachments.slice(0, ATTACHMENTS_PREVIEW)
                    ).map((f) => (
                      <li
                        key={f.id}
                        className="flex items-center gap-3 rounded-xl border border-border p-2"
                      >
                        {f.mime.startsWith("image/") ? (
                          <img src={f.url} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
                        ) : (
                          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <FileText className="size-5" />
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium" title={f.name}>
                            {f.name}
                          </p>
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
                  {threadAttachments.length > ATTACHMENTS_PREVIEW && (
                    <button
                      type="button"
                      onClick={() => setAllAttachments((v) => !v)}
                      className="flex w-full items-center justify-center gap-1 border-t border-border py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary-tint-soft"
                    >
                      {allAttachments ? (
                        <>
                          Show less <ChevronUp className="size-4" />
                        </>
                      ) : (
                        <>
                          See all {threadAttachments.length} <ChevronDown className="size-4" />
                        </>
                      )}
                    </button>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      ) : (
        /* ------------------------------- List ------------------------------ */
        <Card className="flex min-h-[24rem] flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-border p-4 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  showBrandColumn
                    ? "Search by subject, brand, or #number…"
                    : "Search by subject, customer, or #number…"
                }
                className="h-10 bg-muted/50 pl-10"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <SelectTrigger className={FILTER_TRIGGER} aria-label="Status">
                  <Circle className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={priority} onValueChange={(v) => setPriority(v as PriorityFilter)}>
                <SelectTrigger className={FILTER_TRIGGER} aria-label="Priority">
                  <Flag className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_FILTERS.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger className={FILTER_TRIGGER} aria-label="Department">
                  <LayoutGrid className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="All departments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_DEPARTMENT}>All departments</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Only where there is more than one tenant to choose between —
                  on a brand's own inbox every request is from the same one. */}
              {showBrandColumn && brandOptions.length > 1 && (
                <Select value={brandId} onValueChange={setBrandId}>
                  <SelectTrigger className={FILTER_TRIGGER} aria-label="Brand">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="All brands" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_BRAND}>All brands</SelectItem>
                    {brandOptions.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select value={assigned} onValueChange={setAssigned}>
                <SelectTrigger className={FILTER_TRIGGER} aria-label="Assigned to">
                  <UserRound className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="All assignees" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ASSIGNED_ANY}>All assignees</SelectItem>
                  <SelectItem value={ASSIGNED_ME}>Assigned to me</SelectItem>
                  <SelectItem value={ASSIGNED_NONE}>Unassigned</SelectItem>
                  {filterAgents.some((a) => a.id !== meId) && (
                    <SelectGroup>
                      <SelectLabel>
                        {departmentId === ANY_DEPARTMENT ? "Team" : "Team in this department"}
                      </SelectLabel>
                      {filterAgents
                        .filter((a) => a.id !== meId)
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <p className="text-sm text-muted-foreground">
              {loadingList ? "Loading…" : `${total} request${total === 1 ? "" : "s"}`}
              {stats && stats.unread > 0 && (
                <span className="ml-2 rounded-full bg-danger-tint px-2 py-0.5 text-[11px] font-semibold text-danger">
                  {stats.unread} unread
                </span>
              )}
            </p>
            <div className="flex items-center gap-1">
              {filtersActive && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
              <button
                type="button"
                onClick={() => void loadList()}
                className="ml-1 flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Refresh"
              >
                <RefreshCw className={cn("size-4", listPending && "animate-spin")} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {loadingList ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                <MailEmptyIllustration className="mb-5" />
                <p className="text-lg font-semibold">{listEmpty.title}</p>
                <p className="mt-1.5 max-w-[20rem] text-sm leading-relaxed text-muted-foreground">
                  {listEmpty.body}
                </p>
                {listEmpty.action}
              </div>
            ) : (
              <>
                {/* Desktop — table (md and up) */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="border-b border-border bg-muted/30 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">#</th>
                        <th className="px-4 py-3 font-medium">Request</th>
                        <th className="px-4 py-3 font-medium">
                          {showBrandColumn ? "Brand" : "Requester"}
                        </th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Priority</th>
                        <th className="px-4 py-3 font-medium">Department</th>
                        <th className="px-4 py-3 font-medium">Assigned to</th>
                        <th className="px-4 py-3 text-right font-medium">Last activity</th>
                        <th className="px-2 py-3">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.map((t) => (
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
                          <td className="max-w-[26rem] px-4 py-5">
                            <div className="flex items-start gap-3">
                              <TicketTile ticket={t} unread={t.unreadForStaff} className="mt-0.5" />
                              <div className="min-w-0">
                                <p
                                  className={cn(
                                    "truncate text-[15px] leading-tight",
                                    t.unreadForStaff ? "font-bold" : "font-semibold",
                                  )}
                                >
                                  {t.subject}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {t.lastMessage || "No messages"}
                                </p>
                                <span className="mt-1.5 inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                  {t.reference}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="max-w-[16rem] px-4 py-5">
                            {showBrandColumn ? (
                              <div className="min-w-0">
                                <p className="truncate font-medium">
                                  {t.brand?.name ?? "Platform"}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {t.requester.name}
                                </p>
                              </div>
                            ) : (
                              <div className="flex items-center gap-3">
                                <TicketAvatar name={t.requester.name} size="md" />
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{t.requester.name}</p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {t.requester.email}
                                  </p>
                                </div>
                              </div>
                            )}
                          </td>
                          {/* Inline pickers for editors. Each cell stops propagation so the row click doesn't open the ticket. */}
                          <td
                            className="whitespace-nowrap px-4 py-5"
                            onClick={canEdit ? stopRowClick : undefined}
                            onKeyDown={canEdit ? stopRowClick : undefined}
                          >
                            {canEdit ? (
                              <RowPicker
                                name={`Status of #${t.number}`}
                                label={<TicketStatusDot status={t.status} staff />}
                                className={STATUS_WASH[t.status]}
                              >
                                <MenuTitle>Set status</MenuTitle>
                                {(Object.keys(STATUS_LABEL_STAFF) as TicketStatus[]).map((s) => (
                                  <MenuOption
                                    key={s}
                                    icon={<ToneDot className={STATUS_TONE[s].dot} />}
                                    tone={STATUS_TONE[s].tile}
                                    label={STATUS_LABEL_STAFF[s]}
                                    hint={STATUS_HINT_STAFF[s]}
                                    selected={s === t.status}
                                    onSelect={() =>
                                      s !== t.status &&
                                      void patchRow(
                                        t,
                                        { status: s },
                                        `Marked ${STATUS_LABEL_STAFF[s].toLowerCase()}`,
                                      )
                                    }
                                  />
                                ))}
                              </RowPicker>
                            ) : (
                              <TicketStatusDot status={t.status} staff />
                            )}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-5"
                            onClick={canEdit ? stopRowClick : undefined}
                            onKeyDown={canEdit ? stopRowClick : undefined}
                          >
                            {canEdit ? (
                              <RowPicker
                                name={`Priority of #${t.number}`}
                                label={<TicketPriorityBadge priority={t.priority} />}
                              >
                                <MenuTitle>Set priority</MenuTitle>
                                {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => (
                                  <MenuOption
                                    key={p}
                                    icon={<ToneDot className={PRIORITY_TONE[p].dot} />}
                                    tone={PRIORITY_TONE[p].tile}
                                    label={PRIORITY_LABEL[p]}
                                    hint={PRIORITY_HINT[p]}
                                    selected={p === t.priority}
                                    onSelect={() =>
                                      p !== t.priority &&
                                      void patchRow(
                                        t,
                                        { priority: p },
                                        `Priority set to ${PRIORITY_LABEL[p].toLowerCase()}`,
                                      )
                                    }
                                  />
                                ))}
                              </RowPicker>
                            ) : (
                              <TicketPriorityBadge priority={t.priority} />
                            )}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-5 text-muted-foreground"
                            onClick={canEdit ? stopRowClick : undefined}
                            onKeyDown={canEdit ? stopRowClick : undefined}
                          >
                            {canEdit ? (
                              <RowPicker
                                name={`Department of #${t.number}`}
                                label={<span>{t.department?.name ?? "—"}</span>}
                              >
                                <MenuTitle>Move to department</MenuTitle>
                                {reassignDepartments.map((d) => (
                                  <MenuOption
                                    key={d.id}
                                    icon={
                                      d.mine ? (
                                        <Building2 className="size-4" />
                                      ) : (
                                        <ArrowRightLeft className="size-4" />
                                      )
                                    }
                                    tone={
                                      d.id === t.department?.id
                                        ? "bg-primary-tint text-primary"
                                        : d.mine
                                          ? "bg-muted text-foreground"
                                          : "bg-muted text-muted-foreground"
                                    }
                                    label={d.name}
                                    hint={
                                      d.id === t.department?.id
                                        ? "Where it is now"
                                        : d.mine
                                          ? "A queue you work"
                                          : "Hand off — leaves your inbox"
                                    }
                                    selected={d.id === t.department?.id}
                                    onSelect={() =>
                                      d.id !== t.department?.id && stageMove(t, d.id)
                                    }
                                  />
                                ))}
                              </RowPicker>
                            ) : (
                              (t.department?.name ?? "—")
                            )}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-5 text-muted-foreground"
                            onClick={canEdit ? stopRowClick : undefined}
                            onKeyDown={canEdit ? stopRowClick : undefined}
                          >
                            {canEdit ? (
                              <RowPicker
                                name={`Assignee of #${t.number}`}
                                className={t.assignedTo ? "pl-1.5" : undefined}
                                label={
                                  t.assignedTo ? (
                                    <span className="flex items-center gap-2">
                                      <TicketAvatar name={t.assignedTo.name} size="sm" />
                                      <span className="truncate">{t.assignedTo.name}</span>
                                    </span>
                                  ) : (
                                    <span>Unassigned</span>
                                  )
                                }
                              >
                                <AssigneeMenuItems
                                  ticket={t}
                                  people={filterAgents}
                                  departments={reassignDepartments}
                                  onPick={(value) => stageAssign(t, value, filterAgents)}
                                />
                              </RowPicker>
                            ) : t.assignedTo ? (
                              <span className="flex items-center gap-2">
                                <TicketAvatar name={t.assignedTo.name} size="sm" />
                                <span className="truncate">{t.assignedTo.name}</span>
                              </span>
                            ) : (
                              "Unassigned"
                            )}
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
                                  onSelect={() => void copyText(t.reference, "Reference copied")}
                                />
                                {canDelete && (
                                  <>
                                    <DropdownMenuSeparator className="my-1.5" />
                                    <MenuOption
                                      icon={<Trash2 className="size-4" />}
                                      label="Delete request"
                                      hint="Gone for the requester too"
                                      destructive
                                      onSelect={() => setDeleteTarget(t)}
                                    />
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile — compact list (below md) */}
                <ul className="space-y-1 p-2 md:hidden">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => select(t.id)}
                        className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/60"
                      >
                        <TicketAvatar name={t.requester.name} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p
                              className={cn(
                                "line-clamp-1 text-[15px]",
                                t.unreadForStaff ? "font-bold" : "font-semibold",
                              )}
                            >
                              <span className="mr-1.5 font-mono text-xs font-normal text-muted-foreground">
                                #{t.number}
                              </span>
                              {t.subject}
                            </p>
                            {t.unreadForStaff && <NewMessageDot inline className="mt-1.5" />}
                          </div>
                          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                            {showBrandColumn && t.brand ? `${t.brand.name} · ` : ""}
                            {t.requester.name} • {t.lastMessage || "No messages"}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <TicketStatusBadge status={t.status} staff />
                            {t.department && (
                              <Badge variant="outline" className="bg-card text-[11px]">
                                {t.department.name}
                              </Badge>
                            )}
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {timeAgo(t.lastMessageAt)}
                            </span>
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {!loadingList && total > 0 && (
            <div className="border-t border-border px-4 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                noun="requests"
                disabled={listPending}
              />
            </div>
          )}
        </Card>
      )}

      {isAdmin && lane && (
        <DepartmentsDialog
          open={showDepartments}
          onOpenChange={setShowDepartments}
          lane={lane}
          onChanged={() => {
            api.admin.tickets.departments.list().then(setDepartments).catch(() => {});
            api.admin.tickets.departments.list("all").then(setAllDepartments).catch(() => {});
            refreshInbox();
          }}
        />
      )}

      {canCreate && lane && (
        <NewTicketDialog
          open={showNew}
          onOpenChange={setShowNew}
          lane={lane}
          departments={departments}
          onManageDepartments={
            isAdmin
              ? () => {
                  setShowNew(false);
                  setShowDepartments(true);
                }
              : undefined
          }
          onCreated={(ticket) => {
            setShowNew(false);
            refreshInbox();
            select(ticket.id);
          }}
        />
      )}

      {canEdit && thread && (
        <MergeTicketDialog
          open={showMerge}
          onOpenChange={setShowMerge}
          ticket={thread.ticket}
          onMerged={(merged) => {
            // The header can update at once; the messages that moved in arrive
            // with the re-read, and the table loses the merged row.
            setThread((prev) => (prev ? { ...prev, ticket: merged } : prev));
            void loadThread(merged.id, false);
            refreshInbox();
          }}
        />
      )}

      {canEdit && thread && lane?.lane === "support" && (
        <EscalateTicketDialog
          open={showEscalate}
          onOpenChange={setShowEscalate}
          ticket={thread.ticket}
          onEscalated={({ ticket }) => {
            // The header shows the link at once; the internal note the server
            // added to the thread arrives with the re-read.
            setThread((prev) => (prev ? { ...prev, ticket } : prev));
            void loadThread(ticket.id, false);
          }}
        />
      )}

      <SavedRepliesDialog
        open={showSavedReplies}
        onOpenChange={setShowSavedReplies}
        departments={departments}
        canEdit={canEdit}
        isAdmin={isAdmin}
        onChanged={() => void loadSavedReplies()}
      />

      {/* The note that travels with a reassignment or a move — see `handoff`. */}
      <HandoffNoteDialog
        open={handoff !== null}
        onOpenChange={(o) => !o && setHandoff(null)}
        title={handoff?.title ?? ""}
        audience={handoff?.audience ?? ""}
        confirmLabel={handoff?.confirmLabel ?? "Confirm"}
        onConfirm={async (note) => {
          if (!handoff) return;
          const { ticket, patch, done } = handoff;
          if (thread?.ticket.id === ticket.id) {
            const stillOpen = await patchTicket({ ...patch, note }, done);
            setHandoff(null);
            // The hand-over line the server wrote is on the request now; pull it
            // in rather than wait for the next live tick.
            if (stillOpen) void loadThread(ticket.id, false);
          } else {
            await patchRow(ticket, { ...patch, note }, done);
            setHandoff(null);
          }
        }}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        resourceType="request"
        resourceName={deleteTarget?.reference ?? ""}
        onConfirm={confirmDelete}
        description="The conversation and every file attached to it will be permanently removed."
      />
    </div>
  );
}

/** One labelled row in the details card. `htmlFor` only when there's a control. */
function DetailField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** A click inside an editable cell must not also open the request under it. */
function stopRowClick(e: SyntheticEvent) {
  e.stopPropagation();
}

// Split assignees into the ticket's team vs others by department. Admins work every queue so they always sit on the team.
function groupAssignees(
  people: TicketAgent[],
  currentDepartmentId: string | null,
  departments: { id: string; name: string }[],
) {
  const onTeam = (a: TicketAgent) =>
    isAdminRole(a.role) ||
    isSuperAdminRole(a.role) ||
    (currentDepartmentId !== null && a.departments.some((d) => d.id === currentDepartmentId));
  const team = people.filter(onTeam);
  const others = departments
    .filter((d) => d.id !== currentDepartmentId)
    .map((d) => ({
      department: d,
      agents: people.filter((a) => !onTeam(a) && a.departments.some((x) => x.id === d.id)),
    }))
    .filter((g) => g.agents.length > 0);
  return { team, others };
}

// In-place table cell picker, styled as a select so it reads as openable rather than plain text.
function RowPicker({
  name,
  label,
  children,
  className,
}: {
  /** The accessible name — the cell's text alone doesn't say what it changes. */
  name: string;
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={name}
          className={cn(
            "inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-left text-sm text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/40 data-[state=open]:border-primary data-[state=open]:bg-muted/40",
            className,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-[16rem] overflow-y-auto rounded-xl p-1.5"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A group heading inside a picker menu. */
function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

// Assignee menu items. `onPick` gets "__unassigned__", an agent id, or "<agent>|<department>" for another team.
function AssigneeMenuItems({
  ticket,
  people,
  departments,
  onPick,
}: {
  ticket: Ticket;
  people: TicketAgent[];
  departments: { id: string; name: string }[];
  onPick: (value: string) => void;
}) {
  const groups = groupAssignees(people, ticket.department?.id ?? null, departments);
  const current = ticket.assignedTo?.id ?? null;
  return (
    <>
      <DropdownMenuItem
        className="justify-between"
        onSelect={() => current !== null && onPick("__unassigned__")}
      >
        Unassigned
        {current === null && <Check className="text-primary" />}
      </DropdownMenuItem>
      <MenuHeading>
        {ticket.department ? `${ticket.department.name} team` : "Can take this request"}
      </MenuHeading>
      {groups.team.length === 0 && (
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">Nobody works this queue yet.</p>
      )}
      {groups.team.map((a) => (
        <DropdownMenuItem
          key={a.id}
          className="justify-between"
          onSelect={() => a.id !== current && onPick(a.id)}
        >
          {a.name}
          {a.id === current && <Check className="text-primary" />}
        </DropdownMenuItem>
      ))}
      {groups.others.map((g) => (
        <Fragment key={g.department.id}>
          <DropdownMenuSeparator />
          <MenuHeading>{g.department.name}</MenuHeading>
          {g.agents.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => onPick(`${a.id}|${g.department.id}`)}>
              {a.name}
              <span className="text-muted-foreground">· moves to {g.department.name}</span>
            </DropdownMenuItem>
          ))}
        </Fragment>
      ))}
    </>
  );
}
