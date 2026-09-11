import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Minus,
  MinusCircle,
  Moon,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/Charts";
import { compactNumber, formatPct } from "@/components/charts/primitives";
import type { AuthStatus, HealthState, ProviderRow, StatusIndicator } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  The shared vocabulary of the API Center.
 *
 *  Health, auth and vendor-incident states are each rendered by exactly one
 *  component here, so "degraded" looks and reads identically on the Overview,
 *  in the drawer and on the Health screen.
 *
 *  Every state pairs a colour with an icon AND a word. Colour alone would fail
 *  anyone with a colour-vision deficiency, and these are precisely the states
 *  where being wrong matters most.
 * ------------------------------------------------------------------ */

/* ------------------------------ Health ----------------------------- */

interface HealthMeta {
  label: string;
  icon: LucideIcon;
  /** Text + icon colour. */
  fg: string;
  /** Tinted background for the pill. */
  bg: string;
  /** Solid colour for dots, charts and stacked bars. */
  solid: string;
  description: string;
}

export const HEALTH_META: Record<HealthState, HealthMeta> = {
  healthy: {
    label: "Healthy",
    icon: CheckCircle2,
    fg: "text-success",
    bg: "bg-success-tint",
    solid: "var(--color-success)",
    description: "Responding normally with no errors worth flagging.",
  },
  degraded: {
    label: "Warning",
    icon: AlertTriangle,
    fg: "text-warning",
    bg: "bg-warning-tint",
    solid: "var(--color-warning)",
    description: "Still working, but something needs attention.",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    fg: "text-danger",
    bg: "bg-danger-tint",
    solid: "var(--color-danger)",
    description: "Actively failing — calls to this provider are not succeeding.",
  },
  disconnected: {
    label: "Disconnected",
    icon: CircleSlash,
    fg: "text-danger",
    bg: "bg-danger-tint",
    solid: "var(--color-danger)",
    description: "The platform calls this provider but holds no credentials for it.",
  },
  idle: {
    label: "Idle",
    icon: Moon,
    fg: "text-muted-foreground",
    bg: "bg-muted",
    solid: "var(--color-muted-foreground)",
    description: "Connected and fine — it just hasn't been called in this window.",
  },
  not_configured: {
    label: "Not connected",
    icon: MinusCircle,
    fg: "text-muted-foreground",
    bg: "bg-muted",
    solid: "var(--color-border)",
    description: "Available to integrate, but this platform doesn't call it yet.",
  },
};

export function HealthPill({
  health,
  className,
  size = "sm",
}: {
  health: HealthState;
  className?: string;
  size?: "sm" | "xs";
}) {
  const meta = HEALTH_META[health];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        meta.bg,
        meta.fg,
        size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        className,
      )}
      title={meta.description}
    >
      <Icon className={size === "xs" ? "size-3" : "size-3.5"} />
      {meta.label}
    </span>
  );
}

/** A bare dot for dense rows where a pill would be too heavy. Always paired
 *  with the provider name and a `title`, never colour alone. */
export function HealthDot({ health, className }: { health: HealthState; className?: string }) {
  const meta = HEALTH_META[health];
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: meta.solid }}
      title={meta.label}
      aria-label={meta.label}
    />
  );
}

/* ------------------------------- Auth ------------------------------ */

export const AUTH_META: Record<AuthStatus, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { label: "Authenticated", tone: "ok" },
  missing: { label: "No credentials", tone: "bad" },
  expiring: { label: "Key expiring", tone: "warn" },
  expired: { label: "Key expired", tone: "bad" },
  failing: { label: "Auth failing", tone: "bad" },
};

export function AuthPill({ status, className }: { status: AuthStatus; className?: string }) {
  const meta = AUTH_META[status];
  const tone =
    meta.tone === "ok"
      ? "bg-success-tint text-success"
      : meta.tone === "warn"
        ? "bg-warning-tint text-warning"
        : "bg-danger-tint text-danger";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", tone, className)}>
      <ShieldAlert className="size-3" />
      {meta.label}
    </span>
  );
}

/* --------------------------- Environment --------------------------- */

/**
 * Marks a provider that is pointed at its vendor's SANDBOX rather than live.
 *
 * Renders nothing for production, on purpose. Production is the default and the
 * overwhelming majority, so a "PROD" chip on every row was pure noise — it
 * appeared 23 times and told you nothing. Sandbox is the exception worth
 * shouting about: mistaking test traffic for live traffic (or the reverse) is
 * the expensive direction of that error.
 */
export function EnvBadge({ environment, className }: { environment: string; className?: string }) {
  if (environment !== "sandbox") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-warning/40 bg-warning-tint px-1.5 py-px",
        "text-[10px] font-semibold uppercase tracking-wide text-warning",
        className,
      )}
      title="This provider is pointed at the vendor's sandbox, not live"
    >
      Sandbox
    </span>
  );
}

/* ------------------------- Vendor incidents ------------------------ */

export const INDICATOR_META: Record<StatusIndicator, { label: string; fg: string; solid: string }> = {
  none: { label: "Operational", fg: "text-success", solid: "var(--color-success)" },
  minor: { label: "Minor incident", fg: "text-warning", solid: "var(--color-warning)" },
  major: { label: "Major outage", fg: "text-danger", solid: "var(--color-danger)" },
  critical: { label: "Critical outage", fg: "text-danger", solid: "var(--color-danger)" },
  maintenance: { label: "Maintenance", fg: "text-primary", solid: "var(--color-primary)" },
  unknown: { label: "No status feed", fg: "text-muted-foreground", solid: "var(--color-muted-foreground)" },
};

export function IncidentPill({ indicator, className }: { indicator: StatusIndicator; className?: string }) {
  const meta = INDICATOR_META[indicator];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.fg, className)}>
      <span className="size-1.5 rounded-full" style={{ background: meta.solid }} />
      {meta.label}
    </span>
  );
}

/* ----------------------------- Provider ---------------------------- */

/** Monogram avatar. Vendor logos would mean bundling two dozen trademarked
 *  assets; initials on the category colour read just as fast in a grid. */
export function ProviderAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl bg-primary-tint text-xs font-bold text-primary",
        className,
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/* ---------------------------- Stat tile ---------------------------- */

/**
 * The KPI tile used across every section.
 *
 * The value is the hero; the sparkline is context, not decoration; the tone is
 * only ever set when a threshold has genuinely been crossed, so a coloured tile
 * always means something.
 */
export function MetricTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
  spark,
  sparkColor,
  delta,
  className,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "primary";
  icon?: LucideIcon;
  spark?: number[];
  sparkColor?: string;
  /** Percentage change vs the previous window; positive is not always good, so
   *  the caller says which direction is welcome. */
  delta?: { value: number; goodWhen: "up" | "down" };
  className?: string;
  onClick?: () => void;
}) {
  const toneClass = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    primary: "text-primary",
  }[tone];

  const deltaGood = delta ? (delta.goodWhen === "up" ? delta.value >= 0 : delta.value <= 0) : true;
  const DeltaIcon = delta ? (delta.value === 0 ? Minus : delta.value > 0 ? TrendingUp : TrendingDown) : null;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold leading-none tracking-tight tabular-nums", toneClass)}>
        {value}
      </p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
          {delta && DeltaIcon && (
            <p
              className={cn(
                "mt-0.5 flex items-center gap-1 text-[11px] font-medium tabular-nums",
                delta.value === 0 ? "text-muted-foreground" : deltaGood ? "text-success" : "text-danger",
              )}
            >
              <DeltaIcon className="size-3" />
              {Math.abs(delta.value).toFixed(1)}%
            </p>
          )}
        </div>
        {spark && spark.length > 1 && (
          <Sparkline values={spark} color={sparkColor ?? "var(--color-primary)"} width={72} height={24} />
        )}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded-[var(--radius-card)] border border-border bg-card p-4 text-left shadow-[var(--shadow-soft)]",
          "transition-colors hover:border-primary/40 hover:bg-primary-tint-soft focus-visible:focus-ring",
          className,
        )}
      >
        {body}
      </button>
    );
  }

  return <Card className={cn("p-4", className)}>{body}</Card>;
}

/* ---------------------------- Quota meter -------------------------- */

/**
 * Consumption against a configured ceiling.
 *
 * A provider with no quota set renders "Not set" rather than an empty 0% bar —
 * a full-looking meter and an unconfigured one must never look the same.
 */
export function QuotaMeter({
  used,
  quota,
  pct,
  warnPct = 80,
  failPct = 95,
  className,
  compact = false,
}: {
  used: number;
  quota: number;
  pct: number | null;
  warnPct?: number;
  failPct?: number;
  className?: string;
  compact?: boolean;
}) {
  if (pct === null || quota <= 0) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>
        <span className="tabular-nums">{compactNumber(used)}</span> used · no quota set
      </div>
    );
  }

  const tone = pct >= failPct ? "bg-danger" : pct >= warnPct ? "bg-warning" : "bg-primary";
  const textTone = pct >= failPct ? "text-danger" : pct >= warnPct ? "text-warning" : "text-foreground";

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground tabular-nums">
          {compactNumber(used)} / {compactNumber(quota)}
        </span>
        <span className={cn("font-semibold tabular-nums", textTone)}>{formatPct(pct)}</span>
      </div>
      <div className={cn("mt-1 w-full overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-2")}>
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

/* -------------------------- View switcher -------------------------- */

/**
 * The segmented control that replaced eight of the old tabs.
 *
 * Switching a view swaps which columns or which chart you're looking at — it
 * never changes the data behind it. That's the whole reason the merge works:
 * "status vs quota" was never a different screen, only a different question
 * about the same rows.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string; icon?: LucideIcon }[];
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
      role="group"
      aria-label={label}
    >
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={value === o.key}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md font-semibold transition-colors",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]",
              value === o.key
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------- Summary bar --------------------------- */

/**
 * The fleet in one line.
 *
 * Replaces the four-tile KPI grid the Overview used to open with. Four tiles
 * read as four things to think about; one strip reads as one sentence, which is
 * what "is everything OK?" deserves as an answer.
 */
export function SummaryBar({
  stats,
  className,
}: {
  stats: { label: string; value: React.ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }[];
  className?: string;
}) {
  const toneClass = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };
  return (
    <Card className={cn("flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4", className)}>
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{s.label}</p>
          <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", toneClass[s.tone ?? "neutral"])}>
            {s.value}
          </p>
        </div>
      ))}
    </Card>
  );
}

/* ---------------------------- Empty state -------------------------- */

export function ApiCenterEmpty({
  icon: Icon,
  title,
  message,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col items-center justify-center gap-2 px-6 py-14 text-center", className)}>
      <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}

/* --------------------------- Section header ------------------------ */

export function SectionHeading({
  title,
  hint,
  actions,
  className,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-end justify-between gap-2", className)}>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------------------- Cost caveat -------------------------- */

/**
 * Cost confidence, stated inline wherever a dollar figure appears.
 *
 * These numbers are `units x list price`, not invoices. Saying so next to the
 * figure is the difference between a useful estimate and a number someone
 * budgets against and is then wrong about.
 */
export function CostConfidenceNote({
  confidence,
  className,
}: {
  confidence: ProviderRow["costConfidence"];
  className?: string;
}) {
  const text = {
    metered: "Measured from real usage units.",
    estimated: "Estimated from call count x list price.",
    none: "No price configured for this provider.",
  }[confidence];
  return <p className={cn("text-[11px] text-muted-foreground", className)}>{text}</p>;
}
