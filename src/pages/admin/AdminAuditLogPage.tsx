import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ScrollText, Search, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataCard,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError, type AuditLogEntry } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { cn, formatDate } from "@/lib/utils";
import { TableSkeleton } from "@/components/ui/skeleton";

const ALL_ACTIONS = "__all__";

function targetLabel(e: AuditLogEntry): string {
  if (!e.targetType) return "—";
  return e.targetId ? `${e.targetType} · ${e.targetId.slice(0, 10)}` : e.targetType;
}

export default function AdminAuditLogPage() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [action, setAction] = useState<string>(ALL_ACTIONS);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  // Paging is server-side here (the log can run to tens of thousands of rows),
  // so the page size travels with the request rather than slicing locally.
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);

  // Debounce the free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Any filter change resets back to the first page.
  useEffect(() => {
    setPage(1);
  }, [action, debouncedSearch, from, to]);

  // `silent` background refreshes (live heartbeat) skip the skeleton + error
  // toast so newly-recorded audit events appear without a manual reload.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.admin.audit({
        action: action === ALL_ACTIONS ? undefined : action,
        search: debouncedSearch || undefined,
        // Date inputs are day-granular; span the full local day on each end.
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        page,
        pageSize,
      });
      setRows(data.rows);
      setTotal(data.total);
      // Keep the full action list stable even while a filter narrows results.
      if (data.actions.length) setActions(data.actions);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load audit log");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [action, debouncedSearch, from, to, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: silently refetch with the current filters/page on each tick.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  const filtersActive =
    action !== ALL_ACTIONS || debouncedSearch !== "" || from !== "" || to !== "";

  function clearFilters() {
    setAction(ALL_ACTIONS);
    setSearch("");
    setFrom("");
    setTo("");
  }

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Recent admin and ops actions across the platform."
        actions={
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor, target, or IP…"
            className="pl-9"
          />
        </div>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="lg:w-56">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="From date"
            className="sm:w-[150px]"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            aria-label="To date"
            className="sm:w-[150px]"
          />
        </div>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="shrink-0">
            <X className="size-4" /> Clear
          </Button>
        )}
      </div>

      {loading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ScrollText className="size-6" />
              </span>
              <p className="text-sm font-medium">
                {filtersActive ? "No matching entries" : "No audit entries yet"}
              </p>
              <p className="text-sm text-muted-foreground">
                {filtersActive
                  ? "Try adjusting your filters."
                  : "Admin actions will appear here as they happen."}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop — table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Actor</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                      <th className="px-4 py-3 font-medium">Target</th>
                      <th className="px-4 py-3 font-medium">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(e.createdAt)}</td>
                        <td className="px-4 py-3">
                          {e.actorEmail || "—"}
                          {e.actorBrandName && (
                            <span className="ml-2 text-xs text-muted-foreground">{e.actorBrandName}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="primary">{e.action}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{targetLabel(e)}</td>
                        <td className="px-4 py-3 text-muted-foreground tabular-nums">{e.ip || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile — cards */}
              <div className="space-y-3 p-3 md:hidden">
                {rows.map((e) => (
                  <DataCard key={e.id}>
                    <DataCardHeader
                      title={e.actorEmail || "—"}
                      subtitle={formatDate(e.createdAt)}
                    />
                    <DataCardPills>
                      <Badge variant="primary">{e.action}</Badge>
                    </DataCardPills>
                    <DataCardGrid>
                      <CardField label="Target">{targetLabel(e)}</CardField>
                      <CardField label="IP">
                        <span className="tabular-nums">{e.ip || "—"}</span>
                      </CardField>
                    </DataCardGrid>
                  </DataCard>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        noun="entries"
        disabled={loading}
      />
    </div>
  );
}
