import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CalendarClock,
  ChevronRight,
  Clock,
  CreditCard,
  DollarSign,
  Download,
  ExternalLink,
  History,
  Loader2,
  Mail,
  Receipt,
  RefreshCw,
  Repeat,
  Rocket,
  Search,
  TrendingUp,
  Ticket,
  Undo2,
  UserPlus,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DataCard,
  DataCardAvatar,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import {
  api,
  ApiError,
  type AdminSubscriptionDetail,
  type AdminSubscriptionRow,
  type AdminSubscriptionsSummary,
  type PlanEventType,
} from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { cn, formatDate, formatDateDMY } from "@/lib/utils";
import { toCsv, downloadCsv, datedCsvName, type CsvColumn } from "@/lib/csv";
import { intervalLabel } from "@/lib/billingInterval";
import { env } from "@/lib/env";

/**
 * Column-level visibility for the Subscriptions table (allow-list). ADMINs pass
 * every check; STAFF see a column only when their role grants the matching
 * `subscriptions.field.*` permission. The Customer (identity) column always shows.
 */
function useSubscriptionColumns() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  return {
    plan: hasPermission("subscriptions.field.plan"),
    price: hasPermission("subscriptions.field.price"),
    status: hasPermission("subscriptions.field.status"),
    minutes: hasPermission("subscriptions.field.minutes"),
    renewal: hasPermission("subscriptions.field.renewal"),
    autoRenew: hasPermission("subscriptions.field.autoRenew"),
    invoices: hasPermission("subscriptions.field.invoices"),
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Same stable per-plan colour hashing as AdminCustomersPage so plan tiers look
// identical across the admin panel.
const PLAN_COLORS = [
  "var(--color-step-1)", // blue
  "var(--color-step-2)", // violet
  "var(--color-step-3)", // green
  "var(--color-premium)", // gold
  "var(--color-step-5)", // sky
  "var(--color-danger)", // red
];
function planColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PLAN_COLORS[h % PLAN_COLORS.length];
}

function fmtMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** Short day-level date for renewal/trial deadlines (times are noise there). */
function fmtDay(iso: string): string {
  return formatDateDMY(iso);
}

/** Day-level distance ("in 12 days" / "today" / "3 days ago") — saves the admin
 *  the mental date math on every renewal cell. */
function relativeDay(iso: string): string {
  const days = Math.round(
    (new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/* ------------------------------ Onboarding leads ------------------------------ *
 *  "Under onboarding" = registered but never subscribed. onboardingStep is the
 *  funnel step they'll resume at (0 = finished the funnel or direct signup),
 *  so it doubles as the drop-off point for the call list.                        */

const ONBOARDING_STEP_LABELS: Record<number, string> = {
  5: "Services setup",
  6: "Voice setup",
  7: "Final review",
  8: "Plan selection",
};

function onboardingDropOff(step: number): string {
  return ONBOARDING_STEP_LABELS[step] ?? "Signed up — no plan picked";
}

type BadgeVariant = "neutral" | "success" | "warning" | "danger";

/** Same status→badge vocabulary as AdminCustomersPage. */
function statusBadge(status: string): { label: string; variant: BadgeVariant } {
  switch (status) {
    case "active":
      return { label: "Active", variant: "success" };
    case "trialing":
      return { label: "Trial", variant: "warning" };
    case "past_due":
      return { label: "Past due", variant: "danger" };
    case "suspended":
      return { label: "Suspended", variant: "danger" };
    case "canceled":
      return { label: "Canceled", variant: "neutral" };
    default:
      return { label: "No plan", variant: "neutral" };
  }
}

/** A "trialing" subscription whose minutes are used up or whose trial date has
 *  passed — the server reports this as expired_minutes/expired_date and pauses the
 *  customer's calls, but subscriptionStatus stays "trialing" until they renew (or
 *  it auto-converts). Mirrors evaluateTrialStatus() so the admin badge matches what
 *  the customer sees ("Trial Expired"). */
function isTrialExpired(s: {
  status: string;
  minutesUsed: number;
  minutesAllocated: number;
  trialEndsAt: string | null;
}): boolean {
  if (s.status !== "trialing") return false;
  const minutesUp = s.minutesAllocated > 0 && s.minutesUsed >= s.minutesAllocated;
  const dateUp = s.trialEndsAt != null && new Date(s.trialEndsAt).getTime() <= Date.now();
  return minutesUp || dateUp;
}

/** A live PAID plan whose minutes are used up with auto-renew off — the server
 *  reports this as expired_minutes and pauses the customer's calls (no early
 *  renewal to top the minutes back up), but subscriptionStatus stays "active"
 *  until the period ends. Mirrors the active-plan branch of the entitlement builder
 *  (exhausted && !autoRenew); unlimited plans (allocated 0) never count. */
function isPlanPaused(s: {
  status: string;
  autoRenew: boolean;
  minutesUsed: number;
  minutesAllocated: number;
}): boolean {
  return (
    s.status === "active" &&
    !s.autoRenew &&
    s.minutesAllocated > 0 &&
    s.minutesUsed >= s.minutesAllocated
  );
}

/** Row/drawer status badge — onboarding leads, used-up trials, and used-up paid
 *  plans (calls paused) get their own label so the admin isn't shown a bare
 *  "Trial"/"Active" for an exhausted, paused account. */
function subscriptionBadge(s: {
  status: string;
  underOnboarding: boolean;
  autoRenew: boolean;
  minutesUsed: number;
  minutesAllocated: number;
  trialEndsAt: string | null;
}): { label: string; variant: BadgeVariant } {
  if (s.underOnboarding) return { label: "Onboarding", variant: "warning" };
  if (isTrialExpired(s)) return { label: "Trial expired", variant: "danger" };
  if (isPlanPaused(s)) return { label: "Paused", variant: "danger" };
  return statusBadge(s.status);
}

/* ------------------------- At-risk + win-back contact ------------------------ *
 *  Single source of truth for both the table accent/quick-action and the
 *  drawer's "Needs attention" callout.                                          */

interface RiskSubject {
  fullName: string;
  email: string;
  status: string;
  planName: string | null;
  underOnboarding: boolean;
  autoRenew: boolean;
  /** When the current period/trial ends — the date a scheduled cancel takes effect. */
  endsAt: string | null;
  scheduledPlan: { name: string; effectiveAt: string | null } | null;
}

interface RiskInfo {
  level: "danger" | "warning";
  reason: "canceled" | "past_due" | "cancel_scheduled" | "downgrade";
  title: string;
  description: string;
}

function riskInfo(s: RiskSubject): RiskInfo | null {
  // Onboarding leads never subscribed — they're a call list of their own
  // ("Under onboarding" tab), not churn, so they don't count as at-risk.
  if (s.underOnboarding) return null;
  if (s.status === "past_due") {
    return {
      level: "danger",
      reason: "past_due",
      title: "Payment failed",
      description: "Their last charge didn't go through — the account lapses unless the card is updated.",
    };
  }
  if (s.status === "canceled" || s.status === "suspended" || s.status === "none") {
    return {
      level: "danger",
      reason: "canceled",
      title: "No live subscription",
      description: "This customer isn't paying anymore — a good moment for a win-back email.",
    };
  }
  // Auto-renew off on a live plan/trial = a cancellation scheduled (in-app
  // toggle or Stripe portal "Cancel plan") — it lapses at period end.
  if ((s.status === "active" || s.status === "trialing") && !s.autoRenew) {
    return {
      level: "warning",
      reason: "cancel_scheduled",
      title: "Cancellation scheduled",
      description: `Auto-renew is off — the ${s.status === "trialing" ? "trial" : "plan"} ends ${
        s.endsAt ? `on ${fmtDay(s.endsAt)}` : "at period end"
      } with no further charge. A save call before then could keep them.`,
    };
  }
  if (s.scheduledPlan) {
    return {
      level: "warning",
      reason: "downgrade",
      title: "Downgrade scheduled",
      description: `Moving to ${s.scheduledPlan.name}${s.scheduledPlan.effectiveAt ? ` on ${fmtDay(s.scheduledPlan.effectiveAt)}` : " at period end"} — worth asking what's missing.`,
    };
  }
  return null;
}

/** Pre-written win-back mailto:, tailored to why the customer is at risk. */
function contactHref(s: RiskSubject): string {
  const firstName = s.fullName.trim().split(/\s+/)[0] || "there";
  const risk = riskInfo(s);
  let subject = `Checking in on your ${s.planName ?? ""} plan`.replace(/\s+/g, " ").trim();
  let body =
    `Hi ${firstName},\n\n` +
    `Just checking in on how your AI receptionist is going. If there's anything we can help with, reply to this email.\n\n` +
    `Best,\nThe ${env.appName} team`;

  if (s.underOnboarding) {
    subject = "Finish setting up your AI receptionist";
    body =
      `Hi ${firstName},\n\n` +
      `You're only a couple of steps away from having your AI receptionist answering calls. ` +
      `Pick up where you left off and you'll be live in minutes — or reply to this email and we'll walk you through it.\n\n` +
      `Best,\nThe ${env.appName} team`;
  } else if (risk?.reason === "canceled") {
    subject = "We'd love to have you back";
    body =
      `Hi ${firstName},\n\n` +
      `We noticed your subscription ended and we'd love to have you back. Was there something that didn't work for you? ` +
      `If anything fell short, reply and tell us — we read every answer and we'd love a chance to make it right.\n\n` +
      `Best,\nThe ${env.appName} team`;
  } else if (risk?.reason === "past_due") {
    subject = "Your payment didn't go through";
    body =
      `Hi ${firstName},\n\n` +
      `Your last payment didn't go through, so your AI receptionist is at risk of pausing. ` +
      `Updating your card only takes a minute — sign in and head to Settings → Billing to fix it.\n\n` +
      `If anything's unclear, just reply to this email and we'll help.\n\n` +
      `Best,\nThe ${env.appName} team`;
  } else if (risk?.reason === "cancel_scheduled") {
    subject = "Before your plan ends — anything we can fix?";
    body =
      `Hi ${firstName},\n\n` +
      `We saw you've canceled${s.planName ? ` your ${s.planName} plan` : ""} — it stays active until the end of the period, so nothing changes yet. ` +
      `Before it lapses: was there something that didn't work for you? Reply and tell us — if we can fix it, we will, and you can turn auto-renew back on any time from Plans & Billing.\n\n` +
      `Best,\nThe ${env.appName} team`;
  } else if (risk?.reason === "downgrade") {
    subject = "Is something missing from your plan?";
    body =
      `Hi ${firstName},\n\n` +
      `We saw you scheduled a move to a smaller plan. Is something missing from ${s.planName ?? "your current plan"}? ` +
      `If there's a feature you need or the pricing isn't sitting right, reply and let us know — we may be able to help before the change kicks in.\n\n` +
      `Best,\nThe ${env.appName} team`;
  }

  return `mailto:${s.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function riskSubject(r: AdminSubscriptionRow): RiskSubject {
  return {
    fullName: r.fullName,
    email: r.email,
    status: r.status,
    planName: r.plan?.name ?? null,
    underOnboarding: r.underOnboarding,
    autoRenew: r.autoRenew,
    endsAt: r.status === "trialing" ? r.trialEndsAt : r.currentPeriodEnd,
    scheduledPlan: r.scheduledPlan,
  };
}

/* --------------------------- Plan-history timeline --------------------------- */

const EVENT_META: Record<
  PlanEventType,
  { label: string; icon: LucideIcon; tone: "primary" | "success" | "warning" | "danger" | "neutral" }
> = {
  trial_started: { label: "Trial started", icon: Rocket, tone: "primary" },
  trial_converted: { label: "Trial converted", icon: CreditCard, tone: "success" },
  upgraded: { label: "Upgraded", icon: ArrowUpRight, tone: "success" },
  downgrade_scheduled: { label: "Downgrade scheduled", icon: Clock, tone: "warning" },
  downgraded: { label: "Downgraded", icon: ArrowDownRight, tone: "warning" },
  downgrade_canceled: { label: "Downgrade canceled", icon: Undo2, tone: "neutral" },
  plan_switched: { label: "Plan switched", icon: Repeat, tone: "primary" },
  renewed: { label: "Renewed", icon: RefreshCw, tone: "success" },
  canceled: { label: "Canceled", icon: Ban, tone: "danger" },
  auto_renew_off: { label: "Cancellation scheduled", icon: Ban, tone: "warning" },
  auto_renew_on: { label: "Auto-renew restored", icon: RefreshCw, tone: "success" },
  coupon_applied: { label: "Coupon applied", icon: Ticket, tone: "success" },
  coupon_expired: { label: "Coupon ended", icon: Ticket, tone: "neutral" },
  coupon_reattached: { label: "Coupon re-applied", icon: Ticket, tone: "warning" },
};

const TONE_CLASSES: Record<string, string> = {
  primary: "bg-primary-tint text-primary",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  neutral: "bg-muted text-muted-foreground",
};

/* ---------------------------------- Filters ---------------------------------- */

type StatusFilter = "all" | "onboarding" | "active" | "trialing" | "attention" | "canceled";

const FILTERS: { key: StatusFilter; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Every customer, regardless of subscription status." },
  {
    key: "onboarding",
    label: "Under onboarding",
    hint: "Signed up but never subscribed — still working through the setup steps.",
  },
  { key: "trialing", label: "Trial", hint: "On a free trial that hasn't been charged yet." },
  { key: "active", label: "Active", hint: "Paying subscribers on a live plan." },
  { key: "canceled", label: "Canceled", hint: "Subscription ended — no longer paying." },
  {
    key: "attention",
    label: "Need attention",
    hint: "At-risk accounts — payment failed, cancellation scheduled, or no live subscription.",
  },
];

function matchesFilter(r: AdminSubscriptionRow, f: StatusFilter): boolean {
  switch (f) {
    case "onboarding":
      return r.underOnboarding;
    case "active":
      return r.status === "active";
    case "trialing":
      return r.status === "trialing";
    case "attention":
      return riskInfo(riskSubject(r)) !== null;
    case "canceled":
      return (
        !r.underOnboarding && (r.status === "canceled" || r.status === "suspended" || r.status === "none")
      );
    default:
      return true;
  }
}

/* --------------------------------- Stat cards -------------------------------- */

/** Soft pastel KPI card. Doubles as a segment filter when clickable: click to
 *  focus the table on that slice, click again to clear. */
function PastelStat({
  label,
  value,
  sub,
  icon: Icon,
  tint,
  iconClass,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  icon: LucideIcon;
  /** Soft background tint classes for the card. */
  tint: string;
  /** Icon colour classes (sits in a white rounded square). */
  iconClass: string;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={hint}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        "rounded-2xl border p-4 text-left transition-all",
        tint,
        onClick && "cursor-pointer hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]",
        active ? "border-primary/50 ring-1 ring-primary/40" : "border-transparent",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-background shadow-sm",
            iconClass,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground/75">{label}</p>
          <p className="mt-1 text-2xl font-bold leading-none tabular-nums text-foreground">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
    </Tag>
  );
}

/* ---------------------------------- The page --------------------------------- */

export default function AdminSubscriptionsPage() {
  const [rows, setRows] = useState<AdminSubscriptionRow[]>([]);
  const [summary, setSummary] = useState<AdminSubscriptionsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [searchParams, setSearchParams] = useSearchParams();

  // The open drawer is deep-linkable: /dashboard/admin/subscriptions?user=<id>.
  const openUserId = searchParams.get("user");

  // Column-level visibility from the viewer's role (allow-list).
  const cols = useSubscriptionColumns();

  // Fetch the list. `silent` background refreshes skip the skeleton and swallow
  // errors so the table just quietly stays in sync (poll + on tab focus).
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.admin.subscriptions.list();
      setRows(data.subscriptions);
      setSummary(data.summary);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load subscriptions");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Initial load, then keep the table live off the global heartbeat: every tick
  // (and on tab focus, which the driver also fires) silently refetch so status
  // changes (onboarding → trial, etc.) show up without a manual reload. `silent`
  // skips the skeleton, so the table quietly stays in sync.
  const liveTick = useLiveTick();
  const didInit = useRef(false);
  useEffect(() => {
    // First run for this mount is a full load (skeleton); later ticks refresh
    // silently. Per-mount ref, since the global tick persists across navigation.
    if (!didInit.current) {
      didInit.current = true;
      void load();
    } else {
      void load(true);
    }
  }, [liveTick, load]);

  const attentionCount = useMemo(
    () => rows.filter((r) => riskInfo(riskSubject(r)) !== null).length,
    [rows],
  );

  const onboardingCount = useMemo(() => rows.filter((r) => r.underOnboarding).length, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (!q) return true;
      return `${r.fullName} ${r.email} ${r.phone} ${r.businessName} ${r.plan?.name ?? ""} ${r.status}`
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, filter]);

  // Either filter changing snaps back to page 1; the hook clamps a page that
  // falls out of range on its own.
  const {
    page,
    pageSize,
    pageItems: paged,
    total,
    setPage,
    setPageSize,
  } = usePagination(filtered, { resetKey: `${search}|${filter}` });

  const filtersActive = filter !== "all" || search.trim() !== "";

  /**
   * Download the subscriptions currently on screen as a spreadsheet.
   *
   * Exports the FILTERED set for the same reason the customers export does: the
   * admin narrowed the list on purpose, so "export" means "give me these". The
   * full list is one click away — clear the filters first.
   *
   * Columns follow the same role allow-list as the table (`cols`): a STAFF member
   * who can't see prices on screen must not get them in a file either, or the
   * export becomes a way around the permission.
   */
  function exportCsv() {
    if (!filtered.length) {
      toast.error("Nothing to export — no subscriptions match these filters.");
      return;
    }
    // Identity always exports: it's the Customer column, which every role sees.
    const columns: CsvColumn<AdminSubscriptionRow>[] = [
      { header: "Name", value: (r) => r.fullName },
      { header: "Email", value: (r) => r.email },
      { header: "Mobile", value: (r) => r.phone },
      { header: "Business", value: (r) => r.businessName },
    ];
    if (cols.plan) {
      columns.push({
        header: "Plan",
        value: (r) => (r.plan ? `${r.plan.name}${r.plan.legacy ? " (legacy)" : ""}` : "No plan"),
      });
      columns.push({
        header: "Scheduled change",
        value: (r) =>
          r.scheduledPlan
            ? `${r.scheduledPlan.name}${
                r.scheduledPlan.effectiveAt
                  ? ` on ${fmtDay(r.scheduledPlan.effectiveAt)}`
                  : " at period end"
              }`
            : "",
      });
    }
    if (cols.price) {
      columns.push({
        header: "Price",
        value: (r) => (r.plan ? `${fmtMoney(r.plan.priceCents, r.plan.currency)}/${r.plan.interval}` : ""),
      });
      columns.push({
        header: "MRR",
        value: (r) => (r.plan && r.mrrCents > 0 ? fmtMoney(r.mrrCents, r.plan.currency) : ""),
      });
    }
    if (cols.status) {
      columns.push({ header: "Status", value: (r) => subscriptionBadge(r).label });
    }
    if (cols.minutes) {
      columns.push({ header: "Minutes used", value: (r) => r.minutesUsed });
      columns.push({ header: "Minutes included", value: (r) => r.minutesAllocated });
    }
    if (cols.renewal) {
      columns.push({
        header: "Next billing",
        value: (r) => (r.currentPeriodEnd ? fmtDay(r.currentPeriodEnd) : ""),
      });
      columns.push({
        header: "Trial ends",
        value: (r) => (r.trialEndsAt ? fmtDay(r.trialEndsAt) : ""),
      });
    }
    if (cols.autoRenew) {
      columns.push({ header: "Auto-renew", value: (r) => (r.autoRenew ? "On" : "Off") });
    }
    // Useful precisely on the "Under onboarding" tab, where the export doubles as
    // a call list: it says which funnel step the lead stalled on.
    columns.push({
      header: "Onboarding drop-off",
      value: (r) => (r.underOnboarding ? onboardingDropOff(r.onboardingStep) : ""),
    });
    columns.push({ header: "Signed up", value: (r) => fmtDay(r.signupAt) });

    downloadCsv(datedCsvName("subscriptions"), toCsv(columns, filtered));
    toast.success(`Exported ${filtered.length} subscription${filtered.length === 1 ? "" : "s"}`);
  }

  function openDrawer(userId: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("user", userId);
        return next;
      },
      { replace: false },
    );
  }

  function closeDrawer() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("user");
        return next;
      },
      { replace: false },
    );
  }

  const renderPlan = (r: AdminSubscriptionRow) =>
    r.plan ? (
      <div>
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
          style={{
            color: planColor(r.plan.name),
            backgroundColor: `color-mix(in srgb, ${planColor(r.plan.name)} 14%, transparent)`,
          }}
        >
          {r.plan.name}
          {r.plan.legacy && <span className="ml-1 font-normal opacity-70">(legacy)</span>}
        </span>
        {r.scheduledPlan && (
          <p className="mt-1 flex items-center gap-1 text-xs text-warning">
            <ArrowDownRight className="size-3" />
            {r.scheduledPlan.name}
            {r.scheduledPlan.effectiveAt ? ` on ${fmtDay(r.scheduledPlan.effectiveAt)}` : " at period end"}
          </p>
        )}
      </div>
    ) : r.underOnboarding ? (
      <div>
        <Badge variant="neutral">No plan</Badge>
        <p className="mt-1 text-xs text-warning">Stopped at: {onboardingDropOff(r.onboardingStep)}</p>
      </div>
    ) : (
      <Badge variant="neutral">No plan</Badge>
    );

  const renderPrice = (r: AdminSubscriptionRow) =>
    r.plan ? (
      <>
        <span className="font-medium text-foreground">{fmtMoney(r.plan.priceCents, r.plan.currency)}</span>/
        {r.plan.interval}
      </>
    ) : (
      "—"
    );

  const renderMinutes = (r: AdminSubscriptionRow) =>
    r.minutesAllocated > 0 ? (
      <>
        <span className="font-medium text-foreground">{r.minutesUsed}</span> / {r.minutesAllocated}
      </>
    ) : (
      "—"
    );

  const renderRenewal = (r: AdminSubscriptionRow) => {
    const renewDate = r.status === "trialing" ? r.trialEndsAt : r.currentPeriodEnd;
    return renewDate ? (
      <span title={r.status === "trialing" ? "Trial ends" : r.autoRenew ? "Renews" : "Ends"}>
        {fmtDay(renewDate)}
      </span>
    ) : r.underOnboarding ? (
      <span title="Signed up">Joined {fmtDay(r.signupAt)}</span>
    ) : (
      "—"
    );
  };

  const renderActions = (r: AdminSubscriptionRow) => {
    const risk = riskInfo(riskSubject(r));
    return (
      <div className="flex items-center justify-end gap-1">
        {(risk || r.underOnboarding) && (
          <a
            href={contactHref(riskSubject(r))}
            title={
              risk
                ? `Email ${r.fullName} — ${risk.title.toLowerCase()}`
                : `Email ${r.fullName} — nudge them to finish onboarding`
            }
            className={cn(
              "rounded-md p-1.5 transition-colors hover:bg-muted",
              !risk ? "text-primary" : risk.level === "danger" ? "text-danger" : "text-warning",
            )}
          >
            <Mail className="size-4" />
          </a>
        )}
        <button
          type="button"
          onClick={() => openDrawer(r.userId)}
          aria-label={`Open ${r.fullName}'s subscription`}
          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        subtitle="Who's subscribed to what — payments, plan history and accounts that need attention."
        actions={
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
            <CreditCard className="size-4 text-primary" />
            <span className="font-semibold text-foreground tabular-nums">{summary?.total ?? 0}</span> total
          </span>
        }
      />

      {/* Summary stats — soft pastel cards; each (except MRR) filters the table. */}
      <div className={cn("mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3", cols.price ? "xl:grid-cols-6" : "xl:grid-cols-5")}>
        {/* MRR is a price figure — only for viewers with the price column. */}
        {cols.price && (
          <PastelStat
            label="MRR"
            // Currency comes from the response, not a default: plans are priced
            // in more than one, and the server normalises the total to a single
            // reporting currency before sending it.
            value={summary ? fmtMoney(summary.mrrCents, summary.mrrCurrency) : "—"}
            sub={`Across ${summary?.total ?? 0} customer${(summary?.total ?? 0) === 1 ? "" : "s"}${
              summary?.mrrCurrency ? ` · ${summary.mrrCurrency.toUpperCase()}` : ""
            }`}
            icon={DollarSign}
            tint="bg-[#7C5CFC]/10"
            iconClass="text-[#7C5CFC]"
          />
        )}
        <PastelStat
          label="Under onboarding"
          value={String(summary?.onboarding ?? 0)}
          sub="Signed up, no plan yet"
          icon={UserPlus}
          tint="bg-primary-tint"
          iconClass="text-primary"
          hint="Click to see who to nudge to finish setup."
          active={filter === "onboarding"}
          onClick={() => setFilter((f) => (f === "onboarding" ? "all" : "onboarding"))}
        />
        <PastelStat
          label="On trial"
          value={String(summary?.trialing ?? 0)}
          sub="Not charged yet"
          icon={Rocket}
          tint="bg-warning-tint"
          iconClass="text-warning"
          hint="Free trials that haven't been charged yet."
          active={filter === "trialing"}
          onClick={() => setFilter((f) => (f === "trialing" ? "all" : "trialing"))}
        />
        <PastelStat
          label="Active"
          value={String(summary?.active ?? 0)}
          sub="Paying subscribers"
          icon={TrendingUp}
          tint="bg-success-tint"
          iconClass="text-success"
          hint="Paying subscribers on a live plan."
          active={filter === "active"}
          onClick={() => setFilter((f) => (f === "active" ? "all" : "active"))}
        />
        <PastelStat
          label="Canceled"
          value={String(summary?.canceled ?? 0)}
          sub="Plan ended, not paying"
          icon={XCircle}
          tint="bg-foreground/[0.06]"
          iconClass="text-foreground/60"
          hint="Subscription ended — no longer paying. Click to see them."
          active={filter === "canceled"}
          onClick={() => setFilter((f) => (f === "canceled" ? "all" : "canceled"))}
        />
        <PastelStat
          label="Past due"
          value={String(summary?.pastDue ?? 0)}
          sub="Payment failed"
          icon={CalendarClock}
          tint="bg-danger-tint"
          iconClass="text-danger"
          hint="Shown with everything else needing attention."
          active={filter === "attention"}
          onClick={() => setFilter((f) => (f === "attention" ? "all" : "attention"))}
        />
      </div>

      {/* Search + segmented status tabs — search kept compact on the left, tabs
          pushed to the right edge so the row still spans the full width. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, email or plan…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 rounded-full border-border bg-card pl-10 shadow-[var(--shadow-soft)]"
            aria-label="Search subscriptions"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-[var(--shadow-soft)]">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                title={f.hint}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                  filter === f.key
                    ? "bg-primary-tint font-semibold text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
                {f.key === "attention" && attentionCount > 0 && (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                    {attentionCount}
                  </span>
                )}
                {f.key === "onboarding" && onboardingCount > 0 && (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-white">
                    {onboardingCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <Button variant="outline" size="sm" className="h-10 gap-2 rounded-full" onClick={exportCsv}>
            <Download className="size-4" />
            Export
            {filtersActive && filtered.length > 0 && (
              <span className="tabular-nums text-muted-foreground">({filtered.length})</span>
            )}
          </Button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton cols={8} />
      ) : filtered.length === 0 ? (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <CreditCard className="size-6" />
            </span>
            <p className="text-sm font-medium">No subscriptions found</p>
            <p className="text-sm text-muted-foreground">
              {search || filter !== "all"
                ? "Try a different search or filter."
                : "Subscriptions will appear here once customers pick a plan."}
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Desktop — table (md and up) */}
          <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)] md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5">Customer</th>
                    {cols.plan && <th className="px-4 py-2.5">Plan</th>}
                    {cols.price && <th className="px-4 py-2.5">Price</th>}
                    {cols.minutes && <th className="px-4 py-2.5">Minutes</th>}
                    {cols.renewal && <th className="px-4 py-2.5">Next billing</th>}
                    {cols.autoRenew && <th className="px-4 py-2.5">Auto-renew</th>}
                    {cols.status && <th className="px-4 py-2.5">Status</th>}
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {paged.map((r) => {
                    const risk = riskInfo(riskSubject(r));
                    const s = subscriptionBadge(r);
                    const renewDate = r.status === "trialing" ? r.trialEndsAt : r.currentPeriodEnd;
                    return (
                      <tr
                        key={r.userId}
                        onClick={() => openDrawer(r.userId)}
                        style={
                          risk
                            ? {
                                boxShadow: `inset 3px 0 0 0 var(--color-${risk.level})`,
                              }
                            : undefined
                        }
                        className="group cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-primary-tint-soft"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary">
                              {initials(r.fullName)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-semibold">{r.fullName}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {r.email}
                                {r.phone && ` · ${r.phone}`}
                              </p>
                            </div>
                          </div>
                        </td>
                        {cols.plan && <td className="px-4 py-3">{renderPlan(r)}</td>}
                        {cols.price && (
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">{renderPrice(r)}</td>
                        )}
                        {cols.minutes && (
                        <td className="px-4 py-3">
                          {r.minutesAllocated > 0 ? (
                            (() => {
                              const pct = (r.minutesUsed / r.minutesAllocated) * 100;
                              return (
                                <div>
                                  <p className="text-xs tabular-nums">
                                    <span className="font-semibold text-foreground">{r.minutesUsed}</span>
                                    <span className="text-muted-foreground"> / {r.minutesAllocated} min</span>
                                  </p>
                                  <div className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        "h-full rounded-full transition-all",
                                        pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary",
                                      )}
                                      style={{ width: `${Math.min(100, pct)}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })()
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        )}
                        {cols.renewal && (
                        <td className="px-4 py-3">
                          {renewDate ? (
                            (() => {
                              const days = Math.round(
                                (new Date(renewDate).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) /
                                  86_400_000,
                              );
                              return (
                                <div title={r.status === "trialing" ? "Trial ends" : r.autoRenew ? "Renews" : "Ends"}>
                                  <p
                                    className={cn(
                                      "font-medium capitalize",
                                      days < 0 ? "text-danger" : days <= 7 ? "text-warning" : "text-foreground",
                                    )}
                                  >
                                    {relativeDay(renewDate)}
                                  </p>
                                  <p className="mt-0.5 text-xs text-muted-foreground">{fmtDay(renewDate)}</p>
                                </div>
                              );
                            })()
                          ) : r.underOnboarding ? (
                            <div title="Signed up">
                              <p className="font-medium capitalize text-foreground">joined {relativeDay(r.signupAt)}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{fmtDay(r.signupAt)}</p>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        )}
                        {cols.autoRenew && (
                        <td className="px-4 py-3">
                          {/* Display-only switch — flipping it is the customer's call, not the admin's. */}
                          <span
                            className={cn(
                              "inline-flex items-center gap-2 text-xs font-medium",
                              r.autoRenew ? "text-success" : "text-muted-foreground",
                            )}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                                r.autoRenew ? "bg-success" : "bg-muted-foreground/25",
                              )}
                            >
                              <span
                                className={cn(
                                  "absolute size-3 rounded-full bg-white shadow transition-transform",
                                  r.autoRenew ? "translate-x-3.5" : "translate-x-0.5",
                                )}
                              />
                            </span>
                            {r.autoRenew ? "On" : "Off"}
                          </span>
                        </td>
                        )}
                        {cols.status && (
                        <td className="px-4 py-3">
                          <Badge variant={s.variant} className="gap-1.5">
                            <span className="size-1.5 rounded-full bg-current" aria-hidden />
                            {s.label}
                          </Badge>
                        </td>
                        )}
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {renderActions(r)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — cards (below md) */}
          <div className="space-y-3 md:hidden">
            {paged.map((r) => {
              const risk = riskInfo(riskSubject(r));
              const s = subscriptionBadge(r);
              return (
                <DataCard
                  key={r.userId}
                  onClick={() => openDrawer(r.userId)}
                  style={risk ? { boxShadow: `inset 3px 0 0 0 var(--color-${risk.level})` } : undefined}
                >
                  <DataCardHeader
                    lead={<DataCardAvatar>{initials(r.fullName)}</DataCardAvatar>}
                    title={r.fullName}
                    subtitle={
                      <>
                        {r.email}
                        {r.phone && ` · ${r.phone}`}
                      </>
                    }
                    actions={renderActions(r)}
                  />
                  <DataCardPills>
                    {cols.status && <Badge variant={s.variant}>{s.label}</Badge>}
                    {cols.autoRenew && (
                      <Badge variant={r.autoRenew ? "success" : "neutral"}>
                        Auto-renew {r.autoRenew ? "on" : "off"}
                      </Badge>
                    )}
                  </DataCardPills>
                  <DataCardGrid>
                    {cols.plan && <CardField label="Plan">{renderPlan(r)}</CardField>}
                    {cols.price && (
                      <CardField label="Price">
                        <span className="tabular-nums">{renderPrice(r)}</span>
                      </CardField>
                    )}
                    {cols.minutes && (
                      <CardField label="Minutes">
                        <span className="tabular-nums">{renderMinutes(r)}</span>
                      </CardField>
                    )}
                    {cols.renewal && <CardField label="Renews / Ends">{renderRenewal(r)}</CardField>}
                  </DataCardGrid>
                </DataCard>
              );
            })}
          </div>
        </>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="subscriptions"
      />

      <SubscriptionDrawer userId={openUserId} onClose={closeDrawer} />
    </div>
  );
}

/* -------------------------------- Detail drawer ------------------------------- */

function SubscriptionDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<AdminSubscriptionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const cols = useSubscriptionColumns();

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      return;
    }
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const data = await api.admin.subscriptions.detail(userId);
        if (active) setDetail(data);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load subscription details");
        if (active) onClose();
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const sub = detail?.subscription;
  const drawerSubject: RiskSubject | null = detail
    ? {
        fullName: detail.customer.fullName,
        email: detail.customer.email,
        status: sub!.status,
        planName: sub!.plan?.name ?? null,
        underOnboarding: sub!.underOnboarding,
        autoRenew: sub!.autoRenew,
        endsAt: sub!.status === "trialing" ? sub!.trialEndsAt : sub!.currentPeriodEnd,
        scheduledPlan: sub!.scheduledPlan,
      }
    : null;
  const risk = drawerSubject ? riskInfo(drawerSubject) : null;
  const mailHref = drawerSubject ? contactHref(drawerSubject) : "#";
  const totalPaidCents = detail
    ? detail.invoices.reduce((sum, inv) => sum + inv.amountPaid, 0)
    : 0;
  const currency = detail?.invoices[0]?.currency ?? sub?.plan?.currency ?? "usd";
  const s = sub ? subscriptionBadge(sub) : null;

  type Invoice = AdminSubscriptionDetail["invoices"][number];
  const renderInvoiceNumber = (inv: Invoice) =>
    inv.hostedInvoiceUrl ? (
      <a
        href={inv.hostedInvoiceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        {inv.number ?? inv.id.slice(0, 12)}
        <ExternalLink className="size-3" />
      </a>
    ) : (
      <span className="font-medium">{inv.number ?? inv.id.slice(0, 12)}</span>
    );
  const renderInvoiceStatus = (inv: Invoice) => (
    <Badge
      variant={
        inv.status === "paid"
          ? "success"
          : inv.status === "open"
            ? "warning"
            : inv.status === "void" || inv.status === "uncollectible"
              ? "danger"
              : "neutral"
      }
    >
      {inv.status ?? "unknown"}
    </Badge>
  );
  const renderInvoicePdf = (inv: Invoice) =>
    inv.pdfUrl ? (
      <a
        href={inv.pdfUrl}
        target="_blank"
        rel="noreferrer"
        title="Download PDF"
        className="inline-flex rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="size-4" />
      </a>
    ) : null;

  return (
    <Sheet open={!!userId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent aria-describedby={undefined}>
        {/* Radix requires a title inside the dialog; the visible header below repeats it. */}
        <SheetTitle className="sr-only">Subscription details</SheetTitle>
        {loading || !detail ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="border-b border-border bg-warm p-6 pr-14">
              <div className="flex items-start gap-3.5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-tint text-base font-semibold text-primary ring-4 ring-background">
                  {initials(detail.customer.fullName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{detail.customer.fullName}</h2>
                    {s && (
                      <Badge variant={s.variant} className="gap-1.5">
                        <span className="size-1.5 rounded-full bg-current" aria-hidden />
                        {s.label}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {detail.customer.email}
                    {detail.customer.phone && ` · ${detail.customer.phone}`}
                  </p>
                  {detail.customer.businessName && (
                    <p className="truncate text-sm text-muted-foreground">{detail.customer.businessName}</p>
                  )}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={mailHref}>
                    <Mail className="size-4" /> Contact customer
                  </a>
                </Button>
              </div>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              {/* Onboarding-lead callout — registered but never subscribed */}
              {sub?.underOnboarding && (
                <div className="rounded-xl border border-primary/30 bg-primary-tint p-4">
                  <p className="text-sm font-semibold text-primary">
                    Under onboarding — stopped at {onboardingDropOff(sub.onboardingStep)}
                  </p>
                  <p className="mt-1 text-sm text-foreground/80">
                    Signed up {fmtDay(String(detail.customer.createdAt))} but never picked a plan.
                    {detail.customer.phone
                      ? ` Give them a call on ${detail.customer.phone} or send a nudge to help them finish.`
                      : " Send a nudge to help them finish."}
                  </p>
                  <a
                    href={mailHref}
                    className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                  >
                    <Mail className="size-4" /> Send a pre-written email
                  </a>
                </div>
              )}

              {/* Win-back callout */}
              {risk && (
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    risk.level === "danger"
                      ? "border-danger/30 bg-danger-tint"
                      : "border-warning/30 bg-warning-tint",
                  )}
                >
                  <p className={cn("text-sm font-semibold", risk.level === "danger" ? "text-danger" : "text-warning")}>
                    Needs attention — {risk.title}
                  </p>
                  <p className="mt-1 text-sm text-foreground/80">{risk.description}</p>
                  <a
                    href={mailHref}
                    className={cn(
                      "mt-2 inline-flex items-center gap-1.5 text-sm font-medium hover:underline",
                      risk.level === "danger" ? "text-danger" : "text-warning",
                    )}
                  >
                    <Mail className="size-4" /> Send a pre-written email
                  </a>
                </div>
              )}

              {/* Current subscription */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <CreditCard className="size-4 text-primary" /> Current subscription
                </h3>
                <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-soft)]">
                  {sub?.plan ? (
                    <>
                      {/* Plan + price banner */}
                      {(cols.plan || cols.price) && (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-warm px-4 py-3">
                          {cols.plan && (
                            <span
                              className="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wide"
                              style={{
                                color: planColor(sub.plan.name),
                                backgroundColor: `color-mix(in srgb, ${planColor(sub.plan.name)} 12%, transparent)`,
                              }}
                            >
                              {sub.plan.name}
                              {sub.plan.legacy && (
                                <span className="ml-1 font-medium normal-case opacity-70">(legacy)</span>
                              )}
                            </span>
                          )}
                          {cols.price && (
                            <p className="text-lg font-bold leading-none tabular-nums">
                              {fmtMoney(sub.plan.priceCents, sub.plan.currency)}
                              <span className="text-xs font-normal text-muted-foreground">/{intervalLabel(sub.plan.interval, sub.plan.intervalCount)}</span>
                            </p>
                          )}
                        </div>
                      )}
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 p-4 text-sm">
                        {cols.autoRenew && (
                        <div>
                          <dt className="text-xs text-muted-foreground">Auto-renew</dt>
                          <dd className="mt-1.5">
                            <span
                              className={cn(
                                "inline-flex items-center gap-2 text-xs font-medium",
                                sub.autoRenew ? "text-success" : "text-muted-foreground",
                              )}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full",
                                  sub.autoRenew ? "bg-success" : "bg-muted-foreground/25",
                                )}
                              >
                                <span
                                  className={cn(
                                    "absolute size-3 rounded-full bg-white shadow",
                                    sub.autoRenew ? "translate-x-3.5" : "translate-x-0.5",
                                  )}
                                />
                              </span>
                              {sub.autoRenew ? "On" : "Off"}
                            </span>
                          </dd>
                        </div>
                        )}
                        {cols.minutes && (
                        <div>
                          <dt className="text-xs text-muted-foreground">Minutes used</dt>
                          <dd className="mt-1">
                            {sub.minutesAllocated > 0 ? (
                              (() => {
                                const pct = (sub.minutesUsed / sub.minutesAllocated) * 100;
                                return (
                                  <div>
                                    <p className="text-sm tabular-nums">
                                      <span className="font-semibold">{sub.minutesUsed}</span>
                                      <span className="text-muted-foreground"> / {sub.minutesAllocated} min</span>
                                    </p>
                                    <div className="mt-1.5 h-1.5 w-full max-w-32 overflow-hidden rounded-full bg-muted">
                                      <div
                                        className={cn(
                                          "h-full rounded-full",
                                          pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary",
                                        )}
                                        style={{ width: `${Math.min(100, pct)}%` }}
                                      />
                                    </div>
                                  </div>
                                );
                              })()
                            ) : (
                              <span className="font-medium">—</span>
                            )}
                          </dd>
                        </div>
                        )}
                        {cols.renewal && (
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {sub.status === "trialing" ? "Trial ends" : sub.autoRenew ? "Renews" : "Ends"}
                          </dt>
                          <dd className="mt-1">
                            {(() => {
                              const d = sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd;
                              if (!d) return <span className="font-medium">—</span>;
                              return (
                                <div>
                                  <p className="font-medium capitalize">{relativeDay(d)}</p>
                                  <p className="mt-0.5 text-xs text-muted-foreground">{fmtDay(d)}</p>
                                </div>
                              );
                            })()}
                          </dd>
                        </div>
                        )}
                        {cols.invoices && (
                        <div>
                          <dt className="text-xs text-muted-foreground">Total paid</dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums">{fmtMoney(totalPaidCents, currency)}</dd>
                        </div>
                        )}
                      </dl>
                    </>
                  ) : (
                    <p className="p-4 text-sm text-muted-foreground">
                      No plan on file{sub && sub.status !== "none" ? ` (status: ${sub.status})` : ""}.
                    </p>
                  )}
                  {sub?.scheduledPlan && (
                    <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-warning-tint p-3 text-sm">
                      <ArrowDownRight className="mt-0.5 size-4 shrink-0 text-warning" />
                      <p>
                        <span className="font-medium text-warning">Pending downgrade</span> — moving to{" "}
                        <span className="font-medium">{sub.scheduledPlan.name}</span>
                        {sub.scheduledPlan.effectiveAt ? ` on ${fmtDay(sub.scheduledPlan.effectiveAt)}` : " at period end"}.
                      </p>
                    </div>
                  )}
                </div>
              </section>

              {/* Plan history timeline */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <History className="size-4 text-primary" /> Plan history
                </h3>
                {detail.history.length === 0 ? (
                  <div className="rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow-soft)]">
                    <p className="text-sm font-medium">No history yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Plan events (trials, upgrades, renewals…) are recorded from now on as they happen.
                    </p>
                  </div>
                ) : (
                  <ol className="relative ml-4 space-y-5 border-l border-border pl-6">
                    {detail.history.map((e) => {
                      const meta = EVENT_META[e.type] ?? {
                        label: e.type,
                        icon: History,
                        tone: "neutral" as const,
                      };
                      const Icon = meta.icon;
                      return (
                        <li key={e.id} className="relative">
                          <span
                            className={cn(
                              "absolute -left-[37px] flex size-6 items-center justify-center rounded-full ring-4 ring-background",
                              TONE_CLASSES[meta.tone],
                            )}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">{meta.label}</p>
                            {e.amountCents > 0 && (
                              <Badge variant="success" className="tabular-nums">
                                {fmtMoney(e.amountCents, e.currency)} charged
                              </Badge>
                            )}
                          </div>
                          {(e.fromPlanName || e.toPlanName) && (
                            <p className="mt-0.5 text-sm text-muted-foreground">
                              {e.fromPlanName && e.toPlanName && e.fromPlanName !== e.toPlanName ? (
                                <>
                                  {e.fromPlanName} <span className="text-foreground/50">→</span> {e.toPlanName}
                                </>
                              ) : (
                                e.toPlanName ?? e.fromPlanName
                              )}
                              {e.priceCents > 0 && (
                                <span className="ml-1 tabular-nums">· {fmtMoney(e.priceCents, e.currency)}</span>
                              )}
                            </p>
                          )}
                          {e.note && <p className="mt-0.5 text-xs text-muted-foreground">{e.note}</p>}
                          <p className="mt-0.5 text-xs text-muted-foreground/70">{formatDate(e.createdAt)}</p>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              {/* Invoices */}
              {cols.invoices && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                    <Receipt className="size-4 text-primary" /> Invoices
                  </h3>
                  <span className="text-xs text-muted-foreground">From Stripe</span>
                </div>
                {detail.invoices.length === 0 ? (
                  <div className="rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow-soft)]">
                    <p className="text-sm font-medium">No invoices yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {sub?.stripeCustomerId
                        ? "Invoices appear here once the first payment is made."
                        : "This customer has no billing account yet."}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Desktop — table (md and up) */}
                    <div className="hidden overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-soft)] md:block">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2 font-medium">Invoice</th>
                            <th className="px-3 py-2 font-medium">Date</th>
                            <th className="px-3 py-2 text-right font-medium">Amount</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {detail.invoices.map((inv) => (
                            <tr key={inv.id} className="border-b border-border/60 last:border-0">
                              <td className="px-3 py-2">{renderInvoiceNumber(inv)}</td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {fmtDay(new Date(inv.created * 1000).toISOString())}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {fmtMoney(inv.amountPaid || inv.amountDue, inv.currency)}
                              </td>
                              <td className="px-3 py-2">{renderInvoiceStatus(inv)}</td>
                              <td className="px-3 py-2 text-right">{renderInvoicePdf(inv)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile — cards (below md) */}
                    <div className="space-y-3 md:hidden">
                      {detail.invoices.map((inv) => (
                        <DataCard key={inv.id}>
                          <DataCardHeader
                            title={renderInvoiceNumber(inv)}
                            subtitle={fmtDay(new Date(inv.created * 1000).toISOString())}
                            actions={renderInvoicePdf(inv)}
                          />
                          <DataCardPills>{renderInvoiceStatus(inv)}</DataCardPills>
                          <DataCardGrid>
                            <CardField label="Amount">
                              <span className="tabular-nums">
                                {fmtMoney(inv.amountPaid || inv.amountDue, inv.currency)}
                              </span>
                            </CardField>
                          </DataCardGrid>
                        </DataCard>
                      ))}
                    </div>
                  </>
                )}
              </section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
