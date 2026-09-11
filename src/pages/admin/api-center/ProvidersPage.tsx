import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { BarChart3, Eye, EyeOff, HeartPulse, KeyRound, Lock, Plug, SearchX, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardSkeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/charts/Charts";
import { compactNumber, formatMs, formatPct, timeAgo } from "@/components/charts/primitives";
import { useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import {
  ApiCenterEmpty,
  EnvBadge,
  HealthPill,
  IncidentPill,
  QuotaMeter,
  Segmented,
} from "@/components/admin/api-center/shared";
import type { ApiKeyRow, ProviderRow } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Providers — every integration, in one table.
 *
 *  This replaces four separate screens (Connections, Health, Quotas, API Keys).
 *  They were never four different sets of rows — only four different questions
 *  about the same providers — so they're now four column sets behind one
 *  switcher. Switching a view is instant and never refetches the snapshot.
 *
 *  Rows stay grouped by category, which is how someone thinks about an
 *  integration stack ("what's our voice layer doing?"), and attention-first
 *  within each group so a broken provider is never buried under healthy ones.
 * ------------------------------------------------------------------ */

type View = "status" | "usage" | "quota" | "keys";

const VIEWS: { key: View; label: string; icon: typeof HeartPulse }[] = [
  { key: "status", label: "Status", icon: HeartPulse },
  { key: "usage", label: "Usage", icon: TrendingUp },
  { key: "quota", label: "Quota", icon: BarChart3 },
  { key: "keys", label: "Keys", icon: KeyRound },
];

/** Column headers per view — kept beside the row renderer so they can't drift. */
const HEADERS: Record<View, { label: string; align?: "right" | "center" }[]> = {
  status: [
    { label: "Status" },
    { label: "Uptime", align: "right" },
    { label: "Success", align: "right" },
    { label: "Vendor status" },
    { label: "Last error" },
  ],
  usage: [
    { label: "Requests", align: "right" },
    { label: "24h", align: "right" },
    { label: "p95", align: "right" },
    { label: "Trend" },
    { label: "Last call", align: "right" },
  ],
  quota: [
    { label: "Monthly quota" },
    { label: "Used", align: "right" },
    { label: "Rate-limit headroom" },
    { label: "Resets", align: "right" },
  ],
  keys: [{ label: "Auth" }, { label: "Credentials" }, { label: "Expiry" }, { label: "Environment" }],
};

export default function ApiCenterProvidersPage() {
  const { snapshot, loading, visibleProviders, setOpenProvider, resetFilters, filters, setFilters } =
    useApiCenter();
  const [view, setView] = React.useState<View>("status");
  const [keys, setKeys] = React.useState<ApiKeyRow[] | null>(null);

  const showingAll = filters.scope === "all";
  /** Registry providers this deployment doesn't call — hidden unless asked for. */
  const available = (snapshot?.providers ?? []).filter((p) => !p.inUse).length;

  // Credential status is its own endpoint and only the Keys view needs it —
  // fetched on first switch, then cached for the life of the page.
  React.useEffect(() => {
    if (view !== "keys" || keys) return;
    let active = true;
    (async () => {
      try {
        const res = await api.admin.apiCenter.keys();
        if (active) setKeys(res);
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load credential status");
      }
    })();
    return () => {
      active = false;
    };
  }, [view, keys]);

  if (loading && !snapshot) return <CardSkeleton rows={8} />;
  if (!snapshot) return null;

  if (visibleProviders.length === 0) {
    // A deployment with no credentials at all and no traffic yet has nothing
    // "in use" — that's a setup state, not an empty filter result, and it needs
    // a different sentence and a different button.
    const nothingInUse = !showingAll && available === snapshot.providers.length;
    return (
      <ApiCenterEmpty
        icon={showingAll ? SearchX : Plug}
        title={nothingInUse ? "No integrations in use yet" : "No providers match these filters"}
        message={
          nothingInUse
            ? "This environment holds no third-party credentials and hasn't recorded any API traffic. Save a key in Admin → Settings, or browse everything the platform can integrate with."
            : "Try a different category or status, or clear the search."
        }
        action={
          nothingInUse ? (
            <Button variant="outline" size="sm" onClick={() => setFilters({ scope: "all" })}>
              <Eye className="size-4" /> Show available providers
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          )
        }
      />
    );
  }

  const keyByProvider = new Map((keys ?? []).map((k) => [k.provider, k]));

  // Registry category order, not alphabetical — it puts the busiest, most
  // critical groups (voice, AI) first.
  //
  // Counts are recomputed from the VISIBLE rows rather than taken from the
  // server's category rollup, which covers every provider in the registry: with
  // unused ones hidden, "2/4 connected" above two rows was simply wrong.
  const groups = snapshot.categories
    .map((c) => {
      const rows = visibleProviders.filter((p) => p.category === c.category);
      return {
        category: c.category,
        label: c.label,
        rows,
        wired: rows.filter((p) => p.wired).length,
        connected: rows.filter((p) => p.wired && p.connected).length,
        requests: rows.reduce((s, p) => s + p.requests, 0),
      };
    })
    .filter((g) => g.rows.length > 0);

  const colCount = HEADERS[view].length + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={view} onChange={setView} options={VIEWS} label="Provider view" />
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {visibleProviders.length} {visibleProviders.length === 1 ? "provider" : "providers"}
          </span>
          {/* The registry knows about vendors this deployment doesn't touch.
              They're hidden by default and reachable in one click, rather than
              padding the table with permanently-grey rows. */}
          {available > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters({ scope: showingAll ? "inUse" : "all" })}
              className="text-muted-foreground"
            >
              {showingAll ? (
                <>
                  <EyeOff className="size-4" /> Hide unused
                </>
              ) : (
                <>
                  <Eye className="size-4" /> Show {available} available
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {view === "keys" && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-warm p-3 text-xs text-muted-foreground">
          <Lock className="mt-px size-4 shrink-0 text-primary" />
          <span>
            Secrets never reach the browser — values are masked to their last four characters by the server. Change a
            credential in{" "}
            <Link to="/dashboard/admin/settings" className="font-medium text-primary hover:underline">
              Admin → Settings
            </Link>
            .
          </span>
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Provider</th>
                {HEADERS[view].map((h) => (
                  <th
                    key={h.label}
                    className={cn(
                      "px-3 py-2 font-medium",
                      h.align === "right" && "text-right",
                      h.align === "center" && "text-center",
                    )}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <React.Fragment key={group.category}>
                  <tr className="border-y border-border bg-muted/40">
                    <td colSpan={colCount} className="px-5 py-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </span>
                      <span className="ml-2 text-[11px] text-muted-foreground tabular-nums">
                        {group.connected}/{group.wired} connected
                        {group.requests > 0 && ` · ${compactNumber(group.requests)} calls`}
                      </span>
                    </td>
                  </tr>
                  {group.rows.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setOpenProvider(p.id)}
                      className={cn(
                        "cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/50",
                        p.health === "not_configured" && "opacity-55",
                      )}
                    >
                      <td className="px-5 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{p.name}</span>
                          <EnvBadge environment={p.environment} />
                        </span>
                        {p.attentionReasons.length > 0 && (
                          <span className="block truncate text-[11px] text-warning" title={p.attentionReasons.join(" · ")}>
                            {p.attentionReasons[0]}
                          </span>
                        )}
                      </td>
                      <ViewCells view={view} p={p} keyRow={keyByProvider.get(p.id)} thresholds={snapshot.thresholds} />
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  One row's cells for the active view.
 * ------------------------------------------------------------------ */

function ViewCells({
  view,
  p,
  keyRow,
  thresholds,
}: {
  view: View;
  p: ProviderRow;
  keyRow: ApiKeyRow | undefined;
  thresholds: { quotaWarnPct: number; quotaFailPct: number; rateHeadroomWarnPct: number; latencyWarnMs: number; latencyFailMs: number };
}) {
  if (view === "status") {
    return (
      <>
        <td className="px-3 py-2.5">
          <HealthPill health={p.health} size="xs" />
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {p.requests > 0 ? (
            <span
              className={cn(
                "font-semibold",
                p.uptimePct >= 99 ? "text-success" : p.uptimePct >= 95 ? "text-warning" : "text-danger",
              )}
            >
              {formatPct(p.uptimePct)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
          {p.requests > 0 ? formatPct(p.successRate) : "—"}
        </td>
        <td className="px-3 py-2.5">
          <IncidentPill indicator={p.incidentIndicator} />
        </td>
        <td className="max-w-[16rem] px-3 py-2.5">
          {p.lastErrorAt ? (
            <>
              <p className="truncate text-[11px] text-danger" title={p.lastErrorMessage}>
                {p.lastErrorStatus > 0 ? `HTTP ${p.lastErrorStatus}` : "Network"}
                {p.lastErrorMessage ? ` · ${p.lastErrorMessage}` : ""}
              </p>
              <p className="text-[10px] text-muted-foreground">{timeAgo(p.lastErrorAt)}</p>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">None</span>
          )}
        </td>
      </>
    );
  }

  if (view === "usage") {
    return (
      <>
        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{compactNumber(p.requests)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
          {compactNumber(p.requestsToday)}
        </td>
        <td
          className={cn(
            "px-3 py-2.5 text-right tabular-nums",
            p.requests === 0
              ? "text-muted-foreground"
              : p.latencyP95 >= thresholds.latencyFailMs
                ? "text-danger"
                : p.latencyP95 >= thresholds.latencyWarnMs
                  ? "text-warning"
                  : "",
          )}
        >
          {p.requests > 0 ? formatMs(p.latencyP95) : "—"}
        </td>
        <td className="px-3 py-2.5">
          {p.requests > 0 ? (
            <Sparkline values={p.trend.requests} width={64} height={20} filled={false} />
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground">{timeAgo(p.lastRequestAt)}</td>
      </>
    );
  }

  if (view === "quota") {
    const headroom = p.rateLimit && p.rateRemaining != null ? (p.rateRemaining / p.rateLimit) * 100 : null;
    return (
      <>
        <td className="min-w-[12rem] px-3 py-2.5">
          <QuotaMeter
            used={p.quotaUsed}
            quota={p.monthlyQuota}
            pct={p.quotaPct}
            warnPct={thresholds.quotaWarnPct}
            failPct={thresholds.quotaFailPct}
            compact
          />
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
          {compactNumber(p.quotaUsed)}
          <span className="block text-[10px]">{p.unitLabel}</span>
        </td>
        <td className="px-3 py-2.5">
          {headroom === null ? (
            <span className="text-[11px] text-muted-foreground">Not advertised</span>
          ) : (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    headroom <= thresholds.rateHeadroomWarnPct ? "bg-danger" : "bg-success",
                  )}
                  style={{ width: `${Math.max(2, Math.min(100, headroom))}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {compactNumber(p.rateRemaining ?? 0)}/{compactNumber(p.rateLimit ?? 0)}
              </span>
            </div>
          )}
        </td>
        <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground">
          {p.rateResetAt ? timeAgo(p.rateResetAt) : "—"}
        </td>
      </>
    );
  }

  // keys
  const days = keyRow?.daysToExpiry ?? null;
  const expiry =
    days === null
      ? { label: "No expiry set", variant: "neutral" as const }
      : days < 0
        ? { label: `Expired ${Math.abs(days)}d ago`, variant: "danger" as const }
        : days <= 30
          ? { label: `${days}d left`, variant: days <= 7 ? ("danger" as const) : ("warning" as const) }
          : { label: `${days}d left`, variant: "success" as const };

  return (
    <>
      <td className="px-3 py-2.5 text-[11px] capitalize text-muted-foreground">
        {p.authMethod.replace(/_/g, " ")}
        {p.authStatus !== "ok" && (
          <span className="block font-medium text-danger">
            {p.authStatus === "missing" ? "Not configured" : p.authStatus === "failing" ? "Rejected (401/403)" : p.authStatus}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {!keyRow ? (
          <span className="text-[11px] text-muted-foreground">…</span>
        ) : keyRow.managedExternally ? (
          <Badge variant="neutral">Server environment</Badge>
        ) : keyRow.fields.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">Not managed here</span>
        ) : (
          <ul className="space-y-0.5">
            {keyRow.fields.map((f) => (
              <li key={f.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground">{f.label}</span>
                {f.isSet ? (
                  <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">{f.value}</code>
                ) : (
                  <span className="text-danger">not set</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2.5">
        <Badge variant={expiry.variant}>{expiry.label}</Badge>
      </td>
      {/* Spelled out here rather than using EnvBadge, which renders nothing for
          production — a dedicated Environment column must never be blank. */}
      <td className="px-3 py-2.5 text-[11px] capitalize text-muted-foreground">
        {p.environment === "sandbox" ? (
          <span className="font-semibold text-warning">Sandbox</span>
        ) : (
          "Production"
        )}
      </td>
    </>
  );
}
