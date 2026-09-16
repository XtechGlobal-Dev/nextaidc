import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, ApiError, type UnroutedStripeEvent } from "@/lib/api";
import { formatDateDMY } from "@/lib/utils";

/** Stripe events with no brand. Hidden when empty. Retry replays as the webhook would (after the account gets its Stripe id); Dismiss buries an event that was never ours. */
export function StripeUnroutedCard() {
  const [events, setEvents] = useState<UnroutedStripeEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.super.stripe
      .unrouted()
      .then((r) => {
        if (active) setEvents(r.events);
      })
      .catch(() => {
        if (active) setEvents([]);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!events || events.length === 0) return null;

  async function act(id: string, what: "retry" | "dismiss") {
    setBusy(id);
    try {
      if (what === "retry") {
        await api.super.stripe.retry(id);
        toast.success("Event applied to its brand.");
      } else {
        await api.super.stripe.dismiss(id);
        toast.success("Event dismissed.");
      }
      setEvents((prev) => (prev ?? []).filter((e) => e.id !== id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-5 border-amber-300/60 bg-amber-50/40 p-5 dark:border-amber-700/50 dark:bg-amber-950/20">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <AlertTriangle className="size-4 text-amber-600" /> Stripe events waiting for a brand
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These payments and subscription changes arrived for a Stripe customer no brand holds.
        They are kept, not dropped. Give the customer's account its Stripe customer id, then
        retry; dismiss anything that was never ours.
      </p>
      <ul className="mt-4 divide-y divide-border/60">
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{e.type}</div>
              <div className="truncate text-xs text-muted-foreground">
                customer {e.stripeCustomerId ?? "—"}
                {e.stripeSubscriptionId ? ` · subscription ${e.stripeSubscriptionId}` : ""} ·{" "}
                {formatDateDMY(e.receivedAt)} · {e.reason}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy === e.id} onClick={() => act(e.id, "retry")}>
                {busy === e.id ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                Retry
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => act(e.id, "dismiss")}>
                <X className="size-4" /> Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
