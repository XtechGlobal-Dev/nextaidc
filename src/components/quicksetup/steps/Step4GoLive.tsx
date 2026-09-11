import { useEffect, useState } from "react";
import { Check, Rocket, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { api, type BillingInterval } from "@/lib/api";
import { formatMoney } from "@/lib/currency";

const FEATURES: { title: string; subtitle: string }[] = [
  { title: "24/7 Live Call Handling", subtitle: "Never miss another client call" },
  { title: "Your Own AI Phone Number", subtitle: "A dedicated line your AI answers" },
  { title: "Captures Every Lead", subtitle: "Caller details, summaries & CRM sync" },
  { title: "Trained On Your Business", subtitle: "Answers in your brand's voice, your way" },
];

const INTERVAL_LABEL: Record<BillingInterval, string> = {
  week: "week",
  month: "month",
  year: "year",
};

interface GoLiveTerms {
  trialDays: number;
  trialMinutes: number;
  priceCents: number | null;
  currency: string;
  interval: BillingInterval | null;
}

export default function Step4GoLive() {
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState<GoLiveTerms | null>(null);

  // Pull the real free-trial terms (days + minutes) and the user's plan price so
  // the offer reflects the live config instead of hardcoded values.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [trial, subRes, plans] = await Promise.all([
          api.billing.trialInfo(),
          api.billing.subscription().catch(() => ({ subscription: null })),
          api.billing.plans().catch(() => []),
        ]);
        const sub = subRes.subscription;
        // Prefer the user's subscribed plan; fall back to the cheapest active plan.
        const cheapest = [...plans].sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
        if (!active) return;
        setTerms({
          trialDays: trial.days,
          trialMinutes: trial.minutes,
          priceCents: sub?.priceCents ?? cheapest?.priceCents ?? null,
          currency: sub?.currency ?? cheapest?.currency ?? "USD",
          interval: (sub?.interval as BillingInterval) ?? cheapest?.interval ?? null,
        });
      } catch {
        /* leave terms null — the trial summary just hides until it loads */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function handleStart() {
    if (busy) return;
    setBusy(true);
    setTimeout(() => {
      useQuickSetupStore.getState().complete();
      toast.success("You're live! 🎉", {
        description: "Your AI receptionist is ready.",
      });
    }, 1000);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h2 className="text-xl font-bold text-foreground">
          You're all set 🎉
        </h2>
        <p className="text-sm text-muted-foreground">
          Your plan is active and your number is connected — you're ready to take calls
        </p>
      </div>

      <Card className="space-y-5 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-success-tint text-success">
                <Check className="size-3.5" />
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-bold text-foreground">{f.title}</p>
                <p className="text-xs text-muted-foreground">{f.subtitle}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-end justify-between border-t border-border pt-5">
          <div className="space-y-0.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Your plan
            </p>
            <p className="text-3xl font-bold text-primary">
              {terms?.priceCents != null && terms.interval
                ? `${formatMoney(terms.priceCents, terms.currency)}/${INTERVAL_LABEL[terms.interval]}`
                : "Active"}
            </p>
            <p className="text-xs text-muted-foreground">Active now · cancel anytime</p>
          </div>
          <div className="space-y-0.5 text-right text-sm font-medium text-success">
            <p className="inline-flex items-center gap-1">
              <Check className="size-4" /> Plan active
            </p>
          </div>
        </div>
      </Card>

      <Button
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={handleStart}
      >
        {busy ? (
          <>
            <Loader2 className="animate-spin" />
            Finishing…
          </>
        ) : (
          <>
            <Rocket />
            Finish & go to my dashboard
          </>
        )}
      </Button>

    </div>
  );
}
