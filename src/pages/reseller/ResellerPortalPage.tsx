import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Check,
  ChevronRight,
  Copy,
  DollarSign,
  Gift,
  Hourglass,
  Link2,
  LogOut,
  PhoneCall,
  RefreshCw,
  Share2,
  Users2,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCardsSkeleton, CardSkeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { Button } from "@/components/ui/button";
import {
  DataCard,
  DataCardAvatar,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError, type ResellerOverview, type ResellerCustomerDetail } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePagination } from "@/hooks/usePagination";
import { COMPACT_PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { cn, formatDate } from "@/lib/utils";
import { env } from "@/lib/env";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** Stable stand-ins while a payload loads, so paging doesn't re-slice each render. */
const EMPTY_REFERRALS: ResellerOverview["customers"] = [];
const EMPTY_COMMISSIONS: ResellerCustomerDetail["commissionHistory"] = [];

function StatCard({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <Card className="p-5 transition-shadow hover:shadow-[var(--shadow-panel)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", accent)}>
          {icon}
        </span>
      </div>
    </Card>
  );
}

export default function ResellerPortalPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [data, setData] = useState<ResellerOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  // Which referred customer's full-detail modal is open (null = closed).
  const [detailId, setDetailId] = useState<string | null>(null);

  const referrals = usePagination(data?.customers ?? EMPTY_REFERRALS, {
    initialPageSize: COMPACT_PAGE_SIZE_OPTIONS[1],
  });

  const load = useCallback(async (showToast = false, silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await api.reseller.overview();
      setData(res);
      if (showToast) toast.success("Refreshed");
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load your dashboard");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Self-contained poll (30s + focus): this page is outside AppLayout so the SSE driver doesn't reach it, and
  // its figures come from sub-customers' channels anyway. `silent` skips the spinner and error toast.
  useEffect(() => {
    const refresh = () => void load(false, true);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Only resellers belong here.
  if (user && user.role !== "RESELLER") return <Navigate to="/dashboard" replace />;

  const referralLink = data?.referralCode ? `${window.location.origin}/?ref=${data.referralCode}` : "";

  function copyLink() {
    if (!referralLink) return;
    void navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast.success("Referral link copied");
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function shareLink() {
    if (!referralLink) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `${env.appName} — AI receptionist`,
          text: `Never miss a call again. Try ${env.appName}:`,
          url: referralLink,
        });
      } catch {
        /* user dismissed the share sheet — no-op */
      }
    } else {
      copyLink();
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-warm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 lg:px-8">
          <div className="flex items-center gap-2">
          <BrandLogo imgClassName="h-8 w-auto max-w-[150px] object-contain">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <PhoneCall className="size-5" />
            </div>
            <span className="text-[15px] font-semibold">
              <Wordmark />
            </span>
          </BrandLogo>
          <span className="text-[15px] font-semibold text-muted-foreground">· Partner</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={logout}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 lg:px-8">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Welcome{user ? `, ${user.fullName.split(/\s+/)[0]}` : ""} 👋
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Share your link — you earn commission on every customer who subscribes through it.
        </p>

        {data === null ? (
          <div className="mt-6 space-y-6">
            <StatCardsSkeleton count={3} />
            <CardSkeleton rows={5} />
          </div>
        ) : (
          <>
            {/* Referral link — hero CTA */}
            <section className="relative mt-6 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-[#1d4ed8] p-6 text-white shadow-[var(--shadow-soft)]">
              <span
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-44 rounded-full bg-white/10 blur-2xl"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-16 left-1/3 size-40 rounded-full bg-white/5 blur-2xl"
              />
              <div className="relative flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-white/15">
                    <Gift className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">Your referral link</p>
                    <p className="text-xs text-white/70">Share it anywhere to start earning.</p>
                  </div>
                </div>
                <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
                  {data.commissionPercent}% commission
                </span>
              </div>

              <div className="relative mt-4 flex flex-col gap-2 sm:flex-row">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/15 px-3.5 py-2.5 backdrop-blur">
                  <Link2 className="size-4 shrink-0 text-white/70" />
                  <code className="min-w-0 flex-1 truncate text-sm">{referralLink || "—"}</code>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={copyLink}
                    className="bg-white text-primary shadow-none hover:bg-white/90"
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void shareLink()}
                    className="border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white"
                  >
                    <Share2 className="size-4" /> Share
                  </Button>
                </div>
              </div>
            </section>

            {/* Stats */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard
                label="Referred"
                value={String(data.referredCount)}
                hint="Total sign-ups"
                accent="bg-primary-tint text-primary"
                icon={<Users2 className="size-5" />}
              />
              <StatCard
                label="Earned"
                value={money(data.earnedCents)}
                hint="Lifetime commission"
                accent="bg-success-tint text-success"
                icon={<DollarSign className="size-5" />}
              />
              <StatCard
                label="Pending"
                value={money(data.pendingCents)}
                hint="Awaiting payout"
                accent="bg-premium-tint text-premium"
                icon={<Hourglass className="size-5" />}
              />
            </div>

            {/* Referred customers */}
            <Card className="mt-6 overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-5 py-3">
                <h2 className="text-sm font-semibold">Your referred customers</h2>
                <Badge variant="neutral">{data.customers.length} total</Badge>
              </div>
              {data.customers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary-tint text-primary">
                    <Users2 className="size-6" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">No referrals yet</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Share your link to start earning {data.commissionPercent}% commission.
                    </p>
                  </div>
                  <Button size="sm" onClick={copyLink}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "Copied" : "Copy your link"}
                  </Button>
                </div>
              ) : (
                (() => {
                  const paged = referrals.pageItems;
                  return (
                    <>
                      <div className="hidden overflow-x-auto md:block">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                              <th className="px-5 py-2.5 font-medium">Customer</th>
                              <th className="px-5 py-2.5 font-medium">Plan</th>
                              <th className="px-5 py-2.5 font-medium">Status</th>
                              <th className="px-5 py-2.5 text-right font-medium">Commission</th>
                              <th className="px-5 py-2.5 font-medium">Joined</th>
                              <th className="px-5 py-2.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {paged.map((c) => (
                              <tr
                                key={c.id}
                                onClick={() => setDetailId(c.id)}
                                title="View full details"
                                className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/40"
                              >
                                <td className="px-5 py-3">
                                  <div className="flex items-center gap-3">
                                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary">
                                      {initials(c.name)}
                                    </span>
                                    <span className="truncate font-medium">{c.name}</span>
                                  </div>
                                </td>
                                <td className="px-5 py-3">
                                  <Badge variant={c.plan === "premium" ? "premium" : "neutral"}>{c.plan}</Badge>
                                </td>
                                <td className="px-5 py-3">
                                  <Badge
                                    variant={
                                      c.subscriptionStatus === "active" || c.subscriptionStatus === "trialing"
                                        ? "success"
                                        : "neutral"
                                    }
                                  >
                                    {c.subscriptionStatus}
                                  </Badge>
                                </td>
                                <td className="px-5 py-3 text-right font-medium tabular-nums">
                                  {money(c.commissionCents)}
                                </td>
                                <td className="px-5 py-3 text-muted-foreground">{formatDate(c.joinedAt)}</td>
                                <td className="px-5 py-3 text-right text-muted-foreground">
                                  <ChevronRight className="ml-auto size-4" />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile — cards */}
                      <div className="space-y-3 p-4 md:hidden">
                        {paged.map((c) => (
                          <DataCard key={c.id} onClick={() => setDetailId(c.id)}>
                            <DataCardHeader
                              lead={<DataCardAvatar>{initials(c.name)}</DataCardAvatar>}
                              title={c.name}
                              actions={<ChevronRight className="size-4 text-muted-foreground" />}
                            />
                            <DataCardPills>
                              <Badge variant={c.plan === "premium" ? "premium" : "neutral"}>{c.plan}</Badge>
                              <Badge
                                variant={
                                  c.subscriptionStatus === "active" || c.subscriptionStatus === "trialing"
                                    ? "success"
                                    : "neutral"
                                }
                              >
                                {c.subscriptionStatus}
                              </Badge>
                            </DataCardPills>
                            <DataCardGrid>
                              <CardField label="Commission">
                                <span className="tabular-nums">{money(c.commissionCents)}</span>
                              </CardField>
                              <CardField label="Joined">{formatDate(c.joinedAt)}</CardField>
                            </DataCardGrid>
                          </DataCard>
                        ))}
                      </div>

                      <div className="border-t border-border px-5 py-3">
                        <Pagination
                          page={referrals.page}
                          pageSize={referrals.pageSize}
                          total={referrals.total}
                          onPageChange={referrals.setPage}
                          onPageSizeChange={referrals.setPageSize}
                          pageSizeOptions={COMPACT_PAGE_SIZE_OPTIONS}
                          noun="referrals"
                          className="mt-0"
                        />
                      </div>
                    </>
                  );
                })()
              )}
            </Card>
          </>
        )}
      </main>

      {detailId && (
        <CustomerDetailDialog customerId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

// Referred-customer detail modal (contact + subscription + commission history). Read-only.

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium">{value || "—"}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>
  );
}

function CustomerDetailDialog({
  customerId,
  onClose,
}: {
  customerId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ResellerCustomerDetail | null>(null);
  const [error, setError] = useState(false);

  // Declared before the loading branches so the hook order stays stable.
  const history = usePagination(detail?.commissionHistory ?? EMPTY_COMMISSIONS, {
    initialPageSize: COMPACT_PAGE_SIZE_OPTIONS[0],
    resetKey: customerId,
  });

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(false);
    api.reseller
      .customerDetail(customerId)
      .then((d) => {
        if (active) setDetail(d);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail?.name ?? "Customer details"}</DialogTitle>
        </DialogHeader>

        {error ? (
          <p className="py-6 text-center text-sm text-danger">Couldn't load this customer.</p>
        ) : !detail ? (
          <CardSkeleton rows={8} />
        ) : (
          <div className="space-y-5">
            {/* Contact */}
            <section className="space-y-3">
              <SectionTitle>Contact</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Full name" value={detail.fullName} />
                <Field label="Email" value={detail.email} />
                <Field label="Mobile" value={detail.mobile} />
                <Field label="Business" value={detail.businessName} />
                <Field label="Website" value={detail.website} />
                <Field label="Support number" value={detail.businessNumber} />
              </div>
            </section>

            {/* Subscription */}
            <section className="space-y-3 border-t border-border pt-4">
              <SectionTitle>Subscription</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Plan"
                  value={
                    <Badge variant={detail.plan === "premium" ? "premium" : "neutral"}>
                      {detail.plan}
                    </Badge>
                  }
                />
                <Field
                  label="Status"
                  value={
                    <Badge
                      variant={
                        detail.subscriptionStatus === "active" ||
                        detail.subscriptionStatus === "trialing"
                          ? "success"
                          : "neutral"
                      }
                    >
                      {detail.subscriptionStatus}
                    </Badge>
                  }
                />
                <Field label="Joined" value={formatDate(detail.joinedAt)} />
                <Field
                  label="Trial ends"
                  value={detail.trialEndsAt ? formatDate(detail.trialEndsAt) : "—"}
                />
                <Field
                  label="Renews on"
                  value={detail.currentPeriodEnd ? formatDate(detail.currentPeriodEnd) : "—"}
                />
                <Field label="Auto-renew" value={detail.autoRenew ? "On" : "Off"} />
              </div>
            </section>

            {/* Commission */}
            <section className="space-y-3 border-t border-border pt-4">
              <SectionTitle>Your commission</SectionTitle>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Total" value={money(detail.commission.totalCents)} />
                <Field label="Paid" value={money(detail.commission.paidCents)} />
                <Field label="Pending" value={money(detail.commission.pendingCents)} />
              </div>
              {detail.commissionHistory.length > 0 && (
                <>
                  {/* Desktop — table */}
                  <div className="hidden overflow-hidden rounded-lg border border-border md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">Invoice</th>
                          <th className="px-3 py-2 text-right font-medium">Commission</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.pageItems.map((row, i) => (
                          <tr key={i} className="border-b border-border/60 last:border-0">
                            <td className="px-3 py-2 text-muted-foreground">{formatDate(row.createdAt)}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {money(row.invoiceAmountCents)}
                              <span className="text-xs"> · {row.percent}%</span>
                            </td>
                            <td className="px-3 py-2 text-right font-medium tabular-nums">
                              {money(row.amountCents)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant={row.status === "paid" ? "success" : "neutral"}>
                                {row.status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile — cards */}
                  <div className="space-y-3 md:hidden">
                    {history.pageItems.map((row, i) => (
                      <DataCard key={i}>
                        <DataCardHeader
                          title={<span className="tabular-nums">{money(row.amountCents)}</span>}
                          subtitle={formatDate(row.createdAt)}
                          actions={
                            <Badge variant={row.status === "paid" ? "success" : "neutral"}>
                              {row.status}
                            </Badge>
                          }
                        />
                        <DataCardGrid>
                          <CardField label="Invoice">
                            <span className="tabular-nums">{money(row.invoiceAmountCents)}</span>
                            <span className="text-xs font-normal text-muted-foreground"> · {row.percent}%</span>
                          </CardField>
                          <CardField label="Commission">
                            <span className="tabular-nums">{money(row.amountCents)}</span>
                          </CardField>
                        </DataCardGrid>
                      </DataCard>
                    ))}
                  </div>

                  <Pagination
                    page={history.page}
                    pageSize={history.pageSize}
                    total={history.total}
                    onPageChange={history.setPage}
                    onPageSizeChange={history.setPageSize}
                    pageSizeOptions={COMPACT_PAGE_SIZE_OPTIONS}
                    noun="payouts"
                    className="mt-3"
                  />
                </>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
