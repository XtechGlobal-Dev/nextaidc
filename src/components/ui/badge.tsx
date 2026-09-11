import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground",
        primary: "bg-primary-tint text-primary",
        success: "bg-success-tint text-success",
        danger: "bg-danger-tint text-danger",
        warning: "bg-warning-tint text-warning",
        premium: "bg-premium-tint text-premium",
        outline: "border border-border text-foreground",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Small amber "PLAN" badge used to mark premium-gated features. */
export function PlanBadge({ className }: { className?: string }) {
  return (
    <Badge variant="premium" className={cn("uppercase tracking-wide", className)}>
      Plan
    </Badge>
  );
}
