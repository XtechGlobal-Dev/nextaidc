import { useEffect, useState } from "react";
import { BadgeDollarSign, Gauge, LayoutGrid } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BRAND_MODULES, type BrandModuleId, type FeatureAccess } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SetupDraft } from "./brandSetupDraft";

// What a brand pays the platform and what it gets for it: the fixed monthly fee, monthly caps across
// its customers, and per module whether it's included, sold as an add-on, or off. Used by the create
// wizard and the brand page's Billing tab, so both read and validate the same way.

export type BillingDraft = Pick<
  SetupDraft,
  | "platformFeeCents"
  | "platformFeeCurrency"
  | "featurePrices"
  | "monthlyMinuteLimit"
  | "monthlyAiLimit"
  | "modules"
  | "brandPlanId"
>;

const FEE_CURRENCIES = ["usd", "aud"] as const;
/** What a module is offered at when first switched to "Add-on" — a starting point, not a suggestion. */
const DEFAULT_ADDON_CENTS = 1000;

export function featureAccessOf(d: BillingDraft, id: BrandModuleId): FeatureAccess {
  if (!d.modules[id]) return "off";
  return d.featurePrices[id] !== undefined ? "addon" : "included";
}

/** Why the billing half can't be saved, or null. `feeRequired`: the wizard insists on a fee. On a brand plan
 *  there's nothing to check — the plan sets it all. */
export function billingDraftProblem(d: BillingDraft, opts: { feeRequired?: boolean } = {}): string | null {
  if (d.brandPlanId) return null;
  if (opts.feeRequired && d.platformFeeCents <= 0) return "Set the brand's monthly fee.";
  for (const m of BRAND_MODULES) {
    if (featureAccessOf(d, m.id) === "addon" && !(Number(d.featurePrices[m.id]) > 0)) {
      return `Give the ${m.label} add-on a monthly price.`;
    }
  }
  return null;
}

export function BrandBillingFields({
  value,
  onChange,
  feeRequired = false,
  currencyLocked = false,
  purchased = [],
}: {
  value: BillingDraft;
  onChange: (p: Partial<BillingDraft>) => void;
  feeRequired?: boolean;
  /** The brand's subscription is live — Stripe can't change its currency. */
  currencyLocked?: boolean;
  /** Add-ons the brand has already bought, flagged so taking one off sale isn't done blind. */
  purchased?: BrandModuleId[];
}) {
  const setAccess = (id: BrandModuleId, access: FeatureAccess) => {
    const prices = { ...value.featurePrices };
    if (access === "addon") prices[id] = prices[id] ?? DEFAULT_ADDON_CENTS;
    else delete prices[id];
    onChange({ modules: { ...value.modules, [id]: access !== "off" }, featurePrices: prices });
  };

  const upper = value.platformFeeCurrency.toUpperCase();

  return (
    <div className="space-y-6">
      {/* ------------------------------ Fee ------------------------------ */}
      <div>
        <Heading icon={BadgeDollarSign} title="Monthly fee" required={feeRequired} />
        <div className="mt-2 flex max-w-sm items-stretch">
          <Select
            value={value.platformFeeCurrency}
            onValueChange={(platformFeeCurrency) => onChange({ platformFeeCurrency })}
            disabled={currencyLocked}
          >
            <SelectTrigger className="h-10 w-[5.5rem] rounded-r-none border-r-0" aria-label="Currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEE_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MoneyInput
            id="b-fee"
            cents={value.platformFeeCents}
            onChange={(platformFeeCents) => onChange({ platformFeeCents })}
            placeholder="49.00"
            className="rounded-l-none"
          />
          <span className="ml-2 self-center text-sm text-muted-foreground">/ month</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Charged to the brand&rsquo;s card every month from the day its admin activates billing,
          whether the brand uses the platform or not. Unpaid, its admin panel is locked to Billing
          and, after the grace period, its customers&rsquo; AI pauses.
          {currencyLocked && ` The currency is fixed at ${upper} while the subscription is live.`}
        </p>
      </div>

      {/* ----------------------------- Limits ----------------------------- */}
      <div>
        <Heading icon={Gauge} title="Monthly limits" />
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <LimitInput
            id="b-limit-minutes"
            label="Call minutes"
            value={value.monthlyMinuteLimit}
            onChange={(monthlyMinuteLimit) => onChange({ monthlyMinuteLimit })}
          />
          <LimitInput
            id="b-limit-ai"
            label="AI interactions"
            value={value.monthlyAiLimit}
            onChange={(monthlyAiLimit) => onChange({ monthlyAiLimit })}
          />
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Across all of the brand&rsquo;s customers, per calendar month (UTC). Its admin is warned at
          80%; at 100% the AI pauses until the 1st or until you raise the limit. A call counts as one AI
          interaction, and so does each AI text, WhatsApp reply and booking action. Blank = no limit.
        </p>
      </div>

      {/* ---------------------------- Features ---------------------------- */}
      <div>
        <Heading icon={LayoutGrid} title="Features" />
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">Included</strong> comes with the fee.{" "}
          <strong className="font-medium text-foreground">Add-on</strong> stays hidden from the brand
          until its admin buys it from Billing, at the monthly price you set.{" "}
          <strong className="font-medium text-foreground">Off</strong> isn&rsquo;t offered at all.
        </p>
        <div className="mt-3 divide-y divide-border rounded-xl border border-border">
          {BRAND_MODULES.map((m) => {
            const access = featureAccessOf(value, m.id);
            const bought = purchased.includes(m.id);
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {m.label}
                    {bought && (
                      <Badge variant="success" className="text-[10px]">
                        Bought
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                  {bought && access !== "addon" && (
                    <p className="mt-1 text-xs font-medium text-foreground">
                      The brand is paying for this. Saving stops the charge
                      {access === "off" ? " and switches it off." : " — it becomes included."}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {access === "addon" && (
                    <div className="flex items-center gap-1.5">
                      <MoneyInput
                        id={`b-addon-${m.id}`}
                        cents={value.featurePrices[m.id] ?? 0}
                        onChange={(cents) =>
                          onChange({ featurePrices: { ...value.featurePrices, [m.id]: cents } })
                        }
                        placeholder="10.00"
                        className="h-9 w-24"
                        aria-label={`${m.label} monthly price`}
                      />
                      <span className="text-xs text-muted-foreground">{upper}/mo</span>
                    </div>
                  )}
                  <Segmented
                    value={access}
                    onChange={(a) => setAccess(m.id, a)}
                    label={`${m.label} access`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Heading({ icon: Icon, title, required }: { icon: typeof Gauge; title: string; required?: boolean }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium">
      <Icon className="size-4 text-muted-foreground" />
      {title}
      {required && <span className="text-danger">*</span>}
    </p>
  );
}

const ACCESS_OPTIONS: { id: FeatureAccess; label: string }[] = [
  { id: "included", label: "Included" },
  { id: "addon", label: "Add-on" },
  { id: "off", label: "Off" },
];

function Segmented({
  value,
  onChange,
  label,
}: {
  value: FeatureAccess;
  onChange: (v: FeatureAccess) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
      {ACCESS_OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.id
              ? o.id === "off"
                ? "bg-card text-foreground shadow-sm"
                : "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LimitInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label} / month
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        className="mt-1"
        value={value ?? ""}
        placeholder="No limit"
        onChange={(e) => {
          const raw = e.target.value.trim();
          const n = Number(raw);
          onChange(raw === "" || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n)));
        }}
      />
    </div>
  );
}

/** A money field in major units that keeps what's typed ("49.") while reporting whole minor units. */
export function MoneyInput({
  cents,
  onChange,
  className,
  ...rest
}: {
  cents: number;
  onChange: (cents: number) => void;
  className?: string;
  id?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(cents ? String(cents / 100) : "");
  // Follow outside changes (a reset, a reload) without fighting the one being typed.
  useEffect(() => {
    const typed = Math.round(Number(text || 0) * 100);
    if (typed !== cents) setText(cents ? String(cents / 100) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an outside change should resync
  }, [cents]);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      className={cn("min-w-0", className)}
      onChange={(e) => {
        const next = e.target.value.replace(/[^0-9.]/g, "");
        if ((next.match(/\./g) ?? []).length > 1) return;
        setText(next);
        const n = Number(next);
        onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
      }}
    />
  );
}
