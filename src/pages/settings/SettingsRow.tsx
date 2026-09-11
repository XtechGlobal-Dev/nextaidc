import type { ComponentType, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  description?: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}

/** A single tappable row used in the Support Centre card. */
export function SettingsRow({
  icon: Icon,
  label,
  description,
  href,
  external,
  onClick,
  trailing,
}: SettingsRowProps) {
  const inner = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description && (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        )}
      </span>
      {trailing ?? <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );

  const className = cn(
    "flex h-full w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left transition-colors",
    "hover:border-primary/40 hover:bg-muted/50 focus-visible:focus-ring",
  );

  if (href) {
    return (
      <a
        href={href}
        className={className}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {inner}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}
