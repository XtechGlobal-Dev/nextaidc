import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import type { Appointment } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  addDays,
  addMonths,
  monthGrid,
  startOfWeek,
  WEEKDAY_LABELS,
  ymd,
  zonedFull,
  zonedTime,
  zonedYmd,
  zonedWallToUtcISO,
} from "./dateUtils";

type View = "month" | "week" | "day";
type StatusFilter = "confirmed" | "cancelled" | "all";

export function CalendarTab({ timezone }: { timezone: string }) {
  const tz = timezone || "UTC";
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [status, setStatus] = useState<StatusFilter>("confirmed");
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [adding, setAdding] = useState(false);

  // The [from,to] window to fetch, derived from the current view + cursor.
  const window = useMemo(() => {
    if (view === "month") {
      const grid = monthGrid(cursor);
      return { from: grid[0], to: addDays(grid[41], 1) };
    }
    if (view === "week") {
      const start = startOfWeek(cursor);
      return { from: start, to: addDays(start, 7) };
    }
    const day = new Date(cursor);
    day.setHours(0, 0, 0, 0);
    return { from: day, to: addDays(day, 1) };
  }, [view, cursor]);

  const load = useCallback(() => {
    setLoading(true);
    return api.booking
      .appointments({
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        status: status === "all" ? undefined : status,
      })
      .then((r) => setAppts(r.appointments))
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setInitialLoad(false);
      });
  }, [window, status]);

  useEffect(() => {
    load();
  }, [load]);

  // Manual sync — re-pull bookings from the server (source of truth for the AI's
  // live bookings + Google writes). Confirms when the refresh completes.
  const sync = () => {
    void load().then(() => toast.success("Calendar synced"));
  };

  // Group appointments by their owner-timezone calendar day.
  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const a of appts) {
      const key = zonedYmd(a.startAt, tz);
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((x, y) => x.startAt.localeCompare(y.startAt));
    return map;
  }, [appts, tz]);

  const step = (dir: number) =>
    setCursor((c) => (view === "month" ? addMonths(c, dir) : addDays(c, view === "week" ? 7 * dir : dir)));

  const heading = useMemo(() => {
    const opts: Intl.DateTimeFormatOptions =
      view === "month"
        ? { month: "long", year: "numeric" }
        : view === "day"
          ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
          : { day: "numeric", month: "short", year: "numeric" };
    if (view === "week") {
      const s = startOfWeek(cursor);
      const e = addDays(s, 6);
      return `${s.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${e.toLocaleDateString(undefined, opts)}`;
    }
    return cursor.toLocaleDateString(undefined, opts);
  }, [view, cursor]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="card-glass flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border p-3 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2">
          <div className="flex h-9 items-center overflow-hidden rounded-lg border border-border bg-background">
            <button
              onClick={() => step(-1)}
              className="grid h-full w-9 place-items-center text-muted-foreground transition-colors hover:bg-muted"
              aria-label="Previous"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={() => setCursor(new Date())}
              className="h-full border-x border-border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              Today
            </button>
            <button
              onClick={() => step(1)}
              className="grid h-full w-9 place-items-center text-muted-foreground transition-colors hover:bg-muted"
              aria-label="Next"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <span className="text-base font-semibold">{heading}</span>
          {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 items-center rounded-lg bg-muted p-1">
            {(["month", "week", "day"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn(
                  "h-full rounded-md px-3 text-xs font-medium capitalize transition-colors",
                  view === v
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger aria-label="Filter bookings by status" className="h-9 w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={sync}
            disabled={loading}
            className="h-9 gap-1.5"
            title="Refresh bookings"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Sync
          </Button>
          <Button size="sm" onClick={() => setAdding(true)} className="h-9 gap-1.5">
            <Plus className="size-4" /> Add
          </Button>
        </div>
      </div>

      {/* Views */}
      {initialLoad ? (
        <CalendarSkeleton />
      ) : (
        <>
          {view === "month" && <MonthView cursor={cursor} byDay={byDay} tz={tz} onPick={setSelected} />}
          {view === "week" && <WeekView cursor={cursor} byDay={byDay} tz={tz} onPick={setSelected} />}
          {view === "day" && <DayView cursor={cursor} byDay={byDay} tz={tz} onPick={setSelected} />}
        </>
      )}

      {selected && (
        <ApptDialog
          appt={selected}
          tz={tz}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            load();
          }}
        />
      )}
      {adding && (
        <AddDialog
          tz={tz}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/* ---------------- Views ---------------- */

function CalendarSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-muted/50">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="p-2 text-center">
            <Skeleton className="mx-auto h-3.5 w-8" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: 42 }).map((_, i) => (
          <div key={i} className="min-h-[92px] space-y-1.5 border-b border-r border-border p-2 last:border-r-0">
            <Skeleton className="size-5 rounded-full" />
            {i % 5 === 0 && <Skeleton className="h-4 w-full" />}
            {i % 7 === 3 && <Skeleton className="h-4 w-3/4" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApptChip({ appt, tz, onPick }: { appt: Appointment; tz: string; onPick: (a: Appointment) => void }) {
  return (
    <button
      onClick={() => onPick(appt)}
      className={cn(
        "block w-full truncate rounded-md border-l-2 px-1.5 py-1 text-left text-[11px] font-medium leading-tight transition-colors",
        appt.status === "cancelled"
          ? "border-l-muted-foreground/40 bg-muted text-muted-foreground line-through"
          : "border-l-primary bg-primary-tint text-primary hover:bg-primary hover:text-primary-foreground",
      )}
    >
      {zonedTime(appt.startAt, tz)} {appt.customerName || "Customer"}
    </button>
  );
}

function MonthView({
  cursor,
  byDay,
  tz,
  onPick,
}: {
  cursor: Date;
  byDay: Map<string, Appointment[]>;
  tz: string;
  onPick: (a: Appointment) => void;
}) {
  const grid = monthGrid(cursor);
  const month = cursor.getMonth();
  const todayKey = ymd(new Date());
  return (
    <div className="animate-rise card-glass overflow-hidden rounded-[var(--radius-card)] border border-border shadow-[var(--shadow-soft)]">
      <div className="grid grid-cols-7 border-b border-border bg-muted/40">
        {WEEKDAY_LABELS.map((d) => (
          <div
            key={d}
            className="py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((day, i) => {
          const key = ymd(day);
          const dayAppts = byDay.get(key) ?? [];
          const inMonth = day.getMonth() === month;
          const isToday = key === todayKey;
          const weekend = day.getDay() === 0 || day.getDay() === 6;
          return (
            <div
              key={key}
              className={cn(
                "min-h-[104px] border-border/70 p-1.5 transition-colors",
                // Hairlines only between cells — no ragged outer edge.
                i % 7 !== 6 && "border-r",
                i < 35 && "border-b",
                weekend && "bg-muted/20",
                !inMonth && "bg-muted/40",
                isToday && "bg-primary-tint-soft",
                "hover:bg-primary-tint/30",
              )}
            >
              <div
                className={cn(
                  "mb-1.5 flex size-6 items-center justify-center rounded-full text-xs font-medium",
                  isToday
                    ? "bg-primary font-bold text-primary-foreground shadow-[0_4px_10px_-4px_hsl(217_84%_55%/0.9)]"
                    : "text-muted-foreground",
                  !inMonth && !isToday && "opacity-45",
                )}
              >
                {day.getDate()}
              </div>
              <div className="space-y-1">
                {dayAppts.slice(0, 3).map((a) => (
                  <ApptChip key={a.id} appt={a} tz={tz} onPick={onPick} />
                ))}
                {dayAppts.length > 3 && (
                  <p className="px-1 text-[10px] font-medium text-muted-foreground">
                    +{dayAppts.length - 3} more
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  cursor,
  byDay,
  tz,
  onPick,
}: {
  cursor: Date;
  byDay: Map<string, Appointment[]>;
  tz: string;
  onPick: (a: Appointment) => void;
}) {
  const start = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayKey = ymd(new Date());
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
      {days.map((day) => {
        const key = ymd(day);
        const dayAppts = byDay.get(key) ?? [];
        return (
          <div key={key} className="rounded-xl border border-border p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full text-xs",
                  key === todayKey ? "bg-primary font-semibold text-primary-foreground" : "text-foreground",
                )}
              >
                {day.getDate()}
              </span>
            </div>
            <div className="space-y-1">
              {dayAppts.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">—</p>
              ) : (
                dayAppts.map((a) => <ApptChip key={a.id} appt={a} tz={tz} onPick={onPick} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayView({
  cursor,
  byDay,
  tz,
  onPick,
}: {
  cursor: Date;
  byDay: Map<string, Appointment[]>;
  tz: string;
  onPick: (a: Appointment) => void;
}) {
  const key = ymd(cursor);
  const dayAppts = byDay.get(key) ?? [];
  if (dayAppts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        No bookings on this day.
      </div>
    );
  }
  return (
    <div className="divide-y divide-border rounded-xl border border-border">
      {dayAppts.map((a) => (
        <button
          key={a.id}
          onClick={() => onPick(a)}
          className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/50"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {zonedTime(a.startAt, tz)} · {a.customerName || "Customer"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {a.customerPhone || "no phone"}
              {a.notes ? ` · ${a.notes}` : ""}
            </p>
          </div>
          <Badge variant={a.status === "cancelled" ? "danger" : a.source === "ai" ? "success" : "neutral"}>
            {a.status === "cancelled" ? "Cancelled" : a.source === "ai" ? "AI" : "Manual"}
          </Badge>
        </button>
      ))}
    </div>
  );
}

/* ---------------- Dialogs ---------------- */

function ApptDialog({
  appt,
  tz,
  onClose,
  onChanged,
}: {
  appt: Appointment;
  tz: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  // Cancelling is irreversible from the UI, so require a second click to confirm.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [date, setDate] = useState(zonedYmd(appt.startAt, tz));
  const [time, setTime] = useState(() => {
    // Prefill HH:mm in the owner's timezone.
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(appt.startAt));
      return parts;
    } catch {
      return "09:00";
    }
  });

  const cancel = async () => {
    setBusy(true);
    try {
      await api.booking.cancelAppointment(appt.id);
      toast.success("Booking cancelled");
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel");
      setBusy(false);
    }
  };

  const reschedule = async () => {
    setBusy(true);
    try {
      await api.booking.rescheduleAppointment(appt.id, {
        startAt: zonedWallToUtcISO(date, time, tz),
      });
      toast.success("Booking rescheduled");
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't reschedule");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{appt.customerName || "Customer"}</DialogTitle>
          <DialogDescription>{zonedFull(appt.startAt, tz)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 text-sm">
          {appt.customerPhone && <p><span className="text-muted-foreground">Phone:</span> {appt.customerPhone}</p>}
          {appt.customerEmail && <p><span className="text-muted-foreground">Email:</span> {appt.customerEmail}</p>}
          {appt.notes && <p><span className="text-muted-foreground">Notes:</span> {appt.notes}</p>}
          <p className="flex items-center gap-2 pt-1">
            <Badge variant={appt.status === "cancelled" ? "danger" : "success"}>{appt.status}</Badge>
            <Badge variant="neutral">{appt.source === "ai" ? "Booked by AI" : "Manual"}</Badge>
            {appt.hasEvent && <Badge variant="neutral">On calendar</Badge>}
          </p>
        </div>

        {rescheduling && appt.status !== "cancelled" && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="rs-date">New date</Label>
              <Input id="rs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-time">New time</Label>
              <Input id="rs-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        )}

        {appt.status !== "cancelled" && (
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {rescheduling ? (
              <>
                <Button variant="outline" onClick={() => setRescheduling(false)} disabled={busy}>
                  Back
                </Button>
                <Button onClick={reschedule} disabled={busy} className="gap-2">
                  {busy && <Loader2 className="size-4 animate-spin" />} Confirm reschedule
                </Button>
              </>
            ) : confirmingCancel ? (
              <>
                <p className="w-full text-right text-xs text-muted-foreground">
                  Cancel this booking? The customer won't be notified automatically.
                </p>
                <Button variant="outline" onClick={() => setConfirmingCancel(false)} disabled={busy}>
                  Keep booking
                </Button>
                <Button variant="danger" onClick={cancel} disabled={busy} className="gap-2">
                  {busy && <Loader2 className="size-4 animate-spin" />} Yes, cancel it
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="danger"
                  onClick={() => setConfirmingCancel(true)}
                  disabled={busy}
                  className="gap-2"
                >
                  Cancel booking
                </Button>
                <Button variant="outline" onClick={() => setRescheduling(true)} disabled={busy}>
                  Reschedule
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ tz, onClose, onCreated }: { tz: string; onClose: () => void; onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    customerName: "",
    customerPhone: "",
    customerEmail: "",
    notes: "",
    date: ymd(new Date()),
    time: "09:00",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.date || !form.time) {
      toast.error("Pick a date and time");
      return;
    }
    setBusy(true);
    try {
      await api.booking.createAppointment({
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        customerEmail: form.customerEmail.trim(),
        notes: form.notes.trim(),
        startAt: zonedWallToUtcISO(form.date, form.time, tz),
      });
      toast.success("Booking added");
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't add booking");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-4 text-primary" /> Add a booking
          </DialogTitle>
          <DialogDescription>Manually add an appointment to your calendar.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-date">Date</Label>
              <Input id="ad-date" type="date" value={form.date} onChange={set("date")} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-time">Time</Label>
              <Input id="ad-time" type="time" value={form.time} onChange={set("time")} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ad-name">Customer name</Label>
            <Input id="ad-name" value={form.customerName} onChange={set("customerName")} placeholder="Customer" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-phone">Phone</Label>
              <Input id="ad-phone" value={form.customerPhone} onChange={set("customerPhone")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-email">Email</Label>
              <Input id="ad-email" type="email" value={form.customerEmail} onChange={set("customerEmail")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ad-notes">Notes</Label>
            <Textarea id="ad-notes" rows={2} value={form.notes} onChange={set("notes")} />
          </div>
          <Button type="submit" className="w-full gap-2" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add booking
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
