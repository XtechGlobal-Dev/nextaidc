import * as React from "react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  BellOff,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CreditCard,
  LifeBuoy,
  PhoneIncoming,
  PhoneMissed,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { adminHref } from "@/lib/onboardingRoute";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/stores/useAuthStore";
import {
  useNotificationStore,
  type AppNotification,
  type NotificationType,
} from "@/stores/useNotificationStore";
import {
  CALL_FILTERS,
  formatNotificationTime,
  groupNotifications,
  type NotificationFilter,
} from "./notificationGroups";

/* ------------------------------------------------------------------ *
 *  Shared building blocks for the notifications slide-over and the
 *  "View all" page: the per-type icon, the filter chips, the grouped
 *  list, and the click handler that opens a notification's deep link.
 * ------------------------------------------------------------------ */

/* Per-type icon in a soft tinted circle — the same treatment everywhere, so a
 * missed call always reads red, billing amber, a system notice blue. */
const TYPE_META: Record<
  NotificationType,
  { icon: React.ComponentType<{ className?: string }>; badge: string }
> = {
  missed_call: { icon: PhoneMissed, badge: "bg-danger-tint text-danger" },
  new_lead: { icon: PhoneIncoming, badge: "bg-success-tint text-success" },
  billing: { icon: CreditCard, badge: "bg-warning-tint text-warning" },
  agent: { icon: BrainCircuit, badge: "bg-violet-500/12 text-violet-600 dark:text-violet-400" },
  // Support tickets on either lane — a customer asking their brand, or a brand
  // asking the platform. One look for both: which inbox it opens is in the link.
  ticket: { icon: LifeBuoy, badge: "bg-step-2/12 text-step-2" },
  system: { icon: Bell, badge: "bg-primary-tint text-primary" },
};

export function NotificationTypeIcon({
  type,
  className,
}: {
  type: NotificationType;
  className?: string;
}) {
  // The server stores `type` as a free string — fall back to the system look
  // rather than crash on a type this build doesn't know yet.
  const meta = TYPE_META[type] ?? TYPE_META.system;
  const Icon = meta.icon;
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", meta.badge, className)}>
      <Icon className="size-4" />
    </span>
  );
}

/* ---------- Filter chips ---------- */

const CALL_OPTIONS: { value: NotificationFilter; label: string }[] = [
  { value: "calls", label: "All calls" },
  { value: "missed", label: "Missed" },
  { value: "handled", label: "Handled" },
];

const Chip = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
>(({ active, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3.5 text-xs font-medium transition-colors focus-visible:focus-ring",
      active
        ? "bg-primary text-primary-foreground shadow-sm"
        : "border border-border bg-card text-foreground/80 hover:bg-muted hover:text-foreground",
      className,
    )}
    {...props}
  />
));
Chip.displayName = "Chip";

export function NotificationFilterChips({
  value,
  onChange,
  className,
}: {
  value: NotificationFilter;
  onChange: (filter: NotificationFilter) => void;
  className?: string;
}) {
  const callsActive = CALL_FILTERS.has(value);
  // The chip names the active sub-filter ("Missed") so it's obvious the list
  // is narrowed; plain "Calls" otherwise.
  const callsLabel =
    (value !== "calls" && CALL_OPTIONS.find((o) => o.value === value)?.label) || "Calls";

  return (
    <div
      role="group"
      aria-label="Filter notifications"
      className={cn("flex items-center gap-2 overflow-x-auto", className)}
    >
      <Chip active={value === "all"} aria-pressed={value === "all"} onClick={() => onChange("all")}>
        All
      </Chip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip active={callsActive}>
            {callsLabel}
            <ChevronDown className="size-3.5 opacity-70" />
          </Chip>
        </DropdownMenuTrigger>
        {/* Above the slide-over (z-50) — the menu is portalled, not nested. */}
        <DropdownMenuContent align="start" className="z-60">
          {CALL_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onSelect={() => onChange(o.value)}
              className={cn(value === o.value && "font-semibold text-primary")}
            >
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Chip
        active={value === "tickets"}
        aria-pressed={value === "tickets"}
        onClick={() => onChange("tickets")}
      >
        Tickets
      </Chip>
      <Chip
        active={value === "billing"}
        aria-pressed={value === "billing"}
        onClick={() => onChange("billing")}
      >
        Billing
      </Chip>
      <Chip
        active={value === "system"}
        aria-pressed={value === "system"}
        onClick={() => onChange("system")}
      >
        System
      </Chip>
    </div>
  );
}

/* ---------- Opening a notification ---------- */

/**
 * Mark a notification read and follow its deep link. Admin links are written
 * as `/dashboard/admin/...`; the platform owner's admin pages live under
 * `/superadmin`, so rewrite onto their base (a no-op for everyone else).
 */
export function useOpenNotification() {
  const navigate = useNavigate();
  const role = useAuthStore((s) => s.user?.role);
  const markRead = useNotificationStore((s) => s.markRead);
  return useCallback(
    (n: AppNotification) => {
      if (!n.read) markRead(n.id);
      if (n.link) {
        navigate(n.link.startsWith("/dashboard/admin") ? adminHref(n.link, role) : n.link);
      }
    },
    [navigate, role, markRead],
  );
}

/* ---------- Grouped list ---------- */

function NotificationRow({
  n,
  onSelect,
}: {
  n: AppNotification;
  onSelect: (n: AppNotification) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(n)}
      className="group flex w-full items-center gap-3 rounded-xl bg-muted/60 p-3 text-left transition-colors hover:bg-muted"
    >
      <NotificationTypeIcon type={n.type} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[13px] leading-snug",
            n.read ? "font-medium text-foreground/85" : "font-semibold",
          )}
        >
          {n.title}
        </p>
        {n.message && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.message}</p>}
        <p className="mt-1 text-[11px] text-muted-foreground/70">{formatNotificationTime(n.createdAt)}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        {!n.read && (
          <>
            <span className="size-2 rounded-full bg-primary" />
            <span className="sr-only">Unread</span>
          </>
        )}
        <ChevronRight className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/** Placeholder rows for the first fetch, so a cold open doesn't flash the
 *  empty state before the backlog arrives. Same shape as a real row. */
export function NotificationListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading notifications">
      <Skeleton className="mb-2 ml-1 h-3 w-12" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl bg-muted/40 p-3">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY_HINT: Record<NotificationFilter, string> = {
  all: "Calls, support replies, billing updates and system notices show up here.",
  calls: "No call notifications yet.",
  missed: "No missed calls — nice.",
  handled: "No handled calls yet.",
  tickets: "No support activity yet.",
  billing: "No billing notifications.",
  system: "No system notices.",
};

export function NotificationList({
  notifications,
  filter = "all",
  emptyTitle,
  onSelect,
}: {
  notifications: AppNotification[];
  filter?: NotificationFilter;
  emptyTitle: string;
  onSelect: (n: AppNotification) => void;
}) {
  const groups = useMemo(() => groupNotifications(notifications), [notifications]);

  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-muted">
          <BellOff className="size-5 text-muted-foreground/60" />
        </span>
        <p className="mt-3 text-sm font-medium">{emptyTitle}</p>
        <p className="mt-1 max-w-55 text-xs text-muted-foreground">{EMPTY_HINT[filter]}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h4 className="mb-2 px-1 text-xs font-semibold text-muted-foreground">{g.label}</h4>
          <ul className="flex flex-col gap-2">
            {g.items.map((n) => (
              <li key={n.id}>
                <NotificationRow n={n} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
