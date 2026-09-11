import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, PhoneCall, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeaderSkeleton,
  CardSkeleton,
  TableSkeleton,
} from "@/components/ui/skeleton";
import {
  DataCard,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError, type CustomerDetail } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { COMPACT_PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { capitalize, formatDate } from "@/lib/utils";
import { PlanPill } from "./PlanPill";
import { CustomerDiscountCard } from "./CustomerDiscountCard";
import { isAdminRole } from "@/lib/roles";

/** Stable stand-in while the detail payload loads, so paging doesn't re-slice. */
const EMPTY_CALLS: CustomerDetail["calls"] = [];

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words text-sm font-medium" title={title}>
        {value || "—"}
      </p>
    </div>
  );
}

/** Shorten a website to "domain/path", dropping protocol, www, and the long
 *  tracking query string (gclid, gad_source…) so it never overflows the card. */
function prettyUrl(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return raw;
  }
}

export default function AdminCustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // Suspend / reactivate are moderation edits — gated by `customers.edit`. The
  // buttons are omitted from the DOM when denied and `moderate()` no-ops as a
  // defensive backstop (the server also enforces `customers.edit`).
  const canEdit = useAuthStore((s) => s.hasPermission)("customers.edit");
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  // Which moderation action the admin is confirming (null = no dialog open).
  const [confirm, setConfirm] = useState<"suspend" | "reactivate" | null>(null);
  const [reason, setReason] = useState("");

  // Declared before the loading early-return, so the hook order stays stable.
  const {
    page,
    pageSize,
    pageItems: pagedCalls,
    total: callTotal,
    setPage,
    setPageSize,
  } = usePagination(data?.calls ?? EMPTY_CALLS, {
    initialPageSize: COMPACT_PAGE_SIZE_OPTIONS[1],
  });

  async function load(silent = false) {
    try {
      const res = await api.admin.customerDetail(id);
      setData(res);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load customer");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Live refresh: silently re-pull this customer's calls/usage/status each tick.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  async function moderate() {
    if (!confirm || !canEdit) return;
    const action = confirm;
    setBusy(true);
    try {
      await (action === "suspend"
        ? api.admin.suspendCustomer(id, reason.trim() || undefined)
        : api.admin.reactivateCustomer(id));
      toast.success(action === "suspend" ? "Account suspended" : "Account reactivated");
      setConfirm(null);
      setReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div>
        <PageHeaderSkeleton />
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={3} />
          <CardSkeleton rows={2} />
        </div>
        <CardSkeleton rows={2} className="mt-4" />
        <TableSkeleton cols={5} rows={4} />
      </div>
    );
  }

  const { customer, agent, calls, usage, billing } = data;

  return (
    <div>
      <button
        onClick={() => navigate("/dashboard/admin/customers")}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to customers
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={customer.fullName} subtitle={customer.email} />
        {!isAdminRole(customer.role) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {/* The "Login as Customer" button used to sit here. Impersonation is
                now behind the 👋 in the header greeting, gated by a PIN the
                server checks — see ImpersonationEmojiTrigger. */}
            {canEdit &&
              (billing.subscriptionStatus === "suspended" ? (
                <Button
                  className="flex-1 sm:flex-none"
                  onClick={() => setConfirm("reactivate")}
                  disabled={busy}
                >
                  Reactivate account
                </Button>
              ) : (
                <Button
                  variant="danger"
                  className="flex-1 sm:flex-none"
                  onClick={() => setConfirm("suspend")}
                  disabled={busy}
                >
                  Suspend account
                </Button>
              ))}
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 sm:mt-0 lg:grid-cols-3">
        <Card className="p-5">
          <h3 className="mb-4 border-b border-border/60 pb-2.5 text-base font-semibold">Profile</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Field label="Business" value={customer.businessName} />
            <Field label="Mobile" value={customer.mobile} />
            <Field label="Website" value={prettyUrl(customer.website)} title={customer.website} />
            <Field label="Receptionist #" value={customer.receptionistNumber} />
            <Field label="Joined" value={formatDate(customer.createdAt)} />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Role</p>
              <Badge variant={isAdminRole(customer.role) ? "primary" : "neutral"} className="mt-1">
                {customer.role}
              </Badge>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 border-b border-border/60 pb-2.5 text-base font-semibold">Billing</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Plan</p>
              {/* Same per-tier coloured pill the customers table uses. The name is
                  the subscribed plan's ("Standard") — the free/premium flag reads
                  "Free" during a trial on a paid plan, so PlanPill's null case (a
                  neutral "Free" badge) only shows when there's genuinely no plan. */}
              <div className="mt-1">
                <PlanPill name={billing.planName} />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
              <Badge
                variant={
                  billing.suspended || billing.subscriptionStatus === "suspended"
                    ? "danger"
                    : billing.subscriptionStatus === "active"
                      ? "success"
                      : billing.subscriptionStatus === "trialing" ||
                          billing.freeTrial ||
                          billing.onboarding
                        ? "warning"
                        : "neutral"
                }
                className="mt-1"
              >
                {billing.suspended
                  ? "Suspended (by admin)"
                  : billing.onboarding
                    ? "Onboarding"
                    : billing.freeTrial || billing.subscriptionStatus === "trialing"
                      ? "Trial"
                      : capitalize(billing.subscriptionStatus)}
              </Badge>
            </div>
            <Field label="Stripe customer" value={billing.stripeCustomerId ?? ""} />
            <Field
              label="Trial ends"
              value={billing.trialEndsAt ? formatDate(billing.trialEndsAt) : ""}
            />
            {/* Which onboarding rule this account signed up under. The admin toggle
                only applies to NEW signups, so accounts created either side of a
                flip behave differently forever — without this, support has no way
                to see which rule a given customer is living under. */}
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Signed up</p>
              <Badge variant={billing.cardRequiredAtSignup ? "primary" : "neutral"} className="mt-1">
                {billing.cardRequiredAtSignup ? "Card required" : "Card-less"}
              </Badge>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Card on file</p>
              {billing.cardConfirmedAt ? (
                <p className="mt-0.5 break-words text-sm font-medium">
                  {formatDate(billing.cardConfirmedAt)}
                </p>
              ) : billing.cardRequiredAtSignup ? (
                // Signed up under the card rule and never added one — this customer
                // is sitting on the plan/card wall and cannot reach the dashboard.
                <Badge variant="warning" className="mt-1">
                  Awaiting card
                </Badge>
              ) : (
                <p className="mt-0.5 text-sm font-medium">—</p>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 border-b border-border/60 pb-2.5 text-base font-semibold">Usage (all time)</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Calls handled</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{usage.callsHandled}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Minutes used</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{usage.minutesUsed}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <h3 className="mb-3 text-base font-semibold">AI agent</h3>
        {agent ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Assistant name" value={agent.name} />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
              <Badge variant={agent.status === "approved" ? "success" : "warning"} className="mt-1">
                {capitalize(agent.status)}
              </Badge>
            </div>
            <Field label="Assistant ID" value={agent.vapiAssistantId ?? ""} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No agent configured yet.</p>
        )}
      </Card>

      <CustomerDiscountCard userId={customer.id} customerName={customer.fullName || "this customer"} />

      <Card className="mt-4 overflow-hidden p-0">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold">Recent calls</h3>
        </div>
        {calls.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <PhoneCall className="size-6" />
            </span>
            <p className="text-sm text-muted-foreground">No calls yet.</p>
          </div>
        ) : (
          <>
            {/* Desktop — table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Time</th>
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Caller</th>
                    <th className="px-5 py-3 font-medium">Outcome</th>
                    <th className="px-5 py-3 text-right font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedCalls.map((c) => (
                    <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{formatDate(c.createdAt)}</td>
                      <td className="px-5 py-3">
                        <Badge variant="neutral">{c.type === "Web" ? "Test" : "Phone"}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-medium">{c.callerName}</span>
                        {/* A web test call has no number to show, so the line is
                            omitted rather than rendered as an empty gap. */}
                        {c.callerNumber && (
                          <span className="block text-xs tabular-nums text-muted-foreground">
                            {c.callerNumber}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={c.outcome === "completed" ? "success" : "neutral"}>{capitalize(c.outcome)}</Badge>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{c.durationSec}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile — cards */}
            <div className="space-y-3 p-3 md:hidden">
              {pagedCalls.map((c) => (
                <DataCard key={c.id}>
                  <DataCardHeader title={c.callerName} subtitle={formatDate(c.createdAt)} />
                  <DataCardPills>
                    <Badge variant="neutral">{c.type === "Web" ? "Test" : "Phone"}</Badge>
                    <Badge variant={c.outcome === "completed" ? "success" : "neutral"}>
                      {capitalize(c.outcome)}
                    </Badge>
                  </DataCardPills>
                  <DataCardGrid>
                    <CardField label="Number">
                      <span className="tabular-nums">{c.callerNumber || "—"}</span>
                    </CardField>
                    <CardField label="Duration">
                      <span className="tabular-nums">{c.durationSec}s</span>
                    </CardField>
                  </DataCardGrid>
                </DataCard>
              ))}
            </div>

            <div className="border-t border-border px-5 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={callTotal}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                pageSizeOptions={COMPACT_PAGE_SIZE_OPTIONS}
                noun="calls"
                className="mt-0"
              />
            </div>
          </>
        )}
      </Card>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirm(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "reactivate" ? "Reactivate account" : "Suspend account"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "reactivate" ? (
                <>
                  This restores access for{" "}
                  <span className="font-medium text-foreground">{customer.fullName}</span>. They'll be
                  able to sign in again and their AI receptionist will come back online. We'll email
                  them to confirm.
                </>
              ) : (
                <>
                  This immediately locks{" "}
                  <span className="font-medium text-foreground">{customer.fullName}</span> out of their
                  account. They'll be signed out, won't be able to log back in, and their AI will stop
                  answering calls. We'll email them that the account was suspended.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {confirm === "suspend" && (
            <div className="space-y-1.5">
              <Label htmlFor="suspend-reason">Reason (optional)</Label>
              <Textarea
                id="suspend-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Shared with the customer in the suspension email."
                disabled={busy}
              />
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirm(null);
                setReason("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant={confirm === "reactivate" ? "primary" : "danger"}
              onClick={moderate}
              disabled={busy}
            >
              {busy && <Loader2 className="animate-spin" />}
              {confirm === "reactivate" ? "Reactivate account" : "Suspend account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
