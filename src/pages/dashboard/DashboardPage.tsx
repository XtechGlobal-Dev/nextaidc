import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Clock,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import type { CallLog, CallType, TrialState } from "@/types";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill } from "@/components/ui/misc";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageSkeleton, Skeleton } from "@/components/ui/skeleton";
import { cn, formatDuration } from "@/lib/utils";
import { DateRangePicker } from "./DateRangePicker";
import { useCallsStore } from "@/stores/useCallsStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useLiveTick } from "@/hooks/useLiveData";
import { LegendDot, MetricCard } from "./MetricCard";
import {
  CHART_COLORS,
  DonutChart,
  HourBars,
  RadialGauge,
  Sparkline,
} from "./charts";
import { isAdminRole } from "@/lib/roles";

// Filters

type CallTypeFilter = "all" | CallType;

type RangeKey = "today" | "7d" | "14d" | "mtd" | "custom";

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  "7d": "7 Days",
  "14d": "14 Days",
  mtd: "Month to Date",
  custom: "Custom range",
};

const RANGE_DAYS: Record<Exclude<RangeKey, "mtd" | "custom">, number> = {
  today: 1,
  "7d": 7,
  "14d": 14,
};

function rangeStart(range: Exclude<RangeKey, "custom">, now: Date): Date {
  if (range === "mtd") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = RANGE_DAYS[range];
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** ISO `yyyy-mm-dd` for an `<input type="date">` default. */
function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve the active [start, end] window in epoch ms for any range. */
function resolveWindow(
  range: RangeKey,
  customStart: string,
  customEnd: string,
  now: Date,
): { start: number; end: number } {
  if (range === "custom") {
    const start = customStart
      ? Date.parse(`${customStart}T00:00:00.000Z`)
      : rangeStart("14d", now).getTime();
    const end = customEnd ? Date.parse(`${customEnd}T23:59:59.999Z`) : now.getTime();
    return { start, end };
  }
  return { start: rangeStart(range, now).getTime(), end: now.getTime() };
}

// Analytics derivation

interface Analytics {
  totalMinutes: number;
  callCount: number;
  outcomeCounts: Record<string, number>;
  avgDurationSec: number;
  successRate: number;
  leadsCaptured: number;
  hourBuckets: number[];
  peakIndex: number;
  peakLabel: string;
}

function fmtHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${period}`;
}

/** Map a business timezone label ("Sydney (AEST/AEDT)") to an IANA zone. */
function ianaTimeZone(label?: string): string | undefined {
  const city = label?.split(" (")[0]?.trim();
  return city ? `Australia/${city}` : undefined;
}

/** Hour-of-day (0-23) for a timestamp, in the business's chosen timezone
 *  (falls back to the viewer's local time if no/invalid zone). */
function hourInZone(iso: string, timeZone?: string): number {
  const d = new Date(iso);
  if (!timeZone) return d.getHours();
  try {
    const s = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : d.getHours();
  } catch {
    return d.getHours();
  }
}

function deriveAnalytics(calls: CallLog[], timeZone?: string): Analytics {
  const totalSec = calls.reduce((sum, c) => sum + c.durationSec, 0);
  const totalMinutes = Math.round(totalSec / 60);

  const outcomeCounts: Record<string, number> = {
    completed: 0,
    missed: 0,
    voicemail: 0,
    failed: 0,
  };
  for (const c of calls) outcomeCounts[c.outcome] = (outcomeCounts[c.outcome] ?? 0) + 1;

  const completed = calls.filter((c) => c.outcome === "completed");
  const avgDurationSec =
    completed.length > 0
      ? Math.round(completed.reduce((s, c) => s + c.durationSec, 0) / completed.length)
      : 0;

  const successRate = calls.length > 0 ? Math.round((completed.length / calls.length) * 100) : 0;

  // A "lead" = completed call with a real contact detail in analysis.structuredData (what the CRM gets).
  // Web test calls carry no structuredData, so they never inflate this.
  const leadsCaptured = calls.filter((c) => {
    if (c.outcome !== "completed") return false;
    const sd = c.analysis?.structuredData;
    return Boolean(sd?.name?.trim() || sd?.phone?.trim() || sd?.email?.trim());
  }).length;

  const hourBuckets = new Array<number>(24).fill(0);
  for (const c of calls) {
    // Bucket by the business's chosen timezone (not UTC) so "Peak Calls Time"
    // reflects the real local time of day for that business.
    const h = hourInZone(c.createdAt, timeZone);
    hourBuckets[h] += 1;
  }
  let peakIndex = 0;
  for (let i = 1; i < 24; i++) if (hourBuckets[i] > hourBuckets[peakIndex]) peakIndex = i;
  const peakLabel =
    calls.length > 0 ? `${fmtHour(peakIndex)}–${fmtHour((peakIndex + 2) % 24)}` : "—";

  return {
    totalMinutes,
    callCount: calls.length,
    outcomeCounts,
    avgDurationSec,
    successRate,
    leadsCaptured,
    hourBuckets,
    peakIndex,
    peakLabel,
  };
}

/** Real period-over-period change in percent. Returns +100 when going from 0
 *  to a positive value, and 0 when both periods are empty. */
function trendPct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100 * 10) / 10;
}

// Page

/** The minutes-card usage summary — from api.profile.usage(), or seeded from the
 *  persisted trial store so the card renders correctly on first paint. */
interface UsageSummary {
  callsHandled: number;
  minutesUsed: number;
  planMinutes: number;
  percent: number;
  unlimited: boolean;
}

/** Derive the usage summary from the trial store's entitlement (same server
 *  source as loadUsage), so the minutes card is correct before the fetch lands. */
function usageFromTrial(trial: TrialState | null): UsageSummary | null {
  if (!trial) return null;
  // Unlimited (admin) entitlements report 0 used — the real figure only comes from loadUsage(), so
  // seeding would flash "0 min". Return null and let the skeleton show; capped plans seed reliably.
  if (trial.unlimited || trial.planMinutes <= 0) return null;
  const percent = Math.min(100, Math.round((trial.minutesUsed / trial.planMinutes) * 100));
  return {
    callsHandled: 0, // not shown on this card; loadUsage() refreshes the real value
    minutesUsed: trial.minutesUsed,
    planMinutes: trial.planMinutes,
    percent,
    unlimited: false,
  };
}

export default function DashboardPage() {
  const t = useT();
  const navigate = useNavigate();
  const calls = useCallsStore((s) => s.calls);
  const assistantName = useAgentStore((s) => s.config.identity.assistantName);
  const tz = useAgentStore((s) => ianaTimeZone(s.config.rules.timezone));
  const user = useAuthStore((s) => s.user);
  const profile = useProfileStore((s) => s.profile);
  const loadUsage = useProfileStore((s) => s.loadUsage);
  const callsLoaded = useCallsStore((s) => s.loaded);
  // Live heartbeat: reload the usage card each tick and bump refreshKey so the analytics window advances.
  const liveTick = useLiveTick();
  // Seed the minutes card from the persisted trial store — starting null made the card briefly show a
  // DIFFERENT metric (total call minutes) before loadUsage() resolved: the "55 min → 0 / 200 min" flash.
  const trial = useTrialStore((s) => s.trial);
  const [usage, setUsage] = useState<UsageSummary | null>(() => usageFromTrial(trial));
  useEffect(() => {
    void loadUsage().then((u) => u && setUsage(u));
    // Refresh call logs here, not in the global driver, so other routes don't fetch a list they never show.
    void useCallsStore.getState().hydrate();
  }, [loadUsage, liveTick]);
  const agentStatus = useAgentStore((s) => s.status);
  // "Connected" only when the agent is actually live (admin-approved & deployed
  // to Vapi) AND a receptionist number is in place — not merely a saved number.
  const numberConnected =
    agentStatus === "approved" && (profile.numberActivated || Boolean(profile.receptionistNumber));
  // One assistant per account; it counts as "active" only when actually live.
  const activeAssistants = numberConnected ? 1 : 0;
  const isAdmin = isAdminRole(user?.role);
  const firstName = (user?.fullName || "").trim().split(/\s+/)[0] || "there";

  const [typeFilter, setTypeFilter] = useState<CallTypeFilter>("all");
  const [range, setRange] = useState<RangeKey>("14d");
  const [customStart, setCustomStart] = useState(() => toDateInput(rangeStart("14d", new Date())));
  const [customEnd, setCustomEnd] = useState(() => toDateInput(new Date()));
  // Bumped by Refresh + each live tick; also advances `now` so post-mount calls aren't clipped by a stale upper bound.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Re-derive analytics on every live refresh so new calls surface with no reload.
  useEffect(() => {
    if (liveTick > 0) setRefreshKey((k) => k + 1);
  }, [liveTick]);

  /** Real current time, recomputed on mount and on each Refresh so the window's
   *  upper bound never lags behind freshly-logged calls. */
  const now = useMemo(() => new Date(), [refreshKey]);

  const filtered = useMemo(() => {
    const { start, end } = resolveWindow(range, customStart, customEnd, now);
    return calls.filter((c) => {
      if (typeFilter !== "all" && c.type !== typeFilter) return false;
      const t = new Date(c.createdAt).getTime();
      return t >= start && t <= end;
    });
    // refreshKey is an intentional dependency so Refresh re-reads the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, typeFilter, range, customStart, customEnd, refreshKey]);

  const a = useMemo(() => deriveAnalytics(filtered, tz), [filtered, tz]);

  /* Calls in the previous equal-length window (immediately before the current
     one), so metric cards can show real period-over-period movement. */
  const prevFiltered = useMemo(() => {
    const { start, end } = resolveWindow(range, customStart, customEnd, now);
    const span = end - start;
    const prevStart = start - span;
    const prevEnd = start;
    return calls.filter((c) => {
      if (typeFilter !== "all" && c.type !== typeFilter) return false;
      const t = new Date(c.createdAt).getTime();
      return t >= prevStart && t < prevEnd;
    });
    // refreshKey is an intentional dependency so Refresh re-reads the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, typeFilter, range, customStart, customEnd, refreshKey]);

  const prev = useMemo(() => deriveAnalytics(prevFiltered, tz), [prevFiltered, tz]);

  const minutesRemaining = usage
    ? Math.max(0, Math.round((usage.planMinutes - usage.minutesUsed) * 10) / 10)
    : 0;

  /* The resolved window as yyyy-mm-dd, for the calendar range picker. */
  const win = useMemo(
    () => resolveWindow(range, customStart, customEnd, now),
    [range, customStart, customEnd, now],
  );
  const startYmd = new Date(win.start).toISOString().slice(0, 10);
  const endYmd = new Date(win.end).toISOString().slice(0, 10);
  const maxYmd = toDateInput(now);

  /* Build the by-hour mini series (compressed to a handful of buckets). */
  const hourSeries = useMemo(() => {
    const compressed: number[] = [];
    for (let h = 6; h <= 20; h += 1) compressed.push(a.hourBuckets[h]);
    return compressed.length ? compressed : [0];
  }, [a.hourBuckets]);

  /* Real average completed-call duration (seconds) per hour bucket (6am–8pm),
     for the Avg Duration sparkline — no placeholder values. */
  const durationSeries = useMemo(() => {
    const sums = new Array<number>(24).fill(0);
    const counts = new Array<number>(24).fill(0);
    for (const c of filtered) {
      if (c.outcome !== "completed") continue;
      const h = hourInZone(c.createdAt, tz);
      sums[h] += c.durationSec;
      counts[h] += 1;
    }
    const out: number[] = [];
    for (let h = 6; h <= 20; h += 1) out.push(counts[h] ? Math.round(sums[h] / counts[h]) : 0);
    return out.length ? out : [0];
  }, [filtered, tz]);

  const compressedPeak = Math.max(0, a.peakIndex - 6);

  const refresh = async () => {
    if (refreshing) return; // guard against rapid double-clicks
    setRefreshing(true);
    try {
      // Re-read the freshest data from the store and force the memos to recompute.
      await useCallsStore.getState().hydrate();
      setRefreshKey((k) => k + 1);
      const count = useCallsStore.getState().calls.length;
      // Reuse one toast id so repeated refreshes update in place instead of stacking.
      toast.success("Refreshed", {
        id: "dashboard-refresh",
        description: `Analytics updated just now · ${count} calls in store.`,
      });
    } finally {
      setRefreshing(false);
    }
  };

  const completed = a.outcomeCounts.completed ?? 0;
  const missed = a.outcomeCounts.missed ?? 0;
  const voicemail = a.outcomeCounts.voicemail ?? 0;
  const other = a.outcomeCounts.failed ?? 0;

  const donutSegments = [
    { label: "Completed", value: completed, color: CHART_COLORS.success },
    { label: "Missed", value: missed, color: CHART_COLORS.danger },
    { label: "Voicemail", value: voicemail, color: CHART_COLORS.warning },
    { label: "Other", value: other, color: CHART_COLORS.grey },
  ];

  if (!callsLoaded && calls.length === 0) {
    return <PageSkeleton variant="cards" stats={4} />;
  }

  // Filter controls — defined once and reused by the inline desktop toolbar and
  // the collapsed "Filters" sheet shown on tablet & phone (below lg).
  const statusPill = (
    <StatusPill
      label={numberConnected ? t("dashboard.connected") : t("dashboard.setup_pending")}
      tone={numberConnected ? "success" : "neutral"}
    />
  );

  const typeSelect = (
    <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as CallTypeFilter)}>
      <SelectTrigger className="h-9 w-[130px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Calls</SelectItem>
        <SelectItem value="Phone">Phone</SelectItem>
        <SelectItem value="Web">Web</SelectItem>
      </SelectContent>
    </Select>
  );

  const refreshButton = (
    <Button
      variant="outline"
      size="icon"
      className="size-9"
      onClick={refresh}
      disabled={refreshing}
      aria-label="Refresh"
      aria-busy={refreshing}
    >
      <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
    </Button>
  );

  const rangePicker = (
    <DateRangePicker
      start={startYmd}
      end={endYmd}
      max={maxYmd}
      onChange={(s, e) => {
        setCustomStart(s);
        setCustomEnd(e);
        setRange("custom");
        toast.success("Custom range applied", { description: `${s} → ${e}` });
      }}
    />
  );

  const presetButtons = (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
      {(["today", "7d", "14d", "mtd"] as const).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setRange(k)}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
            range === k
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {RANGE_LABEL[k]}
        </button>
      ))}
    </div>
  );

  // A non-default selection surfaces a dot on the mobile Filters button.
  const filtersActive = typeFilter !== "all" || range !== "14d";

  return (
    <div>
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        className="mb-4"
      />

      {/* Filter toolbar — full inline layout on desktop (lg+) */}
      <div className="mb-5 hidden flex-wrap items-center justify-between gap-3 lg:flex">
        <div className="flex items-center gap-2">
          {statusPill}
          {typeSelect}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {refreshButton}
          {rangePicker}
          {presetButtons}
        </div>
      </div>

      {/* Filter toolbar — collapsed behind a Filters button on tablet & phone */}
      <div className="mb-5 flex items-center justify-between gap-2 lg:hidden">
        {statusPill}
        <div className="flex items-center gap-2">
          {refreshButton}
          <Button
            variant="outline"
            className="h-9 gap-2"
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal className="size-4" />
            Filters
            {filtersActive && <span className="size-2 rounded-full bg-primary" aria-hidden />}
          </Button>
        </div>
      </div>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent className="max-w-sm">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Call type
              </p>
              {typeSelect}
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Date range
              </p>
              <div className="flex flex-col items-start gap-3">
                {presetButtons}
                {rangePicker}
              </div>
            </div>
          </div>
          <div className="border-t border-border p-4">
            <SheetClose asChild>
              <Button className="w-full">Done</Button>
            </SheetClose>
          </div>
        </SheetContent>
      </Sheet>

      {/* Hero summary banner */}
      <div className="animate-rise relative mb-5 flex flex-wrap items-center justify-between gap-5 overflow-hidden rounded-[var(--radius-card)] bg-[linear-gradient(110deg,#1E63DD_0%,#2C76ED_50%,#5B93F2_100%)] p-6 text-white shadow-[var(--shadow-soft)]">
        {/* soft floating glow accents */}
        <span
          aria-hidden
          className="animate-glow pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-white/20 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-24 left-1/3 size-56 rounded-full bg-white/10 blur-3xl"
        />

        <div className="relative flex min-w-0 items-center gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white backdrop-blur-sm">
            {isAdmin ? <ShieldCheck className="size-6" /> : <Sparkles className="size-6" />}
          </span>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold backdrop-blur-sm">
              {isAdmin ? "Admin Account" : `${assistantName} is live`}
            </span>
            <h2 className="mt-1.5 text-xl font-bold tracking-tight sm:text-2xl">
              {t("dashboard.welcome", { name: firstName })}
            </h2>
            <p className="mt-1 text-sm text-white/80">
              {isAdmin
                ? `${a.callCount} calls · ${a.successRate}% success`
                : `${a.successRate}% success rate`}
            </p>
          </div>
        </div>

        <div className="relative flex shrink-0 items-center gap-1 sm:gap-2">
          <HeroStat label="Calls" value={String(a.callCount)} />
          <span className="h-10 w-px bg-white/25" />
          <HeroStat label="Success" value={`${a.successRate}%`} />
          <span className="h-10 w-px bg-white/25" />
          <HeroStat label="Leads" value={String(a.leadsCaptured)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {/* 1. Calling Minutes Used */}
        <MetricCard
          accent="#2C76ED"
          index={0}
          title={t("dashboard.calling_minutes")}
          icon={<Clock />}
          value={
            usage?.unlimited
              ? `${usage.minutesUsed} min`
              : usage
                ? `${usage.minutesUsed} / ${usage.planMinutes} min`
                : // Genuinely unknown (brand-new session, before the trial store
                  // hydrates) — a skeleton, NOT total call minutes: that's a
                  // different metric and caused the "55 min → 0/200" flash.
                  <Skeleton className="h-8 w-28" />
          }
          caption={usage?.unlimited ? "unlimited minutes" : usage ? "of your plan used" : " "}
          chart={
            <div className="flex items-center justify-center py-1">
              <RadialGauge percent={usage?.percent ?? 0} color={CHART_COLORS.primary} />
            </div>
          }
          footer={
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {usage?.unlimited ? "No limit" : `${minutesRemaining} min remaining`}
              </span>
              <span className="font-medium text-foreground">
                {usage?.unlimited ? "∞" : `${usage?.percent ?? 0}% used`}
              </span>
            </div>
          }
        />

        {/* 2. Number of Calls */}
        <MetricCard
          accent="#7C5CFC"
          index={1}
          title={t("dashboard.num_calls")}
          icon={<PhoneCall />}
          value={a.callCount}
          trend={trendPct(a.callCount, prev.callCount)}
          caption="vs previous period · view inbox"
          onClick={() => navigate("/dashboard/calls")}
          chart={
            <div className="flex items-center gap-4">
              <DonutChart
                segments={donutSegments}
                centerLabel={String(a.callCount)}
                centerSub="calls"
              />
              <div className="flex-1">
                <Sparkline values={hourSeries} height={40} />
              </div>
            </div>
          }
          footer={
            <div className="grid grid-cols-2 gap-1.5">
              <LegendDot color={CHART_COLORS.success} label="Completed" value={completed} />
              <LegendDot color={CHART_COLORS.danger} label="Missed" value={missed} />
              <LegendDot color={CHART_COLORS.warning} label="Voicemail" value={voicemail} />
              <LegendDot color={CHART_COLORS.grey} label="Other" value={other} />
            </div>
          }
        />

        {/* 3. Active Assistants */}
        <MetricCard
          accent="#06B6D4"
          index={2}
          title={t("dashboard.active_assistants")}
          icon={<Users />}
          value={String(activeAssistants)}
          caption={
            activeAssistants ? `${assistantName} is live · configure` : `${assistantName} · not live yet`
          }
          onClick={() => navigate("/dashboard/assistant")}
          chart={
            <div className="flex items-center justify-center py-1">
              <DonutChart
                segments={[
                  { label: "Active", value: activeAssistants, color: CHART_COLORS.primary },
                  { label: "Idle", value: 1 - activeAssistants, color: CHART_COLORS.grey },
                ]}
                size={96}
                centerLabel={String(activeAssistants)}
                centerSub="active"
              />
            </div>
          }
          footer={
            <div className="flex items-center justify-between text-xs">
              <LegendDot color={CHART_COLORS.primary} label="Active" value={activeAssistants} />
              <span className="text-muted-foreground">of 1 configured</span>
            </div>
          }
        />

        {/* 4. Peak Calls Time */}
        <MetricCard
          accent="#F59E0B"
          index={3}
          title={t("dashboard.peak_time")}
          icon={<TrendingUp />}
          value={a.peakLabel}
          caption="Busiest window"
          chart={<HourBars values={hourSeries} peakIndex={compressedPeak} height={56} />}
          footer={
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>6am</span>
              <span>1pm</span>
              <span>8pm</span>
            </div>
          }
        />

        {/* 5. Avg Call Duration */}
        <MetricCard
          accent="#0EA5E9"
          index={4}
          title={t("dashboard.avg_duration")}
          icon={<Timer />}
          value={formatDuration(a.avgDurationSec)}
          trend={trendPct(a.avgDurationSec, prev.avgDurationSec)}
          caption="completed calls"
          chart={
            <Sparkline values={durationSeries} color={CHART_COLORS.primary} height={56} />
          }
        />

        {/* 6. Success Rate + Leads captured */}
        <MetricCard
          accent="#10B981"
          index={5}
          title={t("dashboard.success_rate")}
          icon={<CheckCircle2 />}
          value={`${a.successRate}%`}
          trend={trendPct(a.successRate, prev.successRate)}
          caption="calls handled end-to-end"
          chart={
            <div className="flex items-center justify-center py-1">
              <RadialGauge percent={a.successRate} color={CHART_COLORS.success} />
            </div>
          }
          footer={
            <div className="flex items-center justify-between text-xs">
              <LegendDot color={CHART_COLORS.success} label="Leads captured" />
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <UserCheck className="size-3.5 text-success" />
                {a.leadsCaptured}
              </span>
            </div>
          }
        />
      </div>
    </div>
  );
}

/** Compact stat shown inside the hero banner. */
function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-3 text-center sm:px-5">
      <span className="text-2xl font-bold leading-none tracking-tight">{value}</span>
      <span className="mt-1.5 text-[11px] font-medium uppercase tracking-wide text-white/70">
        {label}
      </span>
    </div>
  );
}
