import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, ListChecks, PhoneMissed, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSkeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/utils";
import { useCallsStore } from "@/stores/useCallsStore";
import { useLiveTick } from "@/hooks/useLiveData";
import type { CallIntent, CallOutcome } from "@/types";
import {
  CALL_INTENTS,
  computeStats,
  DATE_PRESET_LABELS,
  type DatePreset,
  INTENT_HINTS,
  INTENT_LABELS,
  withinPreset,
} from "./callUtils";
import { CallTable } from "./CallTable";
import { CallDetailPanel } from "./CallDetailPanel";

type OutcomeFilter = "all" | CallOutcome;
type IntentFilter = "all" | CallIntent;

function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
      <span className="flex size-10 items-center justify-center rounded-full bg-primary-tint text-primary">
        {icon}
      </span>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

export default function CallInboxPage() {
  const calls = useCallsStore((s) => s.calls);
  const loaded = useCallsStore((s) => s.loaded);
  const selectedId = useCallsStore((s) => s.selectedId);
  const select = useCallsStore((s) => s.select);

  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [intent, setIntent] = useState<IntentFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");

  // Keep the inbox live while it's open: refetch the call logs on mount and on
  // every live tick (the global heartbeat also ticks on tab focus), so new calls
  // appear without a manual reload. Scoped to this page — other routes don't pull
  // the full call list they never display.
  const liveTick = useLiveTick();
  useEffect(() => {
    void useCallsStore.getState().hydrate();
  }, [liveTick]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const q = search.trim().toLowerCase();
    return calls.filter((call) => {
      if (outcome !== "all" && call.outcome !== outcome) return false;
      if (intent !== "all" && call.intent !== intent) return false;
      if (!withinPreset(call, datePreset, now)) return false;
      if (q) {
        const haystack = `${call.summary} ${call.callerName} ${call.callerNumber}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [calls, search, outcome, intent, datePreset]);

  const stats = useMemo(() => computeStats(filtered), [filtered]);
  const selectedCall = useMemo(
    () => calls.find((c) => c.id === selectedId) ?? null,
    [calls, selectedId],
  );

  if (!loaded && calls.length === 0) {
    return <PageSkeleton variant="table" />;
  }

  return (
    <div>
      <PageHeader title="Call Logs" subtitle="Every call, transcribed and analyzed." />

      {/* Filter bar */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter summaries…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Filter summaries"
          />
        </div>

        <div className="w-full sm:w-44">
          <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
            <SelectTrigger aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {DATE_PRESET_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Category — the filter owners reach for first ("just show me bookings"). */}
        <div className="w-full sm:w-52">
          <Select value={intent} onValueChange={(v) => setIntent(v as IntentFilter)}>
            <SelectTrigger aria-label="Call category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {CALL_INTENTS.map((key) => (
                <SelectItem key={key} value={key} hint={INTENT_HINTS[key]}>
                  {INTENT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full sm:w-44">
          <Select value={outcome} onValueChange={(v) => setOutcome(v as OutcomeFilter)}>
            <SelectTrigger aria-label="Outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Outcomes</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="missed">Missed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="voicemail">Voicemail</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Stat strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total" value={String(stats.total)} icon={<ListChecks className="size-5" />} />
        <StatTile
          label="Success %"
          value={`${stats.successPct}%`}
          icon={<CheckCircle2 className="size-5" />}
        />
        <StatTile
          label="Avg Duration"
          value={formatDuration(stats.avgCompletedSec)}
          icon={<Clock className="size-5" />}
        />
        <StatTile
          label="Missed %"
          value={`${stats.missedPct}%`}
          icon={<PhoneMissed className="size-5" />}
        />
      </div>

      <CallTable
        calls={filtered}
        selectedId={selectedId}
        onSelect={(id) => select(id)}
        filtersActive={
          Boolean(search.trim()) || outcome !== "all" || intent !== "all" || datePreset !== "all"
        }
        onClearFilters={() => {
          setSearch("");
          setOutcome("all");
          setIntent("all");
          setDatePreset("all");
        }}
      />

      {selectedCall && (
        <CallDetailPanel
          call={selectedCall}
          onClose={() => select(null)}
        />
      )}
    </div>
  );
}
