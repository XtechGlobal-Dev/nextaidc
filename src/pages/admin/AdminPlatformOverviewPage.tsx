import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  CreditCard,
  Database,
  LifeBuoy,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, type DirectoryHit, type PlatformOverview } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { formatDate, formatDateDMY } from "@/lib/utils";

/** Super admin's platform-wide view. Reads Main only (nightly rollup, ledger, wallets, unrouted Stripe) — no brand DB is opened, hence the "computed at" + recompute. */
export default function AdminPlatformOverviewPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState("");
  const [rolling, setRolling] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.super.overview());
      setError("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the overview.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rollupNow() {
    setRolling(true);
    try {
      const r = await api.super.rollup();
      if (r.failed.length) {
        toast.warning(`Refreshed ${r.brands} brand${r.brands === 1 ? "" : "s"}; ${r.failed.length} could not be read.`);
      } else {
        toast.success(`Refreshed ${r.brands} brand${r.brands === 1 ? "" : "s"}.`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The refresh did not run.");
    } finally {
      setRolling(false);
    }
  }

  const openBrand = (id: string, tab?: string) =>
    navigate(`/dashboard/admin/brands/${id}${tab ? `?tab=${tab}` : ""}`);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform"
        subtitle={
          data?.asOf
            ? `Every brand's numbers, as of ${formatDate(data.asOf)}. Refreshed nightly.`
            : "Every brand's numbers, refreshed nightly."
        }
        actions={
          <Button variant="outline" onClick={rollupNow} disabled={rolling}>
            {rolling ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh now
          </Button>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      {!data && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : data ? (
        <>
          {/* Headline numbers — the sum of last night's rows. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Stat icon={Building2} label="Brands" value={data.brands.total} sub={brandsSub(data.brands)} />
            <Stat icon={Users} label="Customers" value={data.totals.customers} sub="across all brands" />
            <Stat
              icon={CreditCard}
              label="Active subscriptions"
              value={data.totals.active}
              sub={`${data.totals.trialing.toLocaleString()} trialing`}
            />
            <Stat icon={Phone} label="Calls" value={data.totals.callsTotal} sub="all time" />
            <Stat icon={Timer} label="Minutes used" value={Math.round(data.totals.minutesTotal)} sub="all time" />
            <Stat icon={LifeBuoy} label="Open support tickets" value={data.totals.openTickets} sub="in the brands' inboxes" />
          </div>

          {/* Money and health — live from Main, not from the rollup. */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Wallet className="size-4 text-primary" /> This month
              </h3>
              {data.ledger.totals.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No payments yet this month.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {data.ledger.totals.map((t) => (
                    <div key={t.currency}>
                      <div className="text-2xl font-semibold tabular-nums">{formatMoney(t.totalCents, t.currency)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatMoney(t.platformCents, t.currency)} platform · {formatMoney(t.brandCents, t.currency)} brands ·{" "}
                        {t.payments} payment{t.payments === 1 ? "" : "s"}
                        {t.refundedCents > 0 && ` · ${formatMoney(t.refundedCents, t.currency)} refunded`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-5">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Wallet className="size-4 text-primary" /> Owed to brands
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">Wallet balances across every brand.</p>
              {data.wallets.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">Nothing outstanding.</p>
              ) : (
                <div className="mt-3 space-y-1">
                  {data.wallets.map((w) => (
                    <div key={w.currency} className="text-2xl font-semibold tabular-nums">
                      {formatMoney(w.balanceCents, w.currency)}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-5">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Database className="size-4 text-primary" /> Health
              </h3>
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="Brand databases">
                  {Object.keys(data.tenants).length === 0
                    ? "none"
                    : Object.entries(data.tenants)
                        .map(([status, n]) => `${n} ${status}`)
                        .join(" · ")}
                </Row>
                <Row label="Stripe events waiting">
                  {data.unroutedEvents === 0 ? (
                    <span className="text-success">none</span>
                  ) : (
                    <button type="button" className="text-warning underline-offset-2 hover:underline" onClick={() => navigate("/dashboard/admin/brands")}>
                      {data.unroutedEvents} to place
                    </button>
                  )}
                </Row>
                <Row label="Stale brands">
                  {data.perBrand.filter((b) => b.stale && b.status === "active").length || "none"}
                </Row>
              </dl>
            </Card>
          </div>

          <FindAnywhere onOpen={(hit) => openBrand(hit.brandId, "inside")} />

          {/* Per brand. */}
          <Card className="p-0">
            <div className="border-b border-border p-5">
              <h3 className="text-base font-semibold">By brand</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                A brand marked stale was not reached by last night's run — its numbers are from the newest row it has.
              </p>
            </div>
            {data.perBrand.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No brands yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">Brand</th>
                      <th className="px-3 py-3 text-right font-medium">Customers</th>
                      <th className="px-3 py-3 text-right font-medium">Active</th>
                      <th className="px-3 py-3 text-right font-medium">Trialing</th>
                      <th className="px-3 py-3 text-right font-medium">Calls</th>
                      <th className="px-3 py-3 text-right font-medium">Minutes</th>
                      <th className="px-3 py-3 text-right font-medium">Open tickets</th>
                      <th className="px-5 py-3 font-medium">As of</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {data.perBrand.map((b) => (
                      <tr
                        key={b.brandId}
                        className="cursor-pointer tabular-nums hover:bg-muted/40"
                        onClick={() => openBrand(b.brandId, "inside")}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{b.name}</span>
                            {b.status !== "active" && <Badge variant="warning">{b.status}</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">{b.slug}</div>
                        </td>
                        <td className="px-3 py-3 text-right">{b.customers.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{b.active.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{b.trialing.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{b.callsTotal.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{Math.round(b.minutesTotal).toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{b.openTickets.toLocaleString()}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">
                          {b.computedAt ? formatDate(b.computedAt) : "never"}
                          {b.stale && (
                            <Badge variant="warning" className="ml-2">
                              stale
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* The last two weeks, summed over brands. */}
          <Card className="p-5">
            <h3 className="text-base font-semibold">Last 14 days</h3>
            {data.series.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nothing rolled up yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Day</th>
                      <th className="py-2 pr-3 text-right font-medium">Calls</th>
                      <th className="py-2 text-right font-medium">Minutes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {[...data.series].reverse().map((d) => (
                      <tr key={d.day} className="tabular-nums">
                        <td className="py-2 pr-3">{formatDateDMY(d.day)}</td>
                        <td className="py-2 pr-3 text-right">{d.calls.toLocaleString()}</td>
                        <td className="py-2 text-right">{d.minutes.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function brandsSub(b: PlatformOverview["brands"]): string {
  const parts: string[] = [];
  if (b.provisioning) parts.push(`${b.provisioning} setting up`);
  if (b.failed) parts.push(`${b.failed} failed`);
  if (b.suspended) parts.push(`${b.suspended} suspended`);
  return parts.length ? parts.join(" · ") : `${b.active} active`;
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <Card className="flex items-start justify-between gap-3 p-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{value.toLocaleString()}</p>
        {sub && <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>}
      </div>
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary">
        <Icon className="size-5" />
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** "Find this customer, whichever brand" — the thin directory in Main. */
function FindAnywhere({ onOpen }: { onOpen: (hit: DirectoryHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<DirectoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) {
      setHits(null);
      return;
    }
    setBusy(true);
    try {
      setHits((await api.super.directory(q)).hits);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The search did not run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Search className="size-4 text-primary" /> Find a person
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        By email or name, whichever brand they are in. Opens the brand they belong to.
      </p>
      <form onSubmit={search} className="mt-3 flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="email or name" className="max-w-md" />
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Search
        </Button>
      </form>
      {hits && (
        <div className="mt-4">
          {hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody matches.</p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {hits.map((h) => (
                <li key={`${h.brandId}:${h.userId}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => onOpen(h)}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{h.email}</span>
                      {h.fullName && <span className="ml-2 text-muted-foreground">{h.fullName}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">{h.role.toLowerCase()}</Badge>
                      <Badge variant="primary">{h.brand.name}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
