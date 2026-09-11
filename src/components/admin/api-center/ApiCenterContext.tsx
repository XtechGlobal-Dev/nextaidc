import * as React from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { deriveSeries, deriveTotals } from "./derive";
import type { ApiCenterSnapshot, ApiCenterTotals, ProviderRow, RangeKey, SeriesPoint } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  One snapshot, twelve screens.
 *
 *  Every API Center section is a view of the same provider rows, so they share a
 *  single fetch held here rather than each pulling its own. That keeps the
 *  numbers consistent across a tab switch (all screens describe the same moment),
 *  makes navigation instant, and means the live tick refreshes one request
 *  instead of twelve.
 *
 *  Filters live here too, so a range or environment chosen on Overview is still
 *  applied when the operator lands on Errors.
 * ------------------------------------------------------------------ */

export type EnvFilter = "all" | "production" | "sandbox";
export type HealthFilter = "all" | "attention" | "healthy" | "degraded" | "failed" | "disconnected";
/**
 * Which slice of the registry to show.
 *  - `inUse`  — providers this deployment actually calls (the default)
 *  - `all`    — plus every vendor the platform *could* integrate with
 */
export type ScopeFilter = "inUse" | "all";

export interface ApiCenterFilters {
  range: RangeKey;
  environment: EnvFilter;
  category: string;
  health: HealthFilter;
  search: string;
  scope: ScopeFilter;
}

/**
 * Totals and time series for whatever is currently *visible*.
 *
 * Every screen reads these instead of `snapshot.totals` / `snapshot.series`, so
 * narrowing to a category or searching for a provider changes the headline
 * numbers and the charts too — not just the list underneath them.
 */
export interface ApiCenterView {
  totals: ApiCenterTotals;
  series: SeriesPoint[];
  /** True when no filter is narrowing the fleet, i.e. these are the fleet totals. */
  isWholeFleet: boolean;
}

interface ApiCenterContextValue {
  snapshot: ApiCenterSnapshot | null;
  /** True only on the very first load — a background refresh must not flash skeletons. */
  loading: boolean;
  error: string | null;
  filters: ApiCenterFilters;
  setFilters: (patch: Partial<ApiCenterFilters>) => void;
  resetFilters: () => void;
  /** Providers after category/health/search filtering, attention-first. */
  visibleProviders: ProviderRow[];
  /** Totals + series recomputed for `visibleProviders`. Null before first load. */
  view: ApiCenterView | null;
  /** Refetch now (after an action that changes the data). */
  refresh: () => Promise<void>;
  /** Provider id whose detail panel is open, if any. */
  openProvider: string | null;
  setOpenProvider: (id: string | null) => void;
}

const DEFAULT_FILTERS: ApiCenterFilters = {
  range: "24h",
  environment: "all",
  category: "all",
  health: "all",
  search: "",
  // Default to what this deployment actually calls. Listing every vendor the
  // platform could ever integrate with buried the handful that matter under a
  // dozen permanently-grey "Not connected" rows.
  scope: "inUse",
};

const ApiCenterContext = React.createContext<ApiCenterContextValue | null>(null);

export function ApiCenterProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = React.useState<ApiCenterSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filters, setFiltersState] = React.useState<ApiCenterFilters>(DEFAULT_FILTERS);
  const [openProvider, setOpenProvider] = React.useState<string | null>(null);
  const liveTick = useLiveTick();

  const { range, environment } = filters;

  const load = React.useCallback(
    async (opts: { silent?: boolean } = {}) => {
      try {
        const res = await api.admin.apiCenter.snapshot(range, environment);
        setSnapshot(res);
        setError(null);
      } catch (e) {
        const message = e instanceof ApiError ? e.message : "Failed to load API Center data";
        setError(message);
        // Only shout on a load the operator is waiting for. A failed background
        // refresh leaves the last good data on screen and says so in the header.
        if (!opts.silent) toast.error(message);
      } finally {
        setLoading(false);
      }
    },
    [range, environment],
  );

  // Range/environment changes are user-initiated → surface failures.
  React.useEffect(() => {
    void load();
  }, [load]);

  // The live tick is a background refresh → stay quiet on failure.
  React.useEffect(() => {
    if (liveTick === 0) return;
    void load({ silent: true });
  }, [liveTick, load]);

  const setFilters = React.useCallback((patch: Partial<ApiCenterFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetFilters = React.useCallback(() => setFiltersState(DEFAULT_FILTERS), []);

  const visibleProviders = React.useMemo(() => {
    const rows = snapshot?.providers ?? [];
    const needle = filters.search.trim().toLowerCase();
    return rows.filter((p) => {
      if (filters.scope === "inUse" && !p.inUse) return false;
      if (filters.category !== "all" && p.category !== filters.category) return false;
      if (filters.health === "attention" && p.attentionScore === 0) return false;
      if (
        filters.health !== "all" &&
        filters.health !== "attention" &&
        p.health !== filters.health
      ) {
        return false;
      }
      if (!needle) return true;
      // Search the things an operator actually types: the vendor, what it does,
      // its category, and the error they're chasing.
      return (
        p.name.toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle) ||
        p.blurb.toLowerCase().includes(needle) ||
        p.categoryLabel.toLowerCase().includes(needle) ||
        p.lastErrorMessage.toLowerCase().includes(needle)
      );
    });
  }, [snapshot, filters.scope, filters.category, filters.health, filters.search]);

  // Derived from the outcome rather than from which controls are set: the
  // default scope already hides unused providers, and a category filter that
  // happens to match everything isn't really a narrowing.
  const narrowed = !!snapshot && visibleProviders.length !== snapshot.providers.length;

  const view = React.useMemo<ApiCenterView | null>(() => {
    if (!snapshot) return null;
    // Nothing is filtered out → the server's own totals are authoritative, and
    // reusing them avoids any chance of the two disagreeing by a rounding step.
    if (!narrowed) {
      return { totals: snapshot.totals, series: snapshot.series, isWholeFleet: true };
    }
    return {
      totals: deriveTotals(visibleProviders, snapshot),
      series: deriveSeries(visibleProviders, snapshot),
      isWholeFleet: false,
    };
  }, [snapshot, visibleProviders, narrowed]);

  const value: ApiCenterContextValue = {
    snapshot,
    loading,
    error,
    filters,
    setFilters,
    resetFilters,
    visibleProviders,
    view,
    refresh: () => load({ silent: true }),
    openProvider,
    setOpenProvider,
  };

  return <ApiCenterContext.Provider value={value}>{children}</ApiCenterContext.Provider>;
}

export function useApiCenter(): ApiCenterContextValue {
  const ctx = React.useContext(ApiCenterContext);
  if (!ctx) throw new Error("useApiCenter must be used inside <ApiCenterProvider>");
  return ctx;
}
