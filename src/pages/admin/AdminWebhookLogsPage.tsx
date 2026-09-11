import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  api,
  ApiError,
  type WebhookDeliveryLog,
  type WebhookDeliveryStatus,
} from "@/lib/api";
import {
  DataCard,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { cn, formatDate } from "@/lib/utils";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";

const FILTERS: { key: WebhookDeliveryStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "success", label: "Successful" },
  { key: "failed", label: "Failed" },
];

export default function AdminWebhookLogsPage() {
  const [rows, setRows] = useState<WebhookDeliveryLog[]>([]);
  const [filter, setFilter] = useState<WebhookDeliveryStatus>("all");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  // Switching the status filter refetches, so start that result set at page 1.
  const {
    page,
    pageSize,
    pageItems: pageRows,
    total,
    setPage,
    setPageSize,
  } = usePagination(rows, { resetKey: filter });

  // `silent` background refreshes (live heartbeat) skip the skeleton + error
  // toast so new webhook deliveries appear without a manual reload.
  const load = useCallback(async (status: WebhookDeliveryStatus, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.admin.webhookDeliveries(status);
      setRows(data);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load deliveries");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Live refresh: silently refetch the current filter on each tick.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(filter, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  async function retry(id: string) {
    setRetrying(id);
    try {
      const result = await api.admin.retryWebhook(id);
      if (result.success) toast.success(`Retry succeeded (HTTP ${result.status})`);
      else toast.error(result.errorMessage || `Retry failed (HTTP ${result.status})`);
      await load(filter);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Retry failed");
    } finally {
      setRetrying(null);
    }
  }

  const statusBadge = (d: WebhookDeliveryLog) => (
    <Badge variant={d.success ? "success" : "danger"}>
      {d.success ? `OK ${d.status}` : d.status === 0 ? "Network" : `HTTP ${d.status}`}
    </Badge>
  );

  const renderRetry = (d: WebhookDeliveryLog) =>
    !d.success && (
      <Button
        variant="outline"
        size="sm"
        onClick={() => retry(d.id)}
        disabled={retrying === d.id}
      >
        {retrying === d.id ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        Retry
      </Button>
    );

  const renderDetail = (d: WebhookDeliveryLog) => (
    <>
      {d.errorMessage && <p className="mb-2 text-sm text-danger">Error: {d.errorMessage}</p>}
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Response body
      </p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs text-foreground/80">
        {d.responseBody || "(empty)"}
      </pre>
    </>
  );

  return (
    <div>
      <PageHeader
        title="Webhook Logs"
        subtitle="Delivery attempts to customer CRMs and the global Nexleon pipeline."
        actions={
          <Button variant="outline" size="sm" onClick={() => load(filter)} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="mb-5 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
              filter === f.key
                ? "bg-primary-tint text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <TableSkeleton rows={6} cols={7} />
      ) : (
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Webhook className="size-6" />
            </span>
            <p className="text-sm font-medium">No deliveries found</p>
            <p className="text-sm text-muted-foreground">Webhook delivery attempts will appear here.</p>
          </div>
        ) : (
          <>
          {/* Desktop — table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium" />
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">URL</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Latency</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((d) => {
                  const open = expanded === d.id;
                  return (
                    <Fragment key={d.id}>
                      <tr
                        className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40"
                        onClick={() => setExpanded(open ? null : d.id)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">
                          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </td>
                        <td className="px-4 py-3 font-medium">{d.provider}</td>
                        <td className="max-w-[280px] truncate px-4 py-3 text-muted-foreground" title={d.url}>
                          {d.url}
                        </td>
                        <td className="px-4 py-3">{statusBadge(d)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{d.durationMs}ms</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(d.createdAt)}</td>
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {renderRetry(d)}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-border/60 bg-muted/30">
                          <td colSpan={7} className="px-4 py-4">
                            {renderDetail(d)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile — cards */}
          <div className="space-y-3 p-3 md:hidden">
            {pageRows.map((d) => {
              const open = expanded === d.id;
              return (
                <DataCard key={d.id} onClick={() => setExpanded(open ? null : d.id)}>
                  <DataCardHeader
                    lead={
                      <span className="mt-0.5 text-muted-foreground">
                        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </span>
                    }
                    title={d.provider}
                    subtitle={d.url}
                    actions={renderRetry(d) || undefined}
                  />
                  <DataCardPills>{statusBadge(d)}</DataCardPills>
                  <DataCardGrid>
                    <CardField label="Latency">
                      <span className="tabular-nums">{d.durationMs}ms</span>
                    </CardField>
                    <CardField label="Time">{formatDate(d.createdAt)}</CardField>
                  </DataCardGrid>
                  {open && (
                    <div className="mt-3 border-t border-border/60 pt-3">{renderDetail(d)}</div>
                  )}
                </DataCard>
              );
            })}
          </div>
          </>
        )}
      </div>
      )}

      {!loading && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          noun="deliveries"
        />
      )}
    </div>
  );
}
