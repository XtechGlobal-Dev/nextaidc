import type { AppNotification, NotificationType } from "@/stores/useNotificationStore";

/* ------------------------------------------------------------------ *
 *  Notification panel helpers — pure functions, so the grouping, filter
 *  and timestamp rules can be unit-tested without a DOM.
 * ------------------------------------------------------------------ */

/** Filter chips above the list. `calls` has two narrower sub-filters reachable
 *  from its dropdown (Missed / Handled), mirroring how the chip reads in the UI. */
export type NotificationFilter =
  | "all"
  | "calls"
  | "missed"
  | "handled"
  | "tickets"
  | "billing"
  | "system";

const FILTER_TYPES: Record<Exclude<NotificationFilter, "all">, readonly NotificationType[]> = {
  calls: ["missed_call", "new_lead"],
  missed: ["missed_call"],
  handled: ["new_lead"],
  // Support requests on either lane. One chip, because a person only ever
  // holds one side of one conversation — a customer never sees a brand's
  // requests, and the platform owner never sees a customer's.
  tickets: ["ticket"],
  billing: ["billing"],
  // "System" covers platform notices and the AI-agent lifecycle (welcome,
  // provisioned, live) — neither is something the customer did themselves.
  system: ["system", "agent"],
};

export const CALL_FILTERS: ReadonlySet<NotificationFilter> = new Set<NotificationFilter>([
  "calls",
  "missed",
  "handled",
]);

export function matchesFilter(n: Pick<AppNotification, "type">, filter: NotificationFilter): boolean {
  if (filter === "all") return true;
  return FILTER_TYPES[filter].includes(n.type);
}

export function filterNotifications<T extends Pick<AppNotification, "type">>(
  list: readonly T[],
  filter: NotificationFilter,
): T[] {
  if (filter === "all") return [...list];
  return list.filter((n) => matchesFilter(n, filter));
}

export type NotificationGroupKey = "today" | "yesterday" | "earlier";

export const GROUP_LABEL: Record<NotificationGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

const GROUP_ORDER: readonly NotificationGroupKey[] = ["today", "yesterday", "earlier"];

/** Local-calendar-day boundary. Built from Y/M/D (not `now - 24h`) so a DST
 *  change never shifts "yesterday" by an hour. */
function dayStart(d: Date, offsetDays = 0): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
}

export function groupKeyFor(iso: string, now: Date = new Date()): NotificationGroupKey {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "earlier";
  // Anything at or after today's midnight is "today" — including a timestamp
  // slightly in the future from clock skew between the server and the browser.
  if (at >= dayStart(now)) return "today";
  if (at >= dayStart(now, -1)) return "yesterday";
  return "earlier";
}

export interface NotificationGroup<T> {
  key: NotificationGroupKey;
  label: string;
  items: T[];
}

/** Bucket a newest-first list into Today / Yesterday / Earlier, dropping empty
 *  groups. Input order is preserved within each group. */
export function groupNotifications<T extends Pick<AppNotification, "createdAt">>(
  list: readonly T[],
  now: Date = new Date(),
): NotificationGroup<T>[] {
  const buckets: Record<NotificationGroupKey, T[]> = { today: [], yesterday: [], earlier: [] };
  for (const n of list) buckets[groupKeyFor(n.createdAt, now)].push(n);
  return GROUP_ORDER.filter((k) => buckets[k].length > 0).map((k) => ({
    key: k,
    label: GROUP_LABEL[k],
    items: buckets[k],
  }));
}

/**
 * Timestamp as the panel shows it: "10:30 AM" for today, "Yesterday, 04:45 PM",
 * then "Aug 29, 11:05 AM" (the year is added once it's no longer this year).
 */
export function formatNotificationTime(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Some ICU builds put a narrow no-break space before AM/PM — normalise so the
  // label wraps and renders the same everywhere.
  const time = d
    .toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    .replace(/ /g, " ");
  const key = groupKeyFor(iso, now);
  if (key === "today") return time;
  if (key === "yesterday") return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}
