import { useEffect, useState } from "react";
import { Check, CreditCard, Loader2, RefreshCw, Rocket, Save, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";

/**
 * Admin control for the onboarding card policy.
 *
 * ON  → a new signup must pick a plan and add a card (a $0 authorisation — the
 *       free trial still runs and converts automatically) before the dashboard
 *       opens.
 * OFF → a new signup gets the card-less free trial and reaches the dashboard
 *       straight away; plan + card are collected later, when they claim a number.
 *
 * Each account snapshots this at signup, so flipping it only ever changes what
 * the NEXT signup gets. That is the whole point of the setting — the policy has
 * changed direction before, and this makes it a one-click decision instead of a
 * code change, without ever disturbing customers who are already using the app.
 */

interface Mode {
  key: "required" | "cardless";
  label: string;
  icon: LucideIcon;
  tagline: string;
  /** What a new signup actually experiences, in order. */
  steps: string[];
}

// Shown side by side so the choice is a comparison, not a paragraph — the admin
// can see exactly what each mode does to a new customer before flipping it.
const MODES: Mode[] = [
  {
    key: "required",
    label: "Card required",
    icon: CreditCard,
    tagline: "Card up front, $0 charged",
    steps: [
      "Signs up and sets up their AI",
      "Picks a plan and adds a card — $0 today",
      "Free trial runs in full",
      "Plan starts automatically when the trial ends",
    ],
  },
  {
    key: "cardless",
    label: "Card-less",
    icon: Rocket,
    tagline: "Straight in, card later",
    steps: [
      "Signs up and sets up their AI",
      "Reaches the dashboard right away — no card",
      "Free trial runs in full",
      "Plan and card collected when they claim a number",
    ],
  },
];

export function OnboardingSettings() {
  const [loading, setLoading] = useState(true);
  // The load failed, so we don't know the live value. Shown instead of the cards,
  // because rendering them would assert a policy we can't actually vouch for —
  // and `saved` staying null would leave Save disabled forever with no explanation.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Saved server truth + in-progress draft.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [cardRequired, setCardRequired] = useState(false);

  function load() {
    setLoading(true);
    setLoadFailed(false);
    return api.admin.onboarding
      .get()
      .then((r) => {
        setSaved(r.cardRequired);
        setCardRequired(r.cardRequired);
      })
      .catch((e) => {
        setLoadFailed(true);
        toast.error(e instanceof ApiError ? e.message : "Failed to load onboarding settings");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
    // Loaded once on mount; `load` is also the Retry handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = saved !== null && saved !== cardRequired;

  async function save() {
    setSaving(true);
    try {
      const r = await api.admin.onboarding.set(cardRequired);
      setSaved(r.cardRequired);
      setCardRequired(r.cardRequired);
      toast.success(r.cardRequired ? "Card is now required at signup" : "Signup is now card-less", {
        description: "Applies to new signups from now on. Existing accounts are unchanged.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save onboarding settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <CreditCard className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Onboarding</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Whether new customers must add a card before they get in.
            </p>
          </div>
        </div>
        {/* Reflects the LIVE saved value, never the draft — and never guesses when
            the load failed, or it would assert a policy that may be the opposite
            of what new signups are actually getting. */}
        {!loading &&
          (loadFailed ? (
            <Badge variant="warning">Unknown</Badge>
          ) : saved ? (
            <Badge variant="primary">Card required</Badge>
          ) : (
            <Badge variant="outline">Card-less</Badge>
          ))}
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : loadFailed ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Couldn't load the current onboarding policy, so it isn't safe to change it here.
            </p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-4" /> Retry
            </Button>
          </div>
        ) : (
          <>
            {/* The two modes ARE the control — pick one. Each shows what a new
                customer actually experiences, so the choice is a comparison
                rather than a paragraph to decode. */}
            <div
              role="group"
              aria-label="Onboarding card policy"
              className="grid gap-3 sm:grid-cols-2"
            >
              {MODES.map((mode) => {
                const active = cardRequired === (mode.key === "required");
                const Icon = mode.icon;
                return (
                  <button
                    key={mode.key}
                    type="button"
                    onClick={() => setCardRequired(mode.key === "required")}
                    disabled={saving}
                    aria-pressed={active}
                    className={cn(
                      "group rounded-xl border p-4 text-left transition-all",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      active
                        ? "border-primary/50 bg-primary-tint-soft shadow-[var(--shadow-soft)]"
                        : "border-border bg-card hover:border-primary/30 hover:bg-warm/50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={cn(
                            "grid size-9 shrink-0 place-items-center rounded-xl transition-colors",
                            active
                              ? "bg-primary/15 text-primary"
                              : "bg-muted text-muted-foreground group-hover:text-foreground",
                          )}
                        >
                          <Icon className="size-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <p
                            className={cn(
                              "text-sm font-semibold leading-tight",
                              active ? "text-foreground" : "text-foreground/80",
                            )}
                          >
                            {mode.label}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{mode.tagline}</p>
                        </div>
                      </div>
                      {active && (
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-white">
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                      )}
                    </div>

                    <ol className="mt-3.5 space-y-2 border-t border-border/70 pt-3.5">
                      {mode.steps.map((step, i) => (
                        <li key={step} className="flex items-start gap-2.5 text-xs">
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none",
                              active
                                ? "bg-primary/15 text-primary"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {i + 1}
                          </span>
                          <span className="leading-snug text-muted-foreground">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </button>
                );
              })}
            </div>

            {/* The single most misread thing about this setting — an admin's natural
                assumption is that flipping it applies to everyone. */}
            <div className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success-tint px-3.5 py-2.5 text-xs">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
              <span className="leading-relaxed text-foreground/80">
                Applies to <strong className="font-semibold text-foreground">new signups only</strong>.
                Every account remembers the rule that applied the day it was created — turning this on
                never walls off a customer who is already using the app, and turning it off doesn't
                hand a free pass to someone who signed up while it was on.
              </span>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
              {dirty && (
                // The header badge shows what is LIVE, the cards show the draft —
                // spell out the difference so a half-made change can't be misread
                // as already applied.
                <span className="text-xs text-muted-foreground">
                  Unsaved — new signups still get{" "}
                  <strong className="font-medium text-foreground">
                    {saved ? "Card required" : "Card-less"}
                  </strong>{" "}
                  until you save.
                </span>
              )}
              <Button size="sm" onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
