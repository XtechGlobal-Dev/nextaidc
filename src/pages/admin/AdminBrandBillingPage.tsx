import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CreditCard,
  Loader2,
  Lock,
  Plus,
  Receipt,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { UsageMeter } from "@/components/billing/UsageMeter";
import { BrandCardForm } from "@/components/billing/BrandCardForm";
import { BrandInvoiceTable } from "@/components/billing/BrandInvoiceTable";
import { api, ApiError, type BrandFeature } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { billingStatusMeta, serviceHoldCopy } from "@/lib/brandBilling";
import { useAuthStore } from "@/stores/useAuthStore";
import { useBrandBillingStore } from "@/stores/useBrandBillingStore";
import { useBrandingStore } from "@/stores/useBrandingStore";

// A brand admin's bill from the platform: the fixed monthly fee, the feature add-ons they can buy, the
// card that pays for both, and this month's usage against the limits the platform set. While the fee is
// unpaid this is the only page their panel opens (see the gate in AppLayout).

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—";

export default function AdminBrandBillingPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const brandName = useBrandingStore((s) => s.brand?.name) || "your brand";
  const billing = useBrandBillingStore((s) => s.billing);
  const loaded = useBrandBillingStore((s) => s.loaded);
  const refresh = useBrandBillingStore((s) => s.refresh);
  const setBilling = useBrandBillingStore((s) => s.set);

  const [cardOpen, setCardOpen] = useState(false);
  const [buying, setBuying] = useState<BrandFeature | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);
  const [removing, setRemoving] = useState<BrandFeature | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!loaded && !billing) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (!billing) {
    return (
      <Card className="p-6 text-sm text-danger">
        Billing couldn&rsquo;t be loaded. Refresh the page to try again.
      </Card>
    );
  }

  const money = (cents: number) => formatMoney(cents, billing.currency);
  const status = billingStatusMeta(billing.status);
  const hold = serviceHoldCopy(billing.usage.hold);
  const neverPaid = billing.status === "awaiting_card";
  const needsCard = billing.status === "past_due" || billing.status === "canceled";
  const included = billing.features.filter((f) => f.access === "included");
  const addOns = billing.features.filter((f) => f.access === "addon");
  const boughtAddOns = addOns.filter((f) => f.purchased);

  async function confirmCard(paymentMethodId: string) {
    const next = await api.brandAdmin.billing.activate(paymentMethodId);
    setBilling(next);
    setCardOpen(false);
    toast.success(
      neverPaid || needsCard
        ? "Payment received — your subscription is active 🎉"
        : "Card updated",
    );
  }

  async function buy() {
    if (!buying) return;
    setBuyBusy(true);
    try {
      setBilling(await api.brandAdmin.billing.buyFeature(buying.id));
      toast.success(`${buying.label} is on — your customers can use it now.`);
      setBuying(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The add-on couldn't be added.");
    } finally {
      setBuyBusy(false);
    }
  }

  // Throws on failure so the dialog stays open with the error.
  async function remove() {
    if (!removing) return;
    setBilling(await api.brandAdmin.billing.cancelFeature(removing.id));
    toast.success(`${removing.label} removed`);
  }

  const cardDialogCopy = neverPaid
    ? {
        title: "Activate your subscription",
        submit: `Pay ${money(billing.monthlyTotalCents)} & activate`,
        note: "Charged today, then automatically every month on this date.",
      }
    : needsCard
      ? {
          title: "Update your card",
          submit: "Save card & pay what's due",
          note: "The overdue invoice is paid with this card now; future renewals use it too.",
        }
      : {
          title: "Update your card",
          submit: "Save card",
          note: "Nothing is charged now. Your next renewal uses this card.",
        };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing"
        subtitle={`What ${brandName} pays the platform each month, and what it gets.`}
        actions={billing.required ? <Badge variant={status.variant}>{status.label}</Badge> : undefined}
      />

      {!billing.stripeReady && billing.required && (
        <Card className="p-4 text-sm text-muted-foreground">
          Card payments aren&rsquo;t set up on the platform yet. Your platform team has been told;
          nothing is needed from you for now.
        </Card>
      )}

      {/* Never paid: the one thing this page is for. */}
      {neverPaid && (
        <Card className="overflow-hidden border-primary/30">
          <div className="bg-primary-tint-soft p-6 sm:p-8">
            <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Lock className="size-5" />
            </span>
            <h2 className="mt-4 text-xl font-semibold tracking-tight">Activate {brandName}</h2>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Your brand runs on a fixed monthly subscription. Once it&rsquo;s paid, your admin panel
              opens and your customers&rsquo; AI keeps running.
              {billing.pausesAt && (
                <>
                  {" "}
                  If it isn&rsquo;t paid by <strong className="text-foreground">{fmtDate(billing.pausesAt)}</strong>,
                  your customers&rsquo; AI is paused.
                </>
              )}
            </p>
            <p className="mt-5 text-3xl font-semibold tabular-nums">
              {money(billing.monthlyTotalCents)}
              <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                / month{billing.plan ? ` · ${billing.plan.name} plan` : ""}
              </span>
            </p>
            {included.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
                {included.map((f) => (
                  <li key={f.id} className="flex items-center gap-1.5 text-sm">
                    <Check className="size-4 text-success" /> {f.label}
                  </li>
                ))}
              </ul>
            )}
            {isAdmin ? (
              <Button size="lg" className="mt-6" onClick={() => setCardOpen(true)} disabled={!billing.stripeReady}>
                <CreditCard className="size-4" /> Pay &amp; activate
              </Button>
            ) : (
              <p className="mt-6 text-sm text-muted-foreground">Only your brand&rsquo;s administrator can pay.</p>
            )}
          </div>
        </Card>
      )}

      {needsCard && (
        <Banner>
          <strong>Your last payment didn&rsquo;t go through.</strong>{" "}
          {billing.pausesAt
            ? `Update your card by ${fmtDate(billing.pausesAt)} to keep your customers' AI running.`
            : "Update your card to restore service."}
          {isAdmin && (
            <Button size="sm" variant="danger" className="ml-auto" onClick={() => setCardOpen(true)}>
              Update card &amp; pay
            </Button>
          )}
        </Banner>
      )}

      {hold && !neverPaid && (
        <Banner>
          <strong>{hold.title}.</strong> {hold.body}
        </Banner>
      )}

      {!neverPaid && billing.required && (
        <Card className="p-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={billing.plan ? `${billing.plan.name} plan` : "Monthly total"}>
              {money(billing.monthlyTotalCents)}
              {boughtAddOns.length > 0 && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {money(billing.feeCents)} fee + {boughtAddOns.length} add-on{boughtAddOns.length === 1 ? "" : "s"}
                </span>
              )}
            </Stat>
            <Stat label="Next charge">{fmtDate(billing.currentPeriodEnd)}</Stat>
            <Stat label="Last paid">
              {billing.lastPaidAt
                ? `${fmtDate(billing.lastPaidAt)}${billing.lastPaidCents != null ? ` · ${money(billing.lastPaidCents)}` : ""}`
                : "—"}
            </Stat>
            <Stat label="Card">
              {billing.card ? (
                <span className="flex items-center gap-2">
                  <span className="capitalize">
                    {billing.card.brand} •••• {billing.card.last4}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => setCardOpen(true)}
                    >
                      Change
                    </button>
                  )}
                </span>
              ) : (
                "None"
              )}
            </Stat>
          </div>
        </Card>
      )}

      {/* Usage against the limits the platform set. */}
      <Card className="p-5">
        <h3 className="text-base font-semibold">This month&rsquo;s usage</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Across all your customers. Resets on {fmtDate(billing.usage.resetsAt)}.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <UsageMeter label="Call minutes" used={billing.usage.minutes} limit={billing.usage.minutesLimit} unit="min" />
          <UsageMeter
            label="AI interactions"
            used={billing.usage.aiInteractions}
            limit={billing.usage.aiLimit}
            unit="interactions"
          />
        </div>
      </Card>

      {/* Features: what's included, and what can be added. */}
      {(addOns.length > 0 || included.length > 0) && (
        <Card className="p-5">
          <h3 className="text-base font-semibold">Features</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Add-ons appear in your customers&rsquo; dashboards the moment they&rsquo;re added.
          </p>
          {addOns.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {addOns.map((f) => (
                <div
                  key={f.id}
                  className={
                    f.purchased
                      ? "flex flex-col rounded-xl border border-primary/40 bg-primary-tint-soft p-4"
                      : "flex flex-col rounded-xl border border-border p-4"
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <Sparkles className="size-4 text-primary" /> {f.label}
                    </p>
                    {f.purchased && <Badge variant="success">Active</Badge>}
                  </div>
                  <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{f.description}</p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold tabular-nums">
                      {money(f.priceCents ?? 0)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">/ month</span>
                    </span>
                    {isAdmin &&
                      (f.purchased ? (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(f)}>
                          Remove
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => setBuying(f)}
                          disabled={neverPaid || needsCard || !billing.card}
                          title={neverPaid ? "Activate your subscription first" : needsCard ? "Settle the overdue payment first" : undefined}
                        >
                          <Plus className="size-3.5" /> Add
                        </Button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {included.length > 0 && (
            <div className={addOns.length > 0 ? "mt-5" : ""}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Included</p>
              <ul className="flex flex-wrap gap-2">
                {included.map((f) => (
                  <li
                    key={f.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs"
                  >
                    <Check className="size-3.5 text-success" /> {f.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {isAdmin && billing.invoices.length > 0 && (
        <Card className="p-5">
          <h3 className="mb-3 flex items-center gap-1.5 text-base font-semibold">
            <Receipt className="size-4 text-muted-foreground" /> Invoices
          </h3>
          <BrandInvoiceTable invoices={billing.invoices} />
        </Card>
      )}

      {/* Card entry: activation, a failed renewal, or just a new card. */}
      <Dialog open={cardOpen} onOpenChange={setCardOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{cardDialogCopy.title}</DialogTitle>
            <DialogDescription>
              {neverPaid
                ? `${money(billing.monthlyTotalCents)} a month for ${brandName}.`
                : "Payments to the platform are made with this card."}
            </DialogDescription>
          </DialogHeader>
          {cardOpen && (
            <BrandCardForm submitLabel={cardDialogCopy.submit} note={cardDialogCopy.note} onConfirmed={confirmCard} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={buying !== null} onOpenChange={(open) => !open && !buyBusy && setBuying(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add {buying?.label}?</DialogTitle>
            <DialogDescription>
              {buying && (
                <>
                  {money(buying.priceCents ?? 0)} a month, added to your subscription. Today you&rsquo;re
                  charged only for the rest of this billing month, on your card ending{" "}
                  {billing.card?.last4}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBuying(null)} disabled={buyBusy}>
              Cancel
            </Button>
            <Button onClick={() => void buy()} disabled={buyBusy}>
              {buyBusy && <Loader2 className="size-4 animate-spin" />}
              Add &amp; pay
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        resourceType="add-on"
        resourceName={removing?.label ?? ""}
        title={`Remove ${removing?.label ?? "add-on"}`}
        confirmLabel="Remove"
        onConfirm={remove}
        description={
          <>
            It stops now and disappears from your customers&rsquo; dashboards. There&rsquo;s no refund
            for the rest of this month, and no further charge.
          </>
        }
      />
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold">{children}</p>
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-danger/30 bg-danger-tint p-3.5 text-sm text-danger">
      <AlertTriangle className="size-4 shrink-0" />
      {children}
    </div>
  );
}

