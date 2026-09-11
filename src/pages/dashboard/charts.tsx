import { useId } from "react";

/* ------------------------------------------------------------------ *
 *  Hand-written inline-SVG chart primitives for the Dashboard.
 *  No chart library — every visual is a plain <svg>, with gradient
 *  fills, smooth curves and rounded caps for a modern look.
 * ------------------------------------------------------------------ */

export const CHART_COLORS = {
  primary: "#2C76ED",
  success: "#10B981",
  danger: "#F43F5E",
  warning: "#F59E0B",
  grey: "#E8ECF3",
} as const;

/* ------------------------------------------------------------------ *
 *  BarChart — compares a small series of values (current vs previous).
 * ------------------------------------------------------------------ */
export interface BarDatum {
  label: string;
  value: number;
  color?: string;
}

export function BarChart({
  data,
  height = 72,
  className,
}: {
  data: BarDatum[];
  height?: number;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const width = 140;
  const max = Math.max(1, ...data.map((d) => d.value));
  const gap = 12;
  const barW = (width - gap * (data.length - 1)) / data.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      width="100%"
      height={height}
      role="img"
      aria-label="Bar chart"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`bar-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity="0.95" />
          <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {data.map((d, i) => {
        const h = Math.max(3, (d.value / max) * (height - 8));
        const x = i * (barW + gap);
        const y = height - h;
        const isGrey = d.color === CHART_COLORS.grey;
        return (
          <rect
            key={d.label}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={5}
            fill={isGrey ? CHART_COLORS.grey : d.color ? d.color : `url(#bar-${uid})`}
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 *  DonutChart — proportional ring made of stroked arcs.
 * ------------------------------------------------------------------ */
export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  segments,
  size = 96,
  thickness = 12,
  centerLabel,
  centerSub,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;

  let offset = 0;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Donut chart">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke={CHART_COLORS.grey} strokeWidth={thickness} />
        {segments.map((s) => {
          const fraction = s.value / total;
          const dash = fraction * circumference;
          const seg = (
            <circle
              key={s.label}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${Math.max(0, dash - 1.5)} ${circumference - dash + 1.5}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: "stroke-dasharray 0.6s cubic-bezier(0.22,1,0.36,1)" }}
            />
          );
          offset += dash;
          return seg;
        })}
      </svg>
      {(centerLabel || centerSub) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {centerLabel && (
            <span className="text-lg font-bold leading-none tracking-tight">{centerLabel}</span>
          )}
          {centerSub && <span className="mt-0.5 text-[10px] text-muted-foreground">{centerSub}</span>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Sparkline — a tiny smooth line for trends, with gradient area fill.
 * ------------------------------------------------------------------ */
export function Sparkline({
  values,
  color = CHART_COLORS.primary,
  height = 36,
  fill = true,
  className,
}: {
  values: number[];
  color?: string;
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const width = 140;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const points = values.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 6) - 3;
    return [x, y] as const;
  });

  // Smooth the line with a simple Catmull-Rom → bezier conversion.
  const line = smoothPath(points);
  const last = points[points.length - 1];
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      width="100%"
      height={height}
      role="img"
      aria-label="Sparkline"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`spark-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#spark-${uid})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* end-point dot */}
      <circle cx={last[0]} cy={last[1]} r={2.75} fill={color} />
      <circle cx={last[0]} cy={last[1]} r={5} fill={color} opacity={0.18} />
    </svg>
  );
}

/** Monotone cubic spline (Fritsch–Carlson) → cubic-bezier path. Unlike
 *  Catmull-Rom it never overshoots the data: flat stretches stay flat and
 *  the curve never dips below/above the actual points, so a zero baseline
 *  next to a peak doesn't produce a fake dip under the axis. */
function smoothPath(pts: readonly (readonly [number, number])[]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length;

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
    slope.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1e-6));
  }

  // Point tangents, clamped so each segment stays monotone (no overshoot).
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  m.push(slope[n - 2]);

  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3;
    const c1x = pts[i][0] + third;
    const c1y = pts[i][1] + m[i] * third;
    const c2x = pts[i + 1][0] - third;
    const c2y = pts[i + 1][1] - m[i + 1] * third;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/* ------------------------------------------------------------------ *
 *  HourBars — bars indexed by hour-of-day for the "Peak time" card.
 * ------------------------------------------------------------------ */
export function HourBars({
  values,
  peakIndex,
  height = 44,
  className,
}: {
  values: number[];
  peakIndex: number;
  height?: number;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const width = 140;
  const max = Math.max(1, ...values);
  const gap = 3;
  const barW = (width - gap * (values.length - 1)) / values.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      width="100%"
      height={height}
      role="img"
      aria-label="Calls by hour"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`hb-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity="1" />
          <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {values.map((v, i) => {
        const h = Math.max(3, (v / max) * (height - 2));
        const x = i * (barW + gap);
        const y = height - h;
        const peak = i === peakIndex;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={2.5}
            fill={peak ? `url(#hb-${uid})` : CHART_COLORS.grey}
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 *  RadialGauge — single-value ring (success-rate style).
 * ------------------------------------------------------------------ */
export function RadialGauge({
  percent,
  size = 96,
  thickness = 12,
  color = CHART_COLORS.success,
}: {
  percent: number; // 0..100
  size?: number;
  thickness?: number;
  color?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = (clamped / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Radial gauge">
        <defs>
          <linearGradient id={`gauge-${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={color} stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke={CHART_COLORS.grey} strokeWidth={thickness} />
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={`url(#gauge-${uid})`}
          strokeWidth={thickness}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dasharray 0.7s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg font-bold tracking-tight">{Math.round(clamped)}%</span>
      </div>
    </div>
  );
}
