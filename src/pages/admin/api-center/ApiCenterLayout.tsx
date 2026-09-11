import { NavLink, Outlet, useLocation } from "react-router-dom";
import { AlertTriangle, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { ApiCenterProvider, useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import { FilterBar } from "@/components/admin/api-center/FilterBar";
import { ProviderDrawer } from "@/components/admin/api-center/ProviderDrawer";
import { API_CENTER_BASE, API_CENTER_SECTIONS, sectionPath } from "@/components/admin/api-center/sections";
import { timeAgo } from "@/components/charts/primitives";

/* ------------------------------------------------------------------ *
 *  The API Center shell.
 *
 *  Holds the one snapshot fetch, the shared filter row, the section rail and the
 *  provider drawer. Sections render into the <Outlet/> and never fetch the
 *  snapshot themselves, so switching sections is instant and every screen is
 *  describing the same moment in time.
 * ------------------------------------------------------------------ */

/**
 * The section tabs.
 *
 * Styled to match the app's Tabs primitive (a muted track with a raised active
 * pill) but built from NavLinks over real routes rather than local tab state —
 * so the browser back button, a page refresh and a shared link all land on the
 * section you were actually looking at. Tab state alone would lose all three.
 */
function SectionTabs() {
  const { pathname } = useLocation();
  const { snapshot } = useApiCenter();
  const openAlerts = snapshot?.totals.openAlerts ?? 0;

  return (
    <nav
      className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-muted p-1"
      aria-label="API Center sections"
      role="tablist"
    >
      {API_CENTER_SECTIONS.map((s) => {
        const to = sectionPath(s.slug);
        // The index route needs an exact match, or every section lights it up.
        const active =
          s.slug === ""
            ? pathname === API_CENTER_BASE || pathname === `${API_CENTER_BASE}/`
            : pathname.startsWith(to);
        const Icon = s.icon;
        return (
          <NavLink
            key={s.slug || "overview"}
            to={to}
            end={s.slug === ""}
            role="tab"
            aria-selected={active}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {s.label}
            {/* Open alerts are listed on Overview, so its tab carries the count —
                visible from whichever section you happen to be in. */}
            {s.slug === "" && openAlerts > 0 && (
              <span className="ml-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular-nums">
                {openAlerts}
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function ApiCenterHeader() {
  const { snapshot, error, loading } = useApiCenter();
  const { pathname } = useLocation();
  const section =
    API_CENTER_SECTIONS.find((s) => s.slug && pathname.startsWith(sectionPath(s.slug))) ??
    API_CENTER_SECTIONS[0];

  return (
    <PageHeader
      title="API Center"
      subtitle={section.blurb}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {error ? (
            <Badge variant="danger" className="gap-1.5">
              <AlertTriangle className="size-3.5" />
              Showing last known data
            </Badge>
          ) : (
            !loading &&
            snapshot && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:hidden" />
                  <span className="relative inline-flex size-2 rounded-full bg-success" />
                </span>
                Live · updated {timeAgo(snapshot.generatedAt)}
              </span>
            )
          )}
        </div>
      }
    />
  );
}

/**
 * Warn when the tracer had to drop rows. The screens would otherwise show a
 * quiet period that never happened, which is the one way a monitoring dashboard
 * can actively mislead.
 */
function DroppedRowsNotice() {
  const { snapshot } = useApiCenter();
  if (!snapshot || snapshot.droppedRows === 0) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-tint p-3 text-xs text-warning">
      <Radio className="mt-px size-4 shrink-0" />
      <p>
        <strong className="font-semibold tabular-nums">{snapshot.droppedRows}</strong> telemetry rows were
        dropped since the last restart — the write buffer filled while the database was unreachable. Counts
        below may under-report for that period.
      </p>
    </div>
  );
}

function ApiCenterShell() {
  return (
    <div>
      <ApiCenterHeader />
      <SectionTabs />
      <FilterBar className="mb-4" />
      <DroppedRowsNotice />
      <Outlet />
      <ProviderDrawer />
    </div>
  );
}

export default function ApiCenterLayout() {
  return (
    <ApiCenterProvider>
      <ApiCenterShell />
    </ApiCenterProvider>
  );
}
