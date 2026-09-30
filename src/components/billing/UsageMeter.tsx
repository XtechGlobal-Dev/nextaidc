import { AlertTriangle, CheckCircle2, OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";

// One monthly allowance: used vs cap, as a bar. Past 80% it turns warning, at the cap critical — always
// with an icon and words too, so the state never rests on colour alone.

export function UsageMeter({
  label,
  used,
  limit,
  unit,
  className,
}: {
  label: string;
  used: number;
  /** null = no cap: the count is shown, with no bar to fill. */
  limit: number | null;
  unit: string;
  className?: string;
}) {
  const pct = limit == null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const state = limit == null ? "none" : pct >= 100 ? "critical" : pct >= 80 ? "warning" : "ok";
  const fmt = (n: number) => n.toLocaleString();

  return (
    <div className={cn("rounded-xl border border-border p-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {limit == null ? "No limit" : `${Math.round(pct)}%`}
        </p>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {fmt(used)}
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          {limit == null ? unit : `/ ${fmt(limit)} ${unit}`}
        </span>
      </p>
      {limit != null && (
        <>
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(used, limit)}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                state === "critical" ? "bg-danger" : state === "warning" ? "bg-warning" : "bg-primary",
              )}
              style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }}
            />
          </div>
          <p
            className={cn(
              "mt-2 flex items-center gap-1.5 text-xs",
              // Amber is too light for text; the warning state keeps amber on the icon only.
              state === "critical" ? "text-danger" : state === "warning" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {state === "critical" ? (
              <OctagonX className="size-3.5" />
            ) : state === "warning" ? (
              <AlertTriangle className="size-3.5 text-warning" />
            ) : (
              <CheckCircle2 className="size-3.5" />
            )}
            {state === "critical"
              ? "Limit reached — paused until it resets"
              : state === "warning"
                ? `${fmt(Math.max(0, limit - used))} ${unit} left`
                : "Within limit"}
          </p>
        </>
      )}
    </div>
  );
}
