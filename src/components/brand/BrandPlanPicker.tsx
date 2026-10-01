import { Check, Lock, Plus, SlidersHorizontal } from "lucide-react";
import { BRAND_MODULES, type BrandAddon, type BrandPlan } from "@/lib/api";
import { BRAND_PLAN_BASICS } from "@/lib/brandPlanFeatures";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";

// Brand plans as selectable cards — what a BRAND pays the platform (never the plans it sells its own
// customers). Each card says what's included, what can be added on and at what price, and the monthly caps.
// Used by the public request form, the super admin's wizard and a brand's Billing tab.

export function BrandPlanPicker({
  plans,
  addons,
  value,
  onChange,
  allowCustom = false,
  locked = false,
  className,
}: {
  plans: BrandPlan[];
  /** The add-on list, to show what each plan can be topped up with. */
  addons: BrandAddon[];
  /** The selected plan id; null = custom (only offered with `allowCustom`). */
  value: string | null;
  onChange: (planId: string | null) => void;
  /** Offer "Custom" — billing set by hand (super admin only). */
  allowCustom?: boolean;
  /** The applicant already chose and paid for this plan when they filed their request — show it as a
   *  done deal, not an open choice. Only the matching plan renders, as a plain (non-clickable) card;
   *  every other plan and "Custom" are hidden, since there's nothing left to pick here. */
  locked?: boolean;
  className?: string;
}) {
  if (locked) {
    const chosen = plans.find((p) => p.id === value);
    if (!chosen) {
      return (
        <p className={cn("rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground", className)}>
          The applicant didn&rsquo;t choose a plan when they applied — pick one for this brand below.
        </p>
      );
    }
    return (
      <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", className)}>
        <PlanCard plan={chosen} addons={addons} selected locked />
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="Brand plan" className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} addons={addons} selected={value === plan.id} onSelect={() => onChange(plan.id)} />
      ))}
      {allowCustom && (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          onClick={() => onChange(null)}
          className={cn(
            "flex flex-col rounded-xl border border-dashed p-4 text-left transition-colors focus-visible:focus-ring",
            value === null ? "border-primary bg-primary-tint-soft ring-2 ring-primary/25" : "border-border hover:border-primary/40",
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="size-4 text-muted-foreground" /> Custom
            </span>
            {value === null && <Check className="size-4 text-primary" />}
          </span>
          <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Set this brand&rsquo;s fee, features and limits by hand — for a one-off deal.
          </span>
        </button>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  addons,
  selected,
  locked = false,
  onSelect,
}: {
  plan: BrandPlan;
  addons: BrandAddon[];
  selected: boolean;
  /** Shown as a plain card — already decided, nothing to click. */
  locked?: boolean;
  onSelect?: () => void;
}) {
  const included = new Set(plan.features);
  const addOns = addons.filter((a) => a.active && !included.has(a.moduleId) && a.priceCents);
  const limits = [
    plan.monthlyMinuteLimit != null && `${plan.monthlyMinuteLimit.toLocaleString()} call minutes`,
    plan.monthlyAiLimit != null && `${plan.monthlyAiLimit.toLocaleString()} AI interactions`,
  ].filter(Boolean) as string[];

  const Wrapper = locked ? "div" : "button";

  return (
    <Wrapper
      {...(locked
        ? {}
        : { type: "button", role: "radio", "aria-checked": selected, onClick: onSelect })}
      className={cn(
        "flex flex-col rounded-xl border p-4 text-left transition-colors",
        locked ? "cursor-default" : "focus-visible:focus-ring",
        selected ? "border-primary bg-primary-tint-soft ring-2 ring-primary/25" : "border-border hover:border-primary/40",
      )}
    >
      {locked && (
        <span className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground">
          <Lock className="size-3" /> Chosen &amp; paid by the applicant
        </span>
      )}
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{plan.name}</span>
            {plan.recommended && (
              <span className="shrink-0 rounded-full bg-premium-tint px-2 py-0.5 text-[10px] font-semibold text-premium">
                Popular
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xl font-bold tabular-nums">
            {plan.priceCents ? formatMoney(plan.priceCents, plan.currency) : "Free"}
            {plan.priceCents > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">/ month</span>}
          </span>
        </span>
        {!locked && (
          <span
            className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card",
            )}
          >
            {selected && <Check className="size-3" />}
          </span>
        )}
      </span>
      {plan.description && <span className="mt-1 text-xs leading-relaxed text-muted-foreground">{plan.description}</span>}

      <span className="mt-3 block space-y-1">
        {[...BRAND_PLAN_BASICS, ...BRAND_MODULES.filter((m) => included.has(m.id)).map((m) => m.label)].map((label) => (
          <span key={label} className="flex items-center gap-1.5 text-xs">
            <Check className="size-3.5 shrink-0 text-success" /> {label}
          </span>
        ))}
      </span>

      {addOns.length > 0 && (
        <span className="mt-3 block border-t border-border pt-2.5">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Add-ons</span>
          {addOns.map((a) => (
            <span key={a.moduleId} className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Plus className="size-3.5 shrink-0" /> {a.label}
              </span>
              <span className="tabular-nums">{formatMoney(a.priceCents ?? 0, plan.currency)}/mo</span>
            </span>
          ))}
        </span>
      )}

      {limits.length > 0 && (
        <span className="mt-3 block text-[11px] text-muted-foreground">Up to {limits.join(" · ")} a month</span>
      )}
      {locked && (
        <span className="mt-3 block text-[11px] text-muted-foreground">
          To use a different plan, change it after setup from the brand&rsquo;s Billing tab.
        </span>
      )}
    </Wrapper>
  );
}
