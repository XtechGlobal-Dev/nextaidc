import * as React from "react";
import { cn } from "@/lib/utils";

export function Separator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("h-px w-full bg-border", className)} {...props} />;
}

/** Thin progress bar (usage meters etc.). */
export function ProgressBar({
  value,
  className,
  barClassName,
}: {
  value: number; // 0..100
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full bg-primary transition-all", barClassName)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/** Small grey "Synced" / status pill with a colored dot. */
export function StatusPill({
  label,
  tone = "success",
  className,
}: {
  label: string;
  tone?: "success" | "primary" | "neutral" | "danger";
  className?: string;
}) {
  const dot = {
    success: "bg-success",
    primary: "bg-primary",
    neutral: "bg-muted-foreground",
    danger: "bg-danger",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium",
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", dot)} />
      {label}
    </span>
  );
}
