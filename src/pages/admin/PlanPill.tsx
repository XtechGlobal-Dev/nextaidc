import { Badge } from "@/components/ui/badge";

// Give each plan a stable, distinct colour so different tiers (Starter, Silver,
// Gold…) are tellable at a glance instead of one uniform amber. Shared between
// the customers table and the customer detail page so a plan looks identical in
// both places.
const PLAN_COLORS = [
  "var(--color-step-1)", // blue
  "var(--color-step-2)", // violet
  "var(--color-step-3)", // green
  "var(--color-premium)", // gold
  "var(--color-step-5)", // sky
  "var(--color-danger)", // red
];

export function planColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PLAN_COLORS[h % PLAN_COLORS.length];
}

/** Plan tier chip — coloured per tier, or a neutral "Free" badge when there's no plan. */
export function PlanPill({ name }: { name: string | null }) {
  if (!name) return <Badge variant="neutral">Free</Badge>;
  const color = planColor(name);
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {name}
    </span>
  );
}
