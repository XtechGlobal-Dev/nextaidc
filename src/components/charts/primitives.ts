/* ------------------------------------------------------------------ *
 *  Shared geometry + formatting for the chart kit.
 *
 *  The charts are hand-rolled SVG rather than a charting library: they render a
 *  handful of shapes, need to follow the app's CSS custom properties in both
 *  themes, and live on an admin screen where a 100kB dependency for six sparklines
 *  would be the single heaviest thing on the page.
 * ------------------------------------------------------------------ */

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_PADDING: Padding = { top: 12, right: 12, bottom: 22, left: 40 };

/** The categorical series slots, in fixed order. Never cycle past the end —
 *  fold the tail into "Other" instead (see {@link topNWithOther}). */
export const SERIES_VARS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
] as const;

export const OTHER_COLOR = "var(--color-muted-foreground)";

/** Colour for series slot `i`; anything past the last slot is "Other" grey. */
export function seriesColor(i: number): string {
  return SERIES_VARS[i] ?? OTHER_COLOR;
}

/**
 * Keep the largest `n` items and roll the rest into a single "Other" row.
 * A ninth series is never a generated hue — past the palette we stop colouring
 * and start aggregating.
 */
export function topNWithOther<T extends { value: number }>(
  items: T[],
  n: number,
  makeOther: (value: number, count: number) => T,
): T[] {
  if (items.length <= n) return [...items].sort((a, b) => b.value - a.value);
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const rest = tail.reduce((s, i) => s + i.value, 0);
  return rest > 0 ? [...head, makeOther(rest, tail.length)] : head;
}

/* ---------------------------- Scales ------------------------------- */

/**
 * A "nice" upper bound for a y-axis — the next 1/2/5×10ⁿ above the data.
 * Keeps gridlines on round numbers so the axis reads without arithmetic.
 */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const pow = Math.pow(10, exp);
  const frac = max / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * pow;
}

/** Evenly spaced tick values from 0 to `max` inclusive. */
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

/* --------------------------- Path building -------------------------- */

export interface PlotArea {
  width: number;
  height: number;
  padding: Padding;
}

/** x pixel for point `i` of `n`, spread across the inner plot width. */
export function xAt(i: number, n: number, area: PlotArea): number {
  const inner = area.width - area.padding.left - area.padding.right;
  if (n <= 1) return area.padding.left + inner / 2;
  return area.padding.left + (inner * i) / (n - 1);
}

/** y pixel for `value` against `max`. */
export function yAt(value: number, max: number, area: PlotArea): number {
  const inner = area.height - area.padding.top - area.padding.bottom;
  if (max <= 0) return area.padding.top + inner;
  const clamped = Math.max(0, Math.min(value, max));
  return area.padding.top + inner - (inner * clamped) / max;
}

/** Polyline path through every value. */
export function linePath(values: number[], max: number, area: PlotArea): string {
  if (values.length === 0) return "";
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i, values.length, area).toFixed(2)},${yAt(v, max, area).toFixed(2)}`)
    .join(" ");
}

/** The same path, closed down to the baseline — the fill under a line. */
export function areaPath(values: number[], max: number, area: PlotArea): string {
  if (values.length === 0) return "";
  const baseline = area.height - area.padding.bottom;
  const first = xAt(0, values.length, area);
  const last = xAt(values.length - 1, values.length, area);
  return `${linePath(values, max, area)} L${last.toFixed(2)},${baseline} L${first.toFixed(2)},${baseline} Z`;
}

/* --------------------------- Formatting ---------------------------- */

/** 1234 → "1.2k". Keeps dense axes and stat tiles readable. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Milliseconds as the shortest honest unit. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * USD, with enough precision to be useful at API prices.
 *
 * Sub-cent totals are real here — a day of cheap calls genuinely costs $0.0043 —
 * and rounding those to "$0.00" reads as "free", which is the one thing a cost
 * screen must never imply.
 */
export function formatUsd(usd: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (opts.compact && Math.abs(usd) >= 1000) return `$${compactNumber(usd)}`;
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Percent with one decimal only when it earns it. */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

/**
 * Axis label for a bucket timestamp. The bucket width decides the format:
 * showing a date on an hourly chart, or a clock time on a 30-day chart, is
 * noise either way.
 */
export function formatBucket(iso: string, bucketSec: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (bucketSec >= 86_400) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucketSec >= 3_600) return d.toLocaleString(undefined, { weekday: "short", hour: "numeric" });
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Full timestamp for tooltips, where precision is wanted. */
export function formatBucketFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3m ago" / "2h ago" / "just now" — relative age of an ISO timestamp. */
export function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
