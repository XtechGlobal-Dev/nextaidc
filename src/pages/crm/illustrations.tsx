import type { ComponentType } from "react";

interface IconProps {
  className?: string;
}

/**
 * Decorative "lead flows into your CRM" art shown on the selected provider card:
 * a dotted source node, a dashed hop, and a little app window holding the
 * provider's icon. Purely ornamental — hidden on small screens.
 */
export function ProviderFlowArt({ icon: Icon }: { icon: ComponentType<IconProps> }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none relative hidden h-[104px] w-[188px] shrink-0 select-none lg:block"
    >
      <svg
        viewBox="0 0 188 104"
        fill="none"
        className="absolute inset-0 size-full text-primary"
      >
        <circle
          cx="32"
          cy="54"
          r="19"
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeDasharray="4 5"
        />
        <path
          d="M56 54c15-16 25 15 40 0"
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="5 6"
        />
        <path d="m100 54-9-5v10z" fill="currentColor" fillOpacity="0.4" />
      </svg>

      {/* App window */}
      <div className="absolute right-0 top-3 w-[92px] overflow-hidden rounded-xl border border-primary/20 bg-card shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-1 bg-primary-tint-soft px-2 py-1.5">
          <span className="size-1.5 rounded-full bg-primary/40" />
          <span className="size-1.5 rounded-full bg-primary/25" />
          <span className="size-1.5 rounded-full bg-primary/25" />
        </div>
        <div className="grid h-[56px] place-items-center">
          <Icon className="size-6 text-primary" />
        </div>
      </div>
    </div>
  );
}

/** Illustrated placeholder for an empty list/table. */
export function EmptyArt({ icon: Icon }: { icon: ComponentType<IconProps> }) {
  return (
    <span
      aria-hidden
      className="relative grid size-14 shrink-0 place-items-center rounded-2xl bg-primary-tint-soft"
    >
      <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary/25" />
      <Icon className="size-6 text-primary/70" />
    </span>
  );
}
