import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, LifeBuoy, Loader2, Search, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  ApiError,
  type Brand,
  type BrandCustomersPage,
  type BrandSubscriptionsView,
  type BrandTicketsView,
} from "@/lib/api";
import { formatDateDMY } from "@/lib/utils";

/** Inside the brand: customers, subscriptions, support queue — all read from this tenant's DB only. Read-only; the brand's admins act. */
export function BrandInsideTab({ brand }: { brand: Brand }) {
  return (
    <>
      <CustomersCard brandId={brand.id} />
      <SubscriptionsCard brandId={brand.id} />
      <SupportCard brandId={brand.id} />
    </>
  );
}

function failureText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "Could not read the brand's database.";
}

function statusVariant(status: string): "success" | "warning" | "neutral" | "danger" | "primary" {
  switch (status) {
    case "active":
      return "success";
    case "trialing":
    case "pending":
      return "primary";
    case "past_due":
    case "open":
      return "warning";
    case "canceled":
    case "cancelled":
    case "suspended":
      return "danger";
    default:
      return "neutral";
  }
}

/* ------------------------------ Customers ------------------------------ */

function CustomersCard({ brandId }: { brandId: string }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BrandCustomersPage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setData(null);
    api.super.brands
      .customers(brandId, { q: applied || undefined, page, pageSize: 25 })
      .then((d) => {
        if (active) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(failureText(e));
      });
    return () => {
      active = false;
    };
  }, [brandId, applied, page]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setApplied(q.trim());
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Users className="size-4 text-primary" /> Customers
            {data && <Badge variant="neutral">{data.total.toLocaleString()}</Badge>}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">Read from this brand's own database.</p>
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="email or name" className="w-56" />
          <Button type="submit" variant="outline">
            <Search className="size-4" /> Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-danger">{error}</p>
      ) : data === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : data.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{applied ? "Nobody matches." : "No customers yet."}</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Business</th>
                  <th className="py-2 pr-3 font-medium">Plan</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Number</th>
                  <th className="py-2 pr-3 text-right font-medium">Minutes</th>
                  <th className="py-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{c.fullName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{c.email}</div>
                    </td>
                    <td className="py-2 pr-3">{c.businessName || "—"}</td>
                    <td className="py-2 pr-3">{c.planName || c.plan}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={statusVariant(c.subscriptionStatus)}>{c.subscriptionStatus.replace("_", " ")}</Badge>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{c.receptionistNumber || "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.minutesUsed.toLocaleString()}</td>
                    <td className="py-2 whitespace-nowrap text-muted-foreground">{formatDateDMY(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-sm">
              <span className="text-muted-foreground">
                Page {data.page} of {pages}
              </span>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ---------------------------- Subscriptions ---------------------------- */

function SubscriptionsCard({ brandId }: { brandId: string }) {
  const [data, setData] = useState<BrandSubscriptionsView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.super.brands
      .subscriptions(brandId)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(failureText(e));
      });
    return () => {
      active = false;
    };
  }, [brandId]);

  return (
    <Card className="p-5">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <CreditCard className="size-4 text-primary" /> Subscriptions
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Who is on what, from this brand's own database. Payments and the platform's share are on the Pricing &amp;
        wallet tab.
      </p>

      {error ? (
        <p className="mt-4 text-sm text-danger">{error}</p>
      ) : data === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.byStatus
              .filter((s) => s.status !== "none")
              .map((s) => (
                <Badge key={s.status} variant={statusVariant(s.status)}>
                  {s.count.toLocaleString()} {s.status.replace("_", " ")}
                </Badge>
              ))}
            {data.byPlan.map((p) => (
              <Badge key={p.planId ?? "none"} variant="outline">
                {p.count.toLocaleString()} on {p.planName || "no plan"}
              </Badge>
            ))}
            {data.byStatus.every((s) => s.status === "none") && (
              <span className="text-sm text-muted-foreground">No subscriptions yet.</span>
            )}
          </div>

          {data.items.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">Plan</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 text-right font-medium">Minutes</th>
                    <th className="py-2 pr-3 font-medium">Renews</th>
                    <th className="py-2 font-medium">Auto-renew</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {data.items.map((s) => (
                    <tr key={s.userId}>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{s.fullName || "—"}</div>
                        <div className="text-xs text-muted-foreground">{s.email}</div>
                      </td>
                      <td className="py-2 pr-3">{s.planName || "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={statusVariant(s.status)}>{s.status.replace("_", " ")}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {s.minutesUsed.toLocaleString()}
                        {s.minutesAllocated != null && ` / ${Math.round(s.minutesAllocated).toLocaleString()}`}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {s.status === "trialing" && s.trialEndsAt
                          ? `trial ends ${formatDateDMY(s.trialEndsAt)}`
                          : s.currentPeriodEnd
                            ? formatDateDMY(s.currentPeriodEnd)
                            : "—"}
                      </td>
                      <td className="py-2">{s.autoRenew ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------- Support ------------------------------- */

const TICKET_FILTERS = ["", "open", "pending", "resolved", "closed"] as const;

function SupportCard({ brandId }: { brandId: string }) {
  const [status, setStatus] = useState<(typeof TICKET_FILTERS)[number]>("");
  const [data, setData] = useState<BrandTicketsView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setData(null);
    api.super.brands
      .tickets(brandId, status || undefined)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(failureText(e));
      });
    return () => {
      active = false;
    };
  }, [brandId, status]);

  const countOf = (s: string) => data?.byStatus.find((b) => b.status === s)?.count ?? 0;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <LifeBuoy className="size-4 text-primary" /> Support
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The brand's customer queue, from its own database. Its admins work it; a ticket handed up to the platform
            shows as escalated.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {TICKET_FILTERS.map((f) => (
            <Button key={f || "all"} size="sm" variant={status === f ? "primary" : "outline"} onClick={() => setStatus(f)}>
              {f || "all"}
              {f && data && ` (${countOf(f)})`}
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-danger">{error}</p>
      ) : data === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : data.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No tickets{status ? ` ${status}` : ""}.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Ticket</th>
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 font-medium">Queue</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Handler</th>
                <th className="py-2 font-medium">Last message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{t.subject}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.reference}
                      {t.priority !== "normal" && ` · ${t.priority}`}
                      {t.escalationId && " · escalated to the platform"}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div>{t.requester.fullName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{t.requester.email}</div>
                  </td>
                  <td className="py-2 pr-3">{t.department?.name ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                  </td>
                  <td className="py-2 pr-3">{t.assignedTo?.fullName ?? "unassigned"}</td>
                  <td className="py-2 whitespace-nowrap text-muted-foreground">{formatDateDMY(t.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
