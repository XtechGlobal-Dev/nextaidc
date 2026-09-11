import { useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Phone,
  Plug,
  Tag,
  Zap,
  ZapOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { api } from "@/lib/api";
import { COMPACT_PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import type { Appointment, BookingOverview } from "@/types";
import { cn } from "@/lib/utils";
import { zonedTile, zonedTime } from "./dateUtils";

/* Accents used for the metric chips — same palette as the Dashboard tiles. */
const ACCENT = {
  brand: "#2C76ED",
  good: "#31C14F",
  warn: "#F5A524",
  off: "#8A8A8A",
} as const;


/** Overview — connection + auto-book status, today's count, upcoming bookings. */
export function OverviewTab({ onGoToSettings }: { onGoToSettings: () => void }) {
  const [data, setData] = useState<BookingOverview | null>(null);
  const [upcoming, setUpcoming] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  const { page, pageSize, pageItems, total, setPage, setPageSize } = usePagination(upcoming, {
    initialPageSize: COMPACT_PAGE_SIZE_OPTIONS[0],
  });

  useEffect(() => {
    // Start the "upcoming" list at the beginning of TODAY (not the current moment)
    // so today's whole day stays visible and reconciles with the "Bookings today"
    // tile + the Calendar — otherwise appointments earlier today drop off and the
    // counts look inconsistent.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    Promise.all([
      api.booking.overview(),
      api.booking.appointments({ from: startOfToday.toISOString(), status: "confirmed" }),
    ])
      .then(([o, a]) => {
        setData(o);
        setUpcoming(a.appointments);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);


  if (loading) return <OverviewSkeleton />;
  if (!data) {
    return <p className="text-sm text-muted-foreground">Couldn't load your booking overview.</p>;
  }

  const tz = data.timezone || "UTC";

  // Setup checklist — the two things required before the AI can book on a call:
  // connect Google Calendar, and turn on auto-booking.
  const setup = [
    {
      label: "Connect Google Calendar",
      hint: "Lets the AI read availability and write bookings.",
      done: data.connected,
      onClick: onGoToSettings,
    },
    {
      label: "Turn on auto-booking",
      hint: "Allows the AI to book directly when a caller asks.",
      done: data.autoBookEnabled,
      onClick: onGoToSettings,
    },
  ];
  const doneCount = setup.filter((s) => s.done).length;

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          index={0}
          accent={ACCENT.brand}
          icon={CalendarDays}
          label="Bookings today"
          value={String(data.todayCount)}
          caption={
            data.todayCount === 0
              ? "Nothing on the books yet."
              : `Across your bookable hours (${tz}).`
          }
        />

        {data.connected ? (
          <MetricTile
            index={1}
            accent={ACCENT.good}
            icon={CheckCircle2}
            label="Calendar"
            value="Connected"
            pill={{ text: "Live", tone: "good" }}
            caption="Google Calendar is linked."
          />
        ) : (
          <MetricTile
            index={1}
            accent={ACCENT.warn}
            icon={Plug}
            label="Calendar"
            value="Not connected"
            pill={{ text: "Action needed", tone: "warn" }}
            caption="Connect it to enable direct booking."
            action={{ label: "Connect calendar", onClick: onGoToSettings }}
          />
        )}

        {data.canAutoBook ? (
          <MetricTile
            index={2}
            accent={ACCENT.good}
            icon={Zap}
            label="Auto-booking"
            value="On"
            pill={{ text: "Live", tone: "good" }}
            caption="The AI can book directly when asked."
          />
        ) : data.autoBookEnabled ? (
          <MetricTile
            index={2}
            accent={ACCENT.warn}
            icon={Zap}
            label="Auto-booking"
            value="Needs calendar"
            pill={{ text: "Action needed", tone: "warn" }}
            caption="Connect Google Calendar to activate it."
            action={{ label: "Connect calendar", onClick: onGoToSettings }}
          />
        ) : (
          <MetricTile
            index={2}
            accent={ACCENT.off}
            icon={ZapOff}
            label="Auto-booking"
            value="Off"
            pill={{ text: "Paused", tone: "off" }}
            caption="The AI takes a message instead of booking."
            action={{ label: "Turn it on", onClick: onGoToSettings }}
          />
        )}
      </div>

      {/* Setup progress — disappears once everything's connected. */}
      {doneCount < setup.length && (
        <Card className="animate-rise card-glass relative overflow-hidden">
          <span
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-primary/10 blur-3xl"
          />
          <CardContent className="relative p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-base font-semibold">Finish setting up booking</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Two quick steps before your AI can book on a call.
                </p>
              </div>
              <span className="rounded-full bg-primary-tint px-3 py-1 text-xs font-semibold text-primary">
                {doneCount} of {setup.length} done
              </span>
            </div>

            {/* Progress rail */}
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${(doneCount / setup.length) * 100}%` }}
              />
            </div>

            <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
              {setup.map((s) => {
                const body = (
                  <>
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full transition-colors",
                        s.done
                          ? "bg-success text-white"
                          : "border-2 border-dashed border-border text-transparent",
                      )}
                    >
                      <Check className="size-3.5" strokeWidth={3} />
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-sm font-semibold",
                          s.done ? "text-muted-foreground line-through" : "text-foreground",
                        )}
                      >
                        {s.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {s.hint}
                      </span>
                    </span>
                  </>
                );
                const cls = cn(
                  "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors",
                  s.done
                    ? "border-success/25 bg-success-tint/40"
                    : "border-border bg-card hover:border-primary/40 hover:bg-primary-tint-soft",
                );
                if (s.done) {
                  return (
                    <div key={s.label} className={cls}>
                      {body}
                    </div>
                  );
                }
                // Every step opens this page's own Settings tab — nothing routes
                // away from Booking any more.
                return (
                  <button key={s.label} type="button" onClick={s.onClick} className={cls}>
                    {body}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Working area — the list carries the weight, behaviour sits alongside. */}
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {/* Upcoming (paginated) */}
        <Card className="animate-rise card-glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-xl bg-primary-tint text-primary">
                <CalendarClock className="size-4" />
              </span>
              Upcoming bookings
              {upcoming.length > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                  {upcoming.length}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-primary-tint-soft text-primary/70">
                  <CalendarClock className="size-6" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">No upcoming bookings yet.</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Bookings your AI takes on calls will show up here.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {pageItems.map((a) => {
                    const tile = zonedTile(a.startAt, tz);
                    return (
                      <li
                        key={a.id}
                        className="group flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3 transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[var(--shadow-soft)]"
                      >
                        {/* Date tile */}
                        <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-gradient-to-b from-primary to-primary/85 py-1.5 text-primary-foreground shadow-sm">
                          <span className="text-[10px] font-bold uppercase leading-none tracking-wide opacity-90">
                            {tile.month}
                          </span>
                          <span className="text-lg font-bold leading-tight">{tile.day}</span>
                        </div>

                        {/* Details */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold">
                              {a.customerName || "Customer"}
                            </p>
                            {a.notes && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-tint px-2 py-0.5 text-[11px] font-medium capitalize text-primary">
                                <Tag className="size-2.5" />
                                {a.notes}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="size-3" />
                              {tile.weekday} · {zonedTime(a.startAt, tz)}
                            </span>
                            {a.customerPhone && (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="size-3" />
                                {a.customerPhone}
                              </span>
                            )}
                          </div>
                        </div>

                        <Badge variant={a.source === "ai" ? "success" : "neutral"}>
                          {a.source === "ai" ? "AI" : "Manual"}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>

                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                  pageSizeOptions={COMPACT_PAGE_SIZE_OPTIONS}
                  noun="bookings"
                  className="mt-4 border-t border-border pt-3"
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* How booking works right now */}
        <Card className="animate-rise card-glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-xl bg-primary-tint text-primary">
                <CalendarClock className="size-4" />
              </span>
              On a call right now
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <BehaviourRow
              icon={data.canAutoBook ? Zap : ZapOff}
              active={data.canAutoBook}
              title={data.canAutoBook ? "Direct booking is on" : "Direct booking is off"}
            >
              {data.canAutoBook ? (
                <>
                  The AI checks your open times and books the caller in directly on the call. It adds
                  the booking to your calendar and texts the caller a confirmation.
                </>
              ) : (
                <>
                  The AI takes the caller's details for your team to follow up.{" "}
                  <button onClick={onGoToSettings} className="font-medium text-primary hover:underline">
                    Turn on auto-booking
                  </button>{" "}
                  to have it book on the call.
                </>
              )}
            </BehaviourRow>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** One line of "here's what your AI does on a call right now" — an icon whose
 *  tint says whether that behaviour is live, plus the explanation. */
function BehaviourRow({
  icon: Icon,
  active,
  title,
  children,
}: {
  icon: LucideIcon;
  active: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-2xl border p-3.5 transition-colors",
        active ? "border-primary/20 bg-primary-tint-soft" : "border-border/70 bg-muted/25",
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-xl",
          active ? "bg-primary-tint text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

/** Loading skeleton matching the Overview layout (3 tiles + content columns). */
function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="size-10 rounded-xl" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-1.5 w-full" />
          <div className="grid gap-2.5 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader className="gap-2">
              <Skeleton className="h-5 w-52" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, r) => (
                <Skeleton key={r} className="h-14 w-full rounded-2xl" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

type PillTone = "good" | "warn" | "off";

const PILL: Record<PillTone, string> = {
  good: "bg-success-tint text-success",
  warn: "bg-warning-tint text-warning",
  off: "bg-muted text-muted-foreground",
};

/** Dashboard-style metric tile: gradient icon chip, accent hairline, big value. */
function MetricTile({
  icon: Icon,
  label,
  value,
  caption,
  accent,
  pill,
  action,
  index = 0,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  caption?: string;
  accent: string;
  pill?: { text: string; tone: PillTone };
  action?: { label: string; onClick: () => void };
  index?: number;
}) {
  return (
    <Card
      className="lift card-glass animate-rise relative flex h-full flex-col overflow-hidden"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
      <CardContent className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-2">
          <span
            className="grid size-10 place-items-center rounded-xl text-white [&_svg]:size-5"
            style={{
              background: `linear-gradient(135deg, ${accent}, ${accent}cc)`,
              boxShadow: `0 4px 12px -3px ${accent}66`,
            }}
          >
            <Icon />
          </span>
          {pill && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                PILL[pill.tone],
              )}
            >
              {pill.text}
            </span>
          )}
        </div>

        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-bold leading-none tracking-tight">{value}</p>
        {caption && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{caption}</p>}

        {action && (
          <button
            onClick={action.onClick}
            className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-semibold text-primary transition-colors hover:opacity-80"
          >
            {action.label}
            <ArrowRight className="size-3.5" />
          </button>
        )}
      </CardContent>
    </Card>
  );
}
