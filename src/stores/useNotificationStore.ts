import { create } from "zustand";
import { toast } from "sonner";
import { api, type ApiNotification, type NotificationType } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";
import { useCallsStore } from "@/stores/useCallsStore";

// Call notifications (handled + missed) are the only ones that deep-link here —
// used to detect a fresh call and live-refresh the Call Logs without a reload.
const CALLS_LINK = "/dashboard/calls";

/* ------------------------------------------------------------------ *
 *  Where a ticket notification points.
 *
 *  Three ticket surfaces, and every ticket notification links to
 *  exactly one of them — the server decides which when it writes the
 *  row, so the client never has to work out whose news this is:
 *
 *    /dashboard/support        the requester's own page (either lane)
 *    /dashboard/admin/tickets  a brand admin's customer inbox
 *    /superadmin/tickets       the platform owner's brand-request inbox
 * ------------------------------------------------------------------ */
const REQUESTER_TICKETS_PATH = "/dashboard/support";
const SUPPORT_INBOX_PATH = "/dashboard/admin/tickets";
const BRAND_INBOX_PATH = "/superadmin/tickets";

/** The ticket a notification deep-links to (`…?ticket=<id>`), if any. */
export function ticketIdFromLink(link?: string | null): string | null {
  if (!link) return null;
  const q = link.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(link.slice(q + 1)).get("ticket") || null;
}

/** Unread ticket updates, split by the nav entry each one belongs to. */
export interface UnreadTicketCounts {
  /** "My requests" — a customer's, or a brand admin's to the platform. */
  requester: number;
  /** A brand admin's or staff member's customer inbox. */
  supportInbox: number;
  /** The platform owner's brand-request inbox. */
  brandInbox: number;
}

export function unreadTicketCounts(
  notifications: readonly Pick<AppNotification, "read" | "type" | "link">[],
): UnreadTicketCounts {
  const counts: UnreadTicketCounts = { requester: 0, supportInbox: 0, brandInbox: 0 };
  for (const n of notifications) {
    if (n.read || n.type !== "ticket") continue;
    if (n.link?.startsWith(BRAND_INBOX_PATH)) counts.brandInbox += 1;
    else if (n.link?.startsWith(SUPPORT_INBOX_PATH)) counts.supportInbox += 1;
    else if (n.link?.startsWith(REQUESTER_TICKETS_PATH)) counts.requester += 1;
  }
  return counts;
}

// Skip toasting on the very first hydrate — the initial backlog isn't "new".
// Module-level so it survives the poll hook remounting on navigation.
let hydratedOnce = false;
// Cap toasts per poll so a burst that arrived between polls can't flood the screen.
const MAX_TOASTS_PER_POLL = 3;

export type { NotificationType };

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  link?: string;
}

interface NotificationState {
  notifications: AppNotification[];
  unreadCount: number;
  /** False until the first successful fetch — lets the panel show a loading
   *  skeleton instead of "No notifications yet" on a cold load. */
  hydrated: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /**
   * The ticket conversation open on screen right now, else null.
   *
   * Anything new about it is treated as SEEN — marked read rather than toasted,
   * since the reply is already on screen in front of the reader. Set by
   * {@link useActiveTicketThread}.
   */
  activeThreadId: string | null;
  setActiveThread: (ticketId: string | null) => void;
  /** Mark every unread notification about one ticket read — its thread is open. */
  markThreadRead: (ticketId: string) => void;
  /** Pull the latest notifications + unread count from the backend. */
  hydrate: () => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

function fromApi(n: ApiNotification): AppNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt,
    link: n.link ?? undefined,
  };
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  hydrated: false,
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  activeThreadId: null,
  setActiveThread: (ticketId) => set({ activeThreadId: ticketId }),
  markThreadRead: (ticketId) => {
    const ids = get()
      .notifications.filter((n) => !n.read && ticketIdFromLink(n.link) === ticketId)
      .map((n) => n.id);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const notifications = get().notifications.map((n) =>
      idSet.has(n.id) ? { ...n, read: true } : n,
    );
    set({ notifications, unreadCount: notifications.filter((n) => !n.read).length });
    for (const id of ids) void api.notifications.markRead(id).catch(() => {});
  },
  hydrate: async () => {
    const mark = sessionMark();
    try {
      const { notifications, unreadCount } = await api.notifications.list();
      if (sessionChanged(mark)) return; // response belongs to a previous account
      const incoming = notifications.map(fromApi);

      // A conversation that is open AND on screen counts as seen: anything
      // unread about it is marked read instead of toasting what the reader is
      // already looking at. A hidden tab isn't "seen", so those still surface.
      const activeThread = get().activeThreadId;
      const threadOnScreen =
        !!activeThread &&
        (typeof document === "undefined" || document.visibilityState !== "hidden");
      const seenInThread = new Set(
        threadOnScreen
          ? incoming
              .filter((n) => !n.read && ticketIdFromLink(n.link) === activeThread)
              .map((n) => n.id)
          : [],
      );
      const merged = seenInThread.size
        ? incoming.map((n) => (seenInThread.has(n.id) ? { ...n, read: true } : n))
        : incoming;

      // Surface anything that arrived since the last poll as a live toast (e.g. a
      // new signup landing under onboarding), so an admin doesn't have to open the
      // bell to notice it. Only after the first hydrate — the initial list isn't new.
      if (hydratedOnce) {
        const seen = new Set(get().notifications.map((n) => n.id));
        const fresh = incoming.filter(
          (n) => !n.read && !seen.has(n.id) && !seenInThread.has(n.id),
        );
        for (const n of fresh.slice(0, MAX_TOASTS_PER_POLL)) {
          // Purely informational — the notification bell in the header already
          // lists everything, so a toast action would just be a redundant click.
          toast(n.title, { description: n.message || undefined });
        }
        // A new call just landed (its notification links to the Call Logs) →
        // refresh the calls store so the row appears live, no manual reload.
        if (fresh.some((n) => n.link === CALLS_LINK)) {
          void useCallsStore.getState().hydrate();
        }
      }
      hydratedOnce = true;
      for (const id of seenInThread) void api.notifications.markRead(id).catch(() => {});
      set({
        notifications: merged,
        unreadCount: Math.max(0, unreadCount - seenInThread.size),
        hydrated: true,
      });
    } catch {
      /* leave the last good state on a transient failure */
    }
  },
  markRead: (id) => {
    const notifications = get().notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    set({ notifications, unreadCount: notifications.filter((n) => !n.read).length });
    void api.notifications.markRead(id).catch(() => {});
  },
  markAllRead: () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    void api.notifications.markAllRead().catch(() => {});
  },
  clearAll: () => {
    set({ notifications: [], unreadCount: 0 });
    void api.notifications.clear().catch(() => {});
  },
}));
