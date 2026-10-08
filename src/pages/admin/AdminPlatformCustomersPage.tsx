import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, RotateCcw, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { DataCard, DataCardGrid, DataCardHeader, DataCardPills, CardField } from "@/components/ui/data-card";
import { api, ApiError, type PlatformCustomer, type PlatformCustomerPage } from "@/lib/api";

// Platform Customers: everyone who signed up on the main domain. Each has their own account database
// (docs/brand-as-customer-plan.md); the platform is their provider, so this is the super admin's customer list.
// Read from the main database only — plan state is as of the nightly rollup.

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

const PLAN_META: Record<NonNullable<PlatformCustomer["plan"]>, { label: string; variant: "success" | "primary" | "neutral" }> = {
  paying: { label: "Paying", variant: "success" },
  trial: { label: "Trial", variant: "primary" },
  none: { label: "No plan", variant: "neutral" },
};

const PAGE_SIZE = 25;

export default function AdminPlatformCustomersPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | "active" | "suspended">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PlatformCustomerPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Typing settles for a beat before it becomes a query, so the list isn't refetched per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    try {
      setData(await api.super.platformCustomers.list({ q: query, status, page, pageSize: PAGE_SIZE }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load platform customers");
      setData({ page, pageSize: PAGE_SIZE, total: 0, customers: [] });
    }
  }, [query, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (c: PlatformCustomer) => {
    const suspend = c.status === "active";
    if (suspend && !window.confirm(`Suspend ${c.businessName || c.email}? They are signed out and can't sign in until you restore them.`)) {
      return;
    }
    setBusy(c.id);
    try {
      if (suspend) await api.super.platformCustomers.suspend(c.id);
      else await api.super.platformCustomers.reactivate(c.id);
      toast.success(suspend ? "Account suspended" : "Account restored");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the account");
    } finally {
      setBusy(null);
    }
  };

  const planBadge = (c: PlatformCustomer) =>
    c.plan ? (
      <Badge variant={PLAN_META[c.plan].variant}>{PLAN_META[c.plan].label}</Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const statusBadges = (c: PlatformCustomer) => (
    <span className="flex flex-wrap items-center gap-1.5">
      {c.status === "suspended" ? <Badge variant="danger">Suspended</Badge> : <Badge variant="success">Active</Badge>}
      {c.downgradedAt && (
        <Badge variant="warning" title={`Downgraded ${fmtDate(c.downgradedAt)}`}>
          Former brand
        </Badge>
      )}
    </span>
  );

  const action = (c: PlatformCustomer) => (
    <Button
      size="sm"
      variant="outline"
      disabled={busy === c.id}
      onClick={(e) => {
        e.stopPropagation();
        void toggle(c);
      }}
    >
      {c.status === "active" ? <Ban className="size-3.5" /> : <RotateCcw className="size-3.5" />}
      {c.status === "active" ? "Suspend" : "Restore"}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Platform Customers"
        subtitle="Everyone who signed up on the main domain. A customer becomes a brand once you approve their Brand Admin request."
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by business, name or email"
            className="pl-9"
            aria-label="Search platform customers"
          />
        </div>
        <div className="flex gap-1.5">
          {(["", "active", "suspended"] as const).map((s) => (
            <Button
              key={s || "all"}
              size="sm"
              variant={status === s ? "primary" : "outline"}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
            >
              {s === "" ? "All" : s === "active" ? "Active" : "Suspended"}
            </Button>
          ))}
        </div>
      </div>

      {data === null ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-4">
                <div className="h-3.5 w-48 animate-pulse rounded bg-muted" />
                <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </Card>
      ) : data.customers.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <Users className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{query || status ? "No matching customers" : "No platform customers yet"}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Customers who sign up on the main domain appear here.
          </p>
        </Card>
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Plan</th>
                    <th className="px-4 py-3 text-right font-medium">Calls</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Joined</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {data.customers.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/dashboard/admin/platform-customers/${c.id}`)}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-primary-tint-soft"
                    >
                      <td className="max-w-[300px] px-4 py-3">
                        <p className="truncate font-medium">{c.businessName || c.fullName || c.email}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.fullName && c.fullName !== c.businessName ? `${c.fullName} · ` : ""}
                          {c.email}
                        </p>
                      </td>
                      <td className="px-4 py-3">{planBadge(c)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{c.callsTotal}</td>
                      <td className="px-4 py-3">{statusBadges(c)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtDate(c.createdAt)}</td>
                      <td className="px-4 py-3 text-right">{action(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-3 md:hidden">
            {data.customers.map((c) => (
              <DataCard key={c.id} onClick={() => navigate(`/dashboard/admin/platform-customers/${c.id}`)}>
                <DataCardHeader title={c.businessName || c.fullName || c.email} subtitle={c.email} actions={action(c)} />
                <DataCardPills>
                  {planBadge(c)}
                  {statusBadges(c)}
                </DataCardPills>
                <DataCardGrid>
                  <CardField label="Calls">{c.callsTotal}</CardField>
                  <CardField label="Joined">{fmtDate(c.createdAt)}</CardField>
                </DataCardGrid>
              </DataCard>
            ))}
          </div>

          <Pagination
            className="mt-4"
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPageChange={setPage}
            noun="customers"
          />
        </>
      )}
    </div>
  );
}
