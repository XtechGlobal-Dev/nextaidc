import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CreditCard, Loader2, Receipt } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageMeter } from "@/components/billing/UsageMeter";
import { BrandInvoiceTable } from "@/components/billing/BrandInvoiceTable";
import { api, ApiError, type Brand, type BrandAddon, type BrandBilling, type BrandPlan } from "@/lib/api";
import { BrandPlanPicker } from "@/components/brand/BrandPlanPicker";
import { formatMoney } from "@/lib/currency";
import { billingStatusMeta, serviceHoldCopy } from "@/lib/brandBilling";
import { BrandBillingFields, type BillingDraft } from "./BrandBillingFields";

// The super admin's view of what one brand pays the platform: where payment stands (live from Stripe's
// mirror), this month's usage against its caps, its invoices — and the fee, caps and feature access,
// edited through the page's shared draft and saved with the rest of the brand.

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

export function BrandBillingTab({
  brand,
  value,
  onChange,
  saveButton,
}: {
  brand: Brand;
  value: BillingDraft;
  onChange: (p: Partial<BillingDraft>) => void;
  saveButton: ReactNode;
}) {
  const [billing, setBilling] = useState<BrandBilling | null>(null);
  const [error, setError] = useState("");
  const [plans, setPlans] = useState<BrandPlan[] | null>(null);
  const [addons, setAddons] = useState<BrandAddon[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([api.super.brandPlans.list(), api.super.brandAddons.list()])
      .then(([p, a]) => {
        if (!active) return;
        setPlans(p);
        setAddons(a);
      })
      .catch(() => active && setPlans([]));
    return () => {
      active = false;
    };
  }, []);

  // Reloaded after every save (updatedAt moves), so the status shows what the save did to Stripe.
  useEffect(() => {
    let active = true;
    setError("");
    api.super.brands
      .billing(brand.id)
      .then((b) => active && setBilling(b))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : "Failed to load billing"));
    return () => {
      active = false;
    };
  }, [brand.id, brand.updatedAt]);

  const status = billingStatusMeta(billing?.status);
  const hold = serviceHoldCopy(brand.serviceHold);
  const currencyLocked = billing?.status === "active" || billing?.status === "past_due";

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Where it stands</h3>
            <p className="text-sm text-muted-foreground">
              What {brand.name} pays the platform, and whether it&rsquo;s paid up.
            </p>
          </div>
          {billing && <Badge variant={status.variant}>{status.label}</Badge>}
        </div>

        {error ? (
          <p className="mt-4 text-sm text-danger">{error}</p>
        ) : !billing ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {hold && (
              <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  <strong>{hold.title}.</strong> {hold.body}
                </p>
              </div>
            )}
            {!billing.stripeReady && billing.required && (
              <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">
                Stripe isn&rsquo;t configured on this server, so the brand can&rsquo;t pay yet.
              </p>
            )}

            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Monthly total">
                {billing.required ? formatMoney(billing.monthlyTotalCents, billing.currency) : "Nothing"}
              </Stat>
              <Stat label="Card">
                {billing.card ? (
                  <span className="inline-flex items-center gap-1.5 capitalize">
                    <CreditCard className="size-4 text-muted-foreground" />
                    {billing.card.brand} •••• {billing.card.last4}
                  </span>
                ) : (
                  "None yet"
                )}
              </Stat>
              <Stat label={billing.status === "active" ? "Renews" : "Last paid"}>
                {billing.status === "active" ? fmtDate(billing.currentPeriodEnd) : fmtDate(billing.lastPaidAt)}
              </Stat>
              <Stat label="AI pauses if unpaid">{billing.pausesAt ? fmtDate(billing.pausesAt) : "—"}</Stat>
            </dl>

            <div className="grid gap-3 sm:grid-cols-2">
              <UsageMeter
                label="Call minutes this month"
                used={billing.usage.minutes}
                limit={billing.usage.minutesLimit}
                unit="min"
              />
              <UsageMeter
                label="AI interactions this month"
                used={billing.usage.aiInteractions}
                limit={billing.usage.aiLimit}
                unit="interactions"
              />
            </div>

            {billing.invoices.length > 0 && (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Receipt className="size-4 text-muted-foreground" /> Invoices
                </p>
                <BrandInvoiceTable invoices={billing.invoices} />
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="text-base font-semibold">Brand plan</h3>
        <p className="mb-5 text-sm text-muted-foreground">
          What {brand.name} pays the platform. A plan sets the fee, the features included, the add-on prices and
          the limits, and changes to the plan reach this brand too. New amounts apply from its next invoice.
        </p>
        {plans === null ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <BrandPlanPicker
            // Archived plans aren't offered, except the one this brand is already on.
            plans={plans.filter((p) => p.active || p.id === value.brandPlanId)}
            addons={addons}
            value={value.brandPlanId}
            onChange={(brandPlanId) => onChange({ brandPlanId })}
            allowCustom
          />
        )}
        {value.brandPlanId === null && (
          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-4 text-xs text-muted-foreground">Custom: set by hand. Set the fee to 0 to waive it.</p>
            <BrandBillingFields
              value={value}
              onChange={onChange}
              currencyLocked={currencyLocked}
              purchased={brand.purchasedFeatures}
            />
          </div>
        )}
      </Card>
      <div className="flex justify-end">{saveButton}</div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}
