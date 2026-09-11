import * as React from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PADDING,
  areaPath,
  compactNumber,
  formatBucket,
  formatBucketFull,
  linePath,
  niceMax,
  seriesColor,
  ticks,
  xAt,
  yAt,
  type PlotArea,
} from "./primitives";

/* ------------------------------------------------------------------ *
 *  Chart kit — hand-rolled, themable, interactive SVG charts.
 *
 *  Every chart here follows the same rules:
 *   - one y-axis, never two;
 *   - recessive grid and axes, thin marks, so the data carries the eye;
 *   - a hover layer by default (crosshair + tooltip on time series, per-mark
 *     tooltip on bars) — a chart in a browser that can't be interrogated is
 *     throwing away the medium;
 *   - colour comes from CSS custom properties, so light/dark and any future
 *     rebrand happen in one place;
 *   - identity is never colour-alone: two or more series always ship a legend.
 * ------------------------------------------------------------------ */

/* ----------------------------- Tooltip ----------------------------- */

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}

function ChartTooltip({ state, width }: { state: TooltipState; width: number }) {
  // Flip the tooltip to the left of the cursor near the right edge so it never
  // spills out of the card.
  const flip = state.x > width * 0.6;
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 min-w-[8rem] rounded-lg border border-border bg-card px-2.5 py-2",
        "shadow-[var(--shadow-panel)]",
      )}
      style={{
        left: flip ? undefined : state.x + 12,
        right: flip ? width - state.x + 12 : undefined,
        top: Math.max(4, state.y - 12),
      }}
      role="tooltip"
    >
      <p className="text-[11px] font-medium text-muted-foreground">{state.title}</p>
      <ul className="mt-1 space-y-0.5">
        {state.rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {r.color && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="font-semibold tabular-nums text-foreground">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------- Empty state --------------------------- */

function ChartEmpty({ height, message }: { height: number; message: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground"
      style={{ height }}
    >
      {message}
    </div>
  );
}

/* ---------------------------- Sparkline ---------------------------- */

/**
 * A bare trend line for a card — no axes, no interaction, no legend. It answers
 * "which way is this going", nothing more; the number beside it carries the value.
 */
export function Sparkline({
  values,
  className,
  width = 96,
  height = 28,
  color = "var(--color-primary)",
  /** Fill under the line. Off for dense grids where it would muddy the row. */
  filled = true,
}: {
  values: number[];
  className?: string;
  width?: number;
  height?: number;
  color?: string;
  filled?: boolean;
}) {
  if (values.length < 2 || values.every((v) => v === 0)) {
    return (
      <svg width={width} height={height} className={className} aria-hidden="true">
        <line
          x1={0}
          y1={height - 2}
          x2={width}
          y2={height - 2}
          stroke="var(--color-chart-axis)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const area: PlotArea = { width, height, padding: { top: 2, right: 1, bottom: 2, left: 1 } };
  const max = niceMax(Math.max(...values));

  return (
    <svg width={width} height={height} className={className} aria-hidden="true" role="presentation">
      {filled && <path d={areaPath(values, max, area)} fill={color} opacity={0.12} />}
      <path
        d={linePath(values, max, area)}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------- Time series chart ----------------------- */

export interface TimeSeriesDef {
  key: string;
  label: string;
  values: number[];
  color: string;
  /** Draw a filled area under the line. Use for one series, not for a stack. */
  area?: boolean;
  /** Format a value for the tooltip and axis. */
  format?: (v: number) => string;
}

/**
 * Multi-series line/area chart over time with a shared crosshair.
 *
 * One y-scale for every series by design — two scales on one chart invite the
 * reader to compare shapes that have no common ground. If two measures don't
 * share a scale, they belong in two charts.
 */
export function TimeSeriesChart({
  labels,
  series,
  bucketSec,
  height = 200,
  className,
  emptyMessage = "No traffic recorded in this window",
  /** Axis/tooltip formatter for the shared y-scale. */
  format = compactNumber,
  yMax: yMaxProp,
}: {
  /** ISO bucket start per point — the x-axis. */
  labels: string[];
  series: TimeSeriesDef[];
  bucketSec: number;
  height?: number;
  className?: string;
  emptyMessage?: string;
  format?: (v: number) => string;
  yMax?: number;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(600);
  const [hover, setHover] = React.useState<number | null>(null);

  // Track the container so the chart is fluid without a resize library.
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasData = series.some((s) => s.values.some((v) => v > 0));
  const area: PlotArea = { width, height, padding: DEFAULT_PADDING };
  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const max = yMaxProp ?? niceMax(rawMax);
  const n = labels.length;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const inner = width - area.padding.left - area.padding.right;
    const ratio = (x - area.padding.left) / (inner || 1);
    const idx = Math.round(ratio * (n - 1));
    setHover(idx >= 0 && idx < n ? idx : null);
  };

  if (!hasData) {
    return (
      <div ref={wrapRef} className={className}>
        <ChartEmpty height={height} message={emptyMessage} />
      </div>
    );
  }

  const tooltip: TooltipState | null =
    hover !== null
      ? {
          x: xAt(hover, n, area),
          y: area.padding.top,
          title: formatBucketFull(labels[hover] ?? ""),
          rows: series.map((s) => ({
            label: s.label,
            value: (s.format ?? format)(s.values[hover] ?? 0),
            color: s.color,
          })),
        }
      : null;

  // A single series is named by the chart's own heading, so a legend box would
  // just repeat it. Two or more always get one — identity is never colour alone.
  const showLegend = series.length >= 2;
  const axisTicks = ticks(max, 4);

  return (
    <div className={className}>
      {showLegend && (
        <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${series.map((s) => s.label).join(", ")} over time`}
      >
        <svg width={width} height={height} className="block overflow-visible">
          {/* Gridlines + y ticks */}
          {axisTicks.map((t) => {
            const y = yAt(t, max, area);
            return (
              <g key={t}>
                <line
                  x1={area.padding.left}
                  y1={y}
                  x2={width - area.padding.right}
                  y2={y}
                  stroke="var(--color-chart-grid)"
                  strokeWidth={1}
                />
                <text
                  x={area.padding.left - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {format(t)}
                </text>
              </g>
            );
          })}

          {/* Series — areas beneath lines so a fill never hides a neighbour. */}
          {series.map((s) =>
            s.area ? <path key={`a-${s.key}`} d={areaPath(s.values, max, area)} fill={s.color} opacity={0.12} /> : null,
          )}
          {series.map((s) => (
            <path
              key={`l-${s.key}`}
              d={linePath(s.values, max, area)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Crosshair + markers. Markers are 8px so they're findable on a dense line. */}
          {hover !== null && (
            <g>
              <line
                x1={xAt(hover, n, area)}
                y1={area.padding.top}
                x2={xAt(hover, n, area)}
                y2={height - area.padding.bottom}
                stroke="var(--color-chart-axis)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {series.map((s) => (
                <circle
                  key={`m-${s.key}`}
                  cx={xAt(hover, n, area)}
                  cy={yAt(s.values[hover] ?? 0, max, area)}
                  r={4}
                  fill={s.color}
                  // A 2px surface ring keeps overlapping markers legible.
                  stroke="var(--color-card)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}

          {/* x labels — first, middle and last only; a label per bucket collides. */}
          {[0, Math.floor((n - 1) / 2), n - 1]
            .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
            .map((i) => (
              <text
                key={i}
                x={xAt(i, n, area)}
                y={height - 6}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                className="fill-muted-foreground text-[10px]"
              >
                {formatBucket(labels[i] ?? "", bucketSec)}
              </text>
            ))}
        </svg>
        {tooltip && <ChartTooltip state={tooltip} width={width} />}
      </div>
    </div>
  );
}

/* --------------------------- Bar chart ----------------------------- */

export interface BarDatum {
  label: string;
  value: number;
  /** Slot index into the categorical palette; omit for the single-series blue. */
  colorIndex?: number;
  /** Secondary line under the label in the tooltip. */
  hint?: string;
}

/**
 * Horizontal bars — the right form for ranking named things (cost per provider,
 * requests per endpoint), because the labels are text and text reads horizontally.
 *
 * Values are labelled directly at the end of every bar, which is also the relief
 * the palette's light-mode contrast requires.
 */
export function BarChart({
  data,
  format = compactNumber,
  className,
  emptyMessage = "Nothing to show yet",
  maxBars = 10,
}: {
  data: BarDatum[];
  format?: (v: number) => string;
  className?: string;
  emptyMessage?: string;
  maxBars?: number;
}) {
  const rows = data.slice(0, maxBars);
  const max = Math.max(1, ...rows.map((r) => r.value));

  if (rows.length === 0 || rows.every((r) => r.value === 0)) {
    return <ChartEmpty height={120} message={emptyMessage} />;
  }

  return (
    <ul className={cn("space-y-2.5", className)}>
      {rows.map((row, i) => (
        <li key={row.label} className="group">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium text-foreground" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">{format(row.value)}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${Math.max(2, (row.value / max) * 100)}%`,
                background: seriesColor(row.colorIndex ?? i),
              }}
            />
          </div>
          {row.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{row.hint}</p>}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------- Stacked bars --------------------------- */

/**
 * A single 100%-wide bar split into segments — the fleet's health mix, or a
 * category's. Segments carry a 2px surface gap so adjacent colours never touch.
 */
export function StackedBar({
  segments,
  className,
  height = 8,
}: {
  segments: { key: string; label: string; value: number; color: string }[];
  className?: string;
  height?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    return <div className={cn("w-full rounded-full bg-muted", className)} style={{ height }} />;
  }
  return (
    <div className={cn("flex w-full gap-0.5 overflow-hidden rounded-full", className)} style={{ height }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
    </div>
  );
}

/* ----------------------------- Donut ------------------------------- */

/**
 * Fleet health at a glance. A donut earns its place here — and almost nowhere
 * else — because the parts genuinely sum to a meaningful whole (every provider
 * is in exactly one state) and there are only ever four of them.
 */
export function Donut({
  segments,
  size = 132,
  thickness = 14,
  centerValue,
  centerLabel,
  className,
}: {
  segments: { key: string; label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerValue?: string;
  centerLabel?: string;
  className?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-muted)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const fraction = s.value / total;
              // A 2px gap between arcs, expressed in arc length.
              const dash = Math.max(0, circumference * fraction - 2);
              const el = (
                <circle
                  key={s.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="round"
                >
                  <title>{`${s.label}: ${s.value}`}</title>
                </circle>
              );
              offset += circumference * fraction;
              return el;
            })}
      </svg>
      {(centerValue || centerLabel) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {centerValue && <span className="text-2xl font-semibold tabular-nums">{centerValue}</span>}
          {centerLabel && <span className="text-[11px] text-muted-foreground">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}
