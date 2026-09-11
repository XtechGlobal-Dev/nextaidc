import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 *  DateRangePicker — a self-contained dual-month calendar range
 *  picker. Works purely in `yyyy-mm-dd` strings (timezone-safe) so it
 *  drops straight into the dashboard's existing custom-range state.
 * ------------------------------------------------------------------ */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Local date at noon (avoids DST / tz off-by-one when comparing days). */
function fromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function label(s: string): string {
  const d = fromYmd(s);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
}
function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
/** 42-cell (6×7) grid for the month containing `view`, starting Sunday. */
function monthCells(view: Date): Date[] {
  const first = new Date(view.getFullYear(), view.getMonth(), 1, 12);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function DateRangePicker({
  start,
  end,
  max,
  onChange,
  className,
}: {
  start: string; // yyyy-mm-dd
  end: string; // yyyy-mm-dd
  max: string; // yyyy-mm-dd — latest selectable day
  onChange: (start: string, end: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => fromYmd(start));
  // Pending selection while picking; null end = mid-selection.
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const maxDate = useMemo(() => fromYmd(max), [max]);

  // Reset internal view/selection whenever opened.
  useEffect(() => {
    if (open) {
      setView(fromYmd(start));
      setPendingStart(null);
      setHover(null);
    }
  }, [open, start]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The active [lo, hi] range to paint: committed range, or in-progress.
  const lo = pendingStart ?? start;
  const hi = pendingStart ? (hover ?? pendingStart) : end;
  const [rangeLo, rangeHi] = lo <= hi ? [lo, hi] : [hi, lo];

  function pick(dayStr: string) {
    if (!pendingStart) {
      // Begin a new range.
      setPendingStart(dayStr);
      return;
    }
    // Complete the range (order-independent).
    const [a, b] = dayStr < pendingStart ? [dayStr, pendingStart] : [pendingStart, dayStr];
    onChange(a, b);
    setPendingStart(null);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium shadow-sm transition-colors hover:bg-muted",
          open && "border-primary/50 ring-2 ring-primary/15",
        )}
      >
        <CalendarDays className="size-4 text-muted-foreground" />
        <span className="tabular-nums">
          {label(start)} <span className="text-muted-foreground">–</span> {label(end)}
        </span>
      </button>

      {open && (
        <div className="animate-in absolute right-0 top-[calc(100%+8px)] z-50 max-w-[calc(100vw-1.5rem)] overflow-x-auto rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
          <div className="flex items-start gap-6">
            <button
              type="button"
              onClick={() => setView((v) => addMonths(v, -1))}
              className="mt-0.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </button>

            <Month
              view={view}
              rangeLo={rangeLo}
              rangeHi={rangeHi}
              endpointA={pendingStart ?? start}
              endpointB={pendingStart ? (hover ?? pendingStart) : end}
              maxDate={maxDate}
              onPick={pick}
              onHover={setHover}
            />
            <Month
              view={addMonths(view, 1)}
              rangeLo={rangeLo}
              rangeHi={rangeHi}
              endpointA={pendingStart ?? start}
              endpointB={pendingStart ? (hover ?? pendingStart) : end}
              maxDate={maxDate}
              onPick={pick}
              onHover={setHover}
            />

            <button
              type="button"
              onClick={() => setView((v) => addMonths(v, 1))}
              className="mt-0.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Month({
  view,
  rangeLo,
  rangeHi,
  endpointA,
  endpointB,
  maxDate,
  onPick,
  onHover,
}: {
  view: Date;
  rangeLo: string;
  rangeHi: string;
  endpointA: string;
  endpointB: string;
  maxDate: Date;
  onPick: (s: string) => void;
  onHover: (s: string | null) => void;
}) {
  const cells = monthCells(view);
  return (
    <div className="w-[230px]">
      <div className="mb-2 text-center text-sm font-semibold">
        {MONTH_NAMES[view.getMonth()]} {view.getFullYear()}
      </div>
      <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">
        {DOW.map((d) => (
          <span key={d} className="py-1">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((d, i) => {
          const ymd = toYmd(d);
          const inMonth = sameMonth(d, view);
          const disabled = d > maxDate;
          const isLo = ymd === rangeLo;
          const isHi = ymd === rangeHi;
          const isEndpoint = ymd === endpointA || ymd === endpointB;
          const inRange = ymd > rangeLo && ymd < rangeHi;
          const hasRange = rangeLo !== rangeHi;

          return (
            <div
              key={i}
              className={cn(
                "relative flex h-8 items-center justify-center",
                // continuous range background band
                inRange && hasRange && "bg-primary-tint",
                isLo && hasRange && "rounded-l-full bg-primary-tint",
                isHi && hasRange && "rounded-r-full bg-primary-tint",
              )}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && onPick(ymd)}
                onMouseEnter={() => !disabled && onHover(ymd)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-sm transition-colors",
                  !inMonth && "text-muted-foreground/40",
                  inMonth && !disabled && "text-foreground hover:bg-primary/15",
                  disabled && "cursor-not-allowed text-muted-foreground/30",
                  isEndpoint && "bg-primary font-semibold text-white hover:bg-primary",
                )}
              >
                {d.getDate()}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
