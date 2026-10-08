import type { ReactNode } from "react";
import { PhoneCall } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DataCard,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import type { CustomerDetail } from "@/lib/api";
import { usePagination } from "@/hooks/usePagination";
import { COMPACT_PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { capitalize, formatDate } from "@/lib/utils";
import { isAdminRole } from "@/lib/roles";
import { PlanPill } from "./PlanPill";

// One customer's deep dive — profile, billing, usage, agent and recent calls. Shared by the brand admin's
// customer page and the super admin's Platform Customer page, which differ only in header and actions.

export function Field({ label, value, title }: { label: string; value: string; title?: string }) {
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

export function CustomerDetailBody({
  data,
  afterAgent,
}: {
  data: CustomerDetail;
  /** Rendered between the AI agent card and the recent calls (the brand admin's discount card). */
  afterAgent?: ReactNode;
}) {
  const { customer, agent, calls, usage, billing } = data;
  const {
    page,
    pageSize,
    pageItems: pagedCalls,
    total: callTotal,
    setPage,
    setPageSize,
  } = usePagination(calls, {
    initialPageSize: COMPACT_PAGE_SIZE_OPTIONS[1],
  });

  return (
    <>
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
              {/* Pass the plan name, not the free/premium flag — that reads "Free" during a paid-plan trial. */}
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
            {/* Onboarding rule at signup — the toggle only affects new signups, so support needs to see which one applies. */}
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

      {afterAgent}

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
    </>
  );
}
