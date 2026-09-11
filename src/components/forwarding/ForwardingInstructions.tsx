import { useMemo, useState } from "react";
import { ArrowRight, Check, Copy, Phone, PhoneForwarded } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  buildForwarding,
  defaultForwardingCountry,
  findCarrier,
  FORWARDING_COUNTRIES,
  type ForwardingCountry,
  type ForwardingMode,
} from "@/data/callForwarding";

interface Props {
  /** The AI number the owner forwards TO. */
  aiNumber: string;
  /** The owner's existing published number they forward FROM (display only). */
  businessNumber?: string;
  /** Selected forwarding behaviour (controlled so the parent can persist it). */
  mode: ForwardingMode;
  onModeChange: (mode: ForwardingMode) => void;
  /** Tighter spacing for embedding in the go-live step / dialogs. */
  compact?: boolean;
  className?: string;
}

/**
 * Guided call-forwarding instructions. Shows the "existing number → AI number"
 * summary, a mode toggle (all vs overflow), country + carrier selectors, and the
 * exact copy-paste dial codes with steps. Pure UI over the buildForwarding()
 * engine — reused in Settings, the go-live step and the sidebar help dialog.
 */
export default function ForwardingInstructions({
  aiNumber,
  businessNumber,
  mode,
  onModeChange,
  compact,
  className,
}: Props) {
  // Default the carrier country from the owner's existing number, else the AI number.
  const [country, setCountry] = useState<ForwardingCountry>(() =>
    defaultForwardingCountry(businessNumber || aiNumber),
  );
  const countryDef =
    FORWARDING_COUNTRIES.find((c) => c.id === country) ?? FORWARDING_COUNTRIES[0];
  const [carrierId, setCarrierId] = useState<string>(() => countryDef.carriers[0].id);

  const carrier = findCarrier(country, carrierId);
  const recipe = useMemo(
    () => buildForwarding(aiNumber, country, carrier.id, mode),
    [aiNumber, country, carrier.id, mode],
  );

  function pickCountry(next: string) {
    const nextDef = FORWARDING_COUNTRIES.find((c) => c.id === next) ?? FORWARDING_COUNTRIES[0];
    setCountry(nextDef.id);
    setCarrierId(nextDef.carriers[0].id); // reset carrier — it's country-specific
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* From → To summary */}
      <div className="flex items-center justify-center gap-3 rounded-xl bg-muted/60 p-3 text-center">
        <NumberChip
          icon={<Phone className="size-4" />}
          label="Your number"
          value={businessNumber?.trim() || "Your existing number"}
        />
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        <NumberChip
          icon={<PhoneForwarded className="size-4 text-primary" />}
          label="Your AI"
          value={aiNumber}
          highlight
        />
      </div>

      {/* Mode toggle */}
      <div>
        <div className="grid grid-cols-2 gap-2">
          <ModeButton
            active={mode === "all"}
            title="Forward all calls"
            subtitle="Your AI answers every call"
            onClick={() => onModeChange("all")}
          />
          <ModeButton
            active={mode === "overflow"}
            title="Overflow only"
            subtitle="AI takes busy / missed calls"
            onClick={() => onModeChange("overflow")}
          />
        </div>
      </div>

      {/* Country + carrier */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Where's your phone?
          </label>
          <Select value={country} onValueChange={pickCountry}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[1100]">
              {FORWARDING_COUNTRIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Carrier
          </label>
          <Select value={carrierId} onValueChange={setCarrierId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[1100]">
              {countryDef.carriers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* The dial codes to enter */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {mode === "all" ? "Dial this on your phone" : "Dial these on your phone"}
        </p>
        {recipe.activate.map((c) => (
          <CodeRow key={c.code} label={c.label} code={c.code} />
        ))}
      </div>

      {/* Steps */}
      {!compact && (
        <ol className="space-y-2">
          {recipe.steps.map((step, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-tint text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Turn-off codes */}
      <p className="text-xs text-muted-foreground">
        To turn forwarding off later, dial{" "}
        {recipe.cancel.map((c, i) => (
          <span key={c.code}>
            {i > 0 && " and "}
            <span className="font-mono font-medium text-foreground">{c.code}</span>
          </span>
        ))}
        .
      </p>

      {/* Carrier caveat */}
      {recipe.note && <p className="text-xs text-muted-foreground">{recipe.note}</p>}
    </div>
  );
}

function NumberChip({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <p
        className={cn(
          "truncate font-mono text-sm font-semibold tabular-nums",
          highlight ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function ModeButton({
  active,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-xl border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary-tint-soft"
          : "border-border hover:border-primary/40 hover:bg-muted",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-full border",
            active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
          )}
        >
          {active && <Check className="size-2.5" />}
        </span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </button>
  );
}

function CodeRow({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Code copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — long-press to copy the code");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate font-mono text-base font-semibold tabular-nums text-foreground">
          {code}
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
        aria-label={`Copy ${label} code`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
