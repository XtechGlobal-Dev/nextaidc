import * as React from "react";
import { Filter, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Segmented } from "./shared";
import { useApiCenter, type EnvFilter, type HealthFilter } from "./ApiCenterContext";
import type { RangeKey } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  The one filter row, shared by every section.
 *
 *  Only two controls are always on show — the time range and search — because
 *  those are the two an operator reaches for constantly. Category, status and
 *  environment sit behind a "Filters" toggle: they're occasional, and five
 *  dropdowns permanently across the top was a large part of what made this
 *  screen feel heavy.
 *
 *  Filters persist across sections, so chasing a provider from Overview to
 *  Activity never means re-typing its name.
 * ------------------------------------------------------------------ */

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1h", label: "1h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const HEALTH_OPTIONS: { key: HealthFilter; label: string }[] = [
  { key: "all", label: "All statuses" },
  { key: "attention", label: "Needs attention" },
  { key: "healthy", label: "Healthy" },
  { key: "degraded", label: "Warning" },
  { key: "failed", label: "Failed" },
  { key: "disconnected", label: "Disconnected" },
];

const ENV_OPTIONS: { key: EnvFilter; label: string }[] = [
  { key: "all", label: "All environments" },
  { key: "production", label: "Production" },
  { key: "sandbox", label: "Sandbox" },
];

const selectClass =
  "h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground transition-colors hover:bg-muted focus-visible:focus-ring";

export function FilterBar({ className }: { className?: string }) {
  const { filters, setFilters, resetFilters, snapshot, visibleProviders } = useApiCenter();
  const categories = snapshot?.categories ?? [];

  const activeCount =
    (filters.category !== "all" ? 1 : 0) +
    (filters.health !== "all" ? 1 : 0) +
    (filters.environment !== "all" ? 1 : 0);
  // Open the drawer automatically when a filter is already applied, so an active
  // filter is never invisible.
  const [open, setOpen] = React.useState(activeCount > 0);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filters.range}
          onChange={(range) => setFilters({ range })}
          options={RANGES}
          label="Time range"
          size="sm"
        />

        <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => setFilters({ search: e.target.value })}
            placeholder="Search providers…"
            aria-label="Search providers"
            className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-3 text-sm placeholder:text-muted-foreground focus-visible:focus-ring"
          />
        </div>

        <Button
          variant={open || activeCount > 0 ? "secondary" : "outline"}
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="h-9"
        >
          <Filter className="size-4" />
          Filters
          {activeCount > 0 && (
            <span className="grid size-4 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground tabular-nums">
              {activeCount}
            </span>
          )}
        </Button>

        {(activeCount > 0 || filters.search.trim()) && (
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {visibleProviders.length} of {snapshot?.providers.length ?? 0}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-warm p-2">
          <select
            value={filters.category}
            onChange={(e) => setFilters({ category: e.target.value })}
            aria-label="Filter by category"
            className={selectClass}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.label} ({c.providers})
              </option>
            ))}
          </select>

          <select
            value={filters.health}
            onChange={(e) => setFilters({ health: e.target.value as HealthFilter })}
            aria-label="Filter by status"
            className={selectClass}
          >
            {HEALTH_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={filters.environment}
            onChange={(e) => setFilters({ environment: e.target.value as EnvFilter })}
            aria-label="Filter by environment"
            className={selectClass}
          >
            {ENV_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>

          {activeCount > 0 && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className={cn("text-muted-foreground")}>
              <X className="size-4" /> Clear
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
