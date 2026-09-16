import { useState } from "react";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, ApiError, type Brand, type BrandTenantDb } from "@/lib/api";

// The brand's tenant DB (created with the brand). Read-only apart from Retry after a failed setup.

const STATUS: Record<
  BrandTenantDb["status"],
  { label: string; variant: "success" | "warning" | "danger" | "neutral" }
> = {
  active: { label: "Ready", variant: "success" },
  provisioning: { label: "Setting up", variant: "warning" },
  migrating: { label: "Updating schema", variant: "warning" },
  failed: { label: "Setup failed", variant: "danger" },
  disabled: { label: "Paused", variant: "neutral" },
  none: { label: "Not set up", variant: "neutral" },
};

export function BrandDatabaseCard({
  brand,
  tenantDb,
  onChanged,
}: {
  brand: Brand;
  tenantDb: BrandTenantDb;
  /** The brand and database state after a retry. */
  onChanged: (next: { brand: Brand; tenantDb: BrandTenantDb }) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const status = STATUS[tenantDb.status] ?? STATUS.none;
  const canRetry = brand.status === "failed" || brand.status === "provisioning";

  async function retry() {
    setRetrying(true);
    try {
      const next = await api.super.brands.tenantDb.retry(brand.id);
      onChanged(next);
      if (next.tenantDb.status === "active") toast.success("Database ready — the brand is live.");
      else toast.error(next.tenantDb.error || "Setup didn't finish. See the reason below.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't retry the setup");
    } finally {
      setRetrying(false);
    }
  }

  const where =
    tenantDb.provider === "neon"
      ? `Own Neon project${tenantDb.region ? ` in ${tenantDb.region}` : ""}`
      : tenantDb.provider === "local-schema"
        ? `Schema “${tenantDb.schemaName}” on the platform database (no Neon key configured)`
        : "—";

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Database className="size-4 text-primary" /> Database
          </h3>
          <p className="text-sm text-muted-foreground">
            {brand.name}&apos;s customers, calls and support live in a database of its own.
          </p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted-foreground">Where</dt>
        <dd>{where}</dd>
        <dt className="text-muted-foreground">Schema</dt>
        <dd>
          {tenantDb.schemaVersion || "—"}
          {tenantDb.provisioned && !tenantDb.schemaCurrent && (
            <span className="ml-2 text-warning">
              behind ({tenantDb.latestVersion}) — run <code>npm run tenant:migrate</code>
            </span>
          )}
        </dd>
        {tenantDb.provisionedAt && (
          <>
            <dt className="text-muted-foreground">Set up</dt>
            <dd>{new Date(tenantDb.provisionedAt).toLocaleString()}</dd>
          </>
        )}
      </dl>

      {tenantDb.error && (
        <p className="rounded-lg border border-danger/30 bg-danger-tint px-3 py-2 text-sm text-danger">
          {tenantDb.error}
        </p>
      )}

      {canRetry && (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void retry()} disabled={retrying}>
            {retrying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {retrying ? "Setting up…" : "Retry setup"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Picks up where the last attempt stopped. Takes a minute on Neon.
          </p>
        </div>
      )}
    </Card>
  );
}
