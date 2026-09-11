import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Mobile "table row → card" primitives. Below md, data tables render each row as
 * one of these cards: an avatar/icon-led header (with the row actions tucked in
 * the top-right), an optional pill row for status/type badges, and a 2-column
 * meta grid for the remaining fields. Matches the Customers list card design.
 */
export function DataCard({
  onClick,
  className,
  style,
  children,
}: {
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const interactive = !!onClick;
  return (
    <div
      style={style}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            },
          }
        : {})}
      className={cn(
        "rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-soft)]",
        interactive && "cursor-pointer transition-colors active:bg-primary-tint-soft",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Circular avatar (initials) used as the card lead. */
export function DataCardAvatar({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-tint text-sm font-semibold text-primary">
      {children}
    </span>
  );
}

export function DataCardHeader({
  lead,
  title,
  subtitle,
  actions,
}: {
  lead?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold leading-tight">{title}</div>
        {subtitle != null && subtitle !== "" && (
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        )}
      </div>
      {actions && (
        <div className="-mr-1 -mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Inline badge/pill row shown under the header. */
export function DataCardPills({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-wrap items-center gap-1.5">{children}</div>;
}

/** 2-column label/value grid for secondary fields. */
export function DataCardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/60 pt-3">
      {children}
    </div>
  );
}

/** Label + value stack for a single field inside DataCardGrid. */
export function CardField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 truncate text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}
