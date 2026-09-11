import type { ComponentType, ReactNode } from "react";
import { Check, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

interface LucideIconProps {
  className?: string;
}

export interface ProviderCardProps {
  icon: ComponentType<LucideIconProps>;
  name: string;
  description: string;
  selected?: boolean;
  /** Gated provider — muted, shows lock, not selectable. */
  gated?: boolean;
  /** Optional badge/eyebrow shown next to the name (e.g. "Premium"). */
  eyebrow?: string;
  /** Decorative art revealed in the card's right gutter once selected. */
  illustration?: ReactNode;
  /** Slot rendered at the bottom (e.g. a Contact Support button for gated cards). */
  footer?: ReactNode;
  onSelect?: () => void;
}

export function ProviderCard({
  icon: Icon,
  name,
  description,
  selected = false,
  gated = false,
  eyebrow,
  illustration,
  footer,
  onSelect,
}: ProviderCardProps) {
  const interactive = !gated;

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.();
              }
            }
          : undefined
      }
      className={cn(
        "relative flex h-full min-h-[168px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-card p-5 text-left transition-all sm:p-6",
        interactive &&
          "cursor-pointer hover:border-primary/40 hover:shadow-[var(--shadow-soft)] focus-visible:focus-ring",
        selected && "border-primary bg-primary-tint-soft shadow-[var(--shadow-soft)]",
        gated && "opacity-70",
      )}
    >
      {/* Selection state — filled tick when picked, empty ring otherwise. */}
      {gated ? (
        <span className="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Lock className="size-3.5" />
        </span>
      ) : selected ? (
        <span className="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-4" />
        </span>
      ) : (
        <span className="absolute right-4 top-4 size-6 rounded-full border-2 border-border" />
      )}

      <div className="flex flex-1 items-center gap-6 pr-8">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <span
            className={cn(
              "inline-flex size-12 items-center justify-center rounded-xl transition-colors",
              selected ? "bg-primary text-primary-foreground" : "bg-primary-tint text-primary",
            )}
          >
            <Icon className="size-6" />
          </span>

          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold leading-tight">{name}</h3>
              {eyebrow && (
                <span className="rounded-full bg-premium-tint px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-premium">
                  {eyebrow}
                </span>
              )}
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>

          {footer && <div className="mt-auto pt-1">{footer}</div>}
        </div>

        {selected && illustration}
      </div>
    </div>
  );
}
