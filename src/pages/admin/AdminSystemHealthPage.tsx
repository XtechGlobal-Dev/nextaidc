import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, MinusCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  CardSkeleton,
} from "@/components/ui/skeleton";
import { api, ApiError, type SystemHealth } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { cn, formatDate } from "@/lib/utils";

const INTEGRATION_LABELS: Record<string, string> = {
  vapi: "Voice Calling",
  stripe: "Stripe",
  email: "Email (SMTP)",
  twilio: "Twilio (SMS)",
  perfex: "Nexleon CRM",
  openai: "OpenAI",
  google: "Google Calendar",
  deepgram: "Deepgram",
};

function IntegrationCard({ id, up }: { id: string; up: boolean }) {
  return (
    <Card className="flex items-center justify-between gap-3 p-4">
      <div>
        <p className="text-sm font-medium">{INTEGRATION_LABELS[id] ?? id}</p>
        <p className={cn("text-xs", up ? "text-success" : "text-muted-foreground")}>
          {up ? "Operational" : "Not configured"}
        </p>
      </div>
      {up ? (
        <CheckCircle2 className="size-5 text-success" />
      ) : (
        <MinusCircle className="size-5 text-muted-foreground" />
      )}
    </Card>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
    </Card>
  );
}

export default function AdminSystemHealthPage() {
  const [data, setData] = useState<SystemHealth | null>(null);
  // Live: re-poll integration status/counts each tick. Data swaps only on success
  // so the rendered cards never flash to skeletons on a background refresh.
  const liveTick = useLiveTick();

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.admin.systemHealth();
        if (active) setData(res);
      } catch (e) {
        if (liveTick === 0) toast.error(e instanceof ApiError ? e.message : "Failed to load system health");
      }
    })();
    return () => {
      active = false;
    };
  }, [liveTick]);

  if (!data) {
    return (
      <div>
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={6} className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" />
        <StatCardsSkeleton count={4} className="mt-6" />
        <CardSkeleton rows={3} className="mt-6" />
      </div>
    );
  }

  const { integrations, webhooks, counts, recentErrors } = data;

  return (
    <div>
      <PageHeader
        title="System Health"
        subtitle="Live status of integrations, webhooks, and platform activity."
      />

      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Activity className="size-4 text-primary" /> Integrations
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(integrations).map(([id, up]) => (
          <IntegrationCard key={id} id={id} up={up} />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">Webhook success rate</p>
          <p
            className={cn(
              "mt-1 text-2xl font-semibold tracking-tight tabular-nums",
              webhooks.successRate >= 90
                ? "text-success"
                : webhooks.successRate >= 50
                  ? "text-warning"
                  : "text-danger",
            )}
          >
            {webhooks.successRate}%
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {webhooks.success}/{webhooks.total} delivered
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">Avg latency</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{webhooks.avgLatencyMs}ms</p>
          <p className="mt-1 text-xs text-muted-foreground">{webhooks.last24h} in last 24h</p>
        </Card>
        <CountCard label="Total users" value={counts.totalUsers} />
        <CountCard label="Pending approvals" value={counts.pendingApprovals} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CountCard label="Total calls" value={counts.totalCalls} />
        <CountCard label="Calls (last 24h)" value={counts.callsLast24h} />
      </div>

      <Card className="mt-6 p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold leading-tight">
            <AlertTriangle className="size-4 text-warning" /> Recent webhook errors
          </h3>
          {recentErrors.length > 0 && (
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard/admin/webhooks">
                View &amp; retry <ArrowRight className="size-4" />
              </Link>
            </Button>
          )}
        </div>
        {recentErrors.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No recent delivery errors. 🎉</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {recentErrors.map((e, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{e.provider}</p>
                  <p className="truncate text-xs text-danger">
                    {e.errorMessage || (e.status === 0 ? "Network error" : `HTTP ${e.status}`)}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
