import { cn } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/misc";
import { useTrialStore } from "@/stores/useTrialStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { daysBadge, minutesBadge, TONE_FILL, TONE_TEXT } from "@/lib/trial";
import { isAdminRole } from "@/lib/roles";

/**
 * Minutes meter for the sidebar — "Trial Minutes 0.3 / 10" (trial) or
 * "Plan Minutes 12 / 200" (paid), with a colored bar. Shows "Unlimited" for
 * plans with no minute cap. Hidden when the user has no entitlement.
 */
export function TrialMinutesMeter({ className }: { className?: string }) {
  const trial = useTrialStore((s) => s.trial);
  const isAdmin = useAuthStore((s) => isAdminRole(s.user?.role));
  // Admins manage the platform and aren't on a trial/plan — no minute meter.
  if (isAdmin) return null;
  if (!trial || (trial.phase !== "trial" && trial.phase !== "active")) return null;

  const label = trial.phase === "trial" ? "Trial Minutes" : "Plan Minutes";

  if (trial.unlimited) {
    return (
      <div className={className}>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
          {label}
          {trial.planName && (
            <span className="rounded-full bg-primary-tint px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {trial.planName}
            </span>
          )}
        </span>
          <span className="font-semibold text-success">Unlimited</span>
        </div>
      </div>
    );
  }

  const { tone } = minutesBadge(trial.minutesRemaining, trial.minutesAllocated);
  const used = Math.round(trial.minutesUsed * 10) / 10;
  const pct =
    trial.minutesAllocated > 0 ? (trial.minutesUsed / trial.minutesAllocated) * 100 : 0;

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {label}
          {trial.planName && (
            <span className="rounded-full bg-primary-tint px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {trial.planName}
            </span>
          )}
        </span>
        <span className="font-semibold tabular-nums">
          {used} / {trial.minutesAllocated}
        </span>
      </div>
      <ProgressBar className="mt-1.5" value={Math.min(pct, 100)} barClassName={TONE_FILL[tone]} />
    </div>
  );
}

/**
 * Top-right status "bulb". During the trial it's a pulsing days-remaining
 * countdown that recolors and reads "Trial Expired" when it ends. On a paid
 * plan it shows a calm "Renews in Nd" pill. Hidden otherwise.
 */
export function TrialDaysIndicator({ className }: { className?: string }) {
  const trial = useTrialStore((s) => s.trial);
  const isAdmin = useAuthStore((s) => isAdminRole(s.user?.role));
  // Admins aren't on a trial/plan — hide the "N Days Trial Left" / renewal pill.
  if (isAdmin) return null;
  if (!trial) return null;

  if (trial.phase === "trial") {
    const { text, tone } = daysBadge(trial.daysRemaining, trial.blocked);
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur",
          TONE_TEXT[tone],
          className,
        )}
      >
        <span className="relative flex size-2.5">
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              TONE_FILL[tone],
            )}
          />
          <span className={cn("relative inline-flex size-2.5 rounded-full", TONE_FILL[tone])} />
        </span>
        {text}
      </div>
    );
  }

  if (trial.phase === "active" && !trial.blocked && trial.daysRemaining > 0) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur",
          className,
        )}
      >
        <span className="size-2 rounded-full bg-success" />
        Renews in {trial.daysRemaining}d
      </div>
    );
  }

  return null;
}
