import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Building2, MessageSquare, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StarRating, StarScore } from "@/components/tickets/StarRating";
import { RatingsEmptyIllustration } from "@/components/tickets/TicketIllustrations";
import { TicketStatusBadge } from "@/components/tickets/ticketUi";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { adminHref } from "@/lib/onboardingRoute";
import { useLiveTick } from "@/hooks/useLiveData";
import { cn, formatDate } from "@/lib/utils";
import {
  MAX_STARS,
  POOR_RATING_MAX,
  type AdminTicketDepartment,
  type TicketRatingsPage,
} from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Ratings — what requesters thought of the help they got.
 *
 *  Scoped by the API exactly like the inbox: a staff member sees the
 *  scores for the queues they work, a brand admin their whole tenant's,
 *  the platform owner the brands'. Which lane that is never appears
 *  here — it is already decided by who is asking.
 * ------------------------------------------------------------------ */

const ANY_DEPARTMENT = "__any__";

/**
 * One colour per score so the breakdown reads at a glance: greens are good,
 * amber is "fine", and the two that trigger a follow-up email are warm-to-red.
 */
const SCORE_TONE: Record<number, { star: string; fill: string; track: string }> = {
  5: { star: "fill-success text-success", fill: "bg-success", track: "bg-success/12" },
  4: { star: "fill-success/80 text-success/80", fill: "bg-success/80", track: "bg-success/10" },
  3: { star: "fill-warning text-warning", fill: "bg-warning", track: "bg-warning/12" },
  2: { star: "fill-orange-500 text-orange-500", fill: "bg-orange-500", track: "bg-orange-500/12" },
  1: { star: "fill-danger text-danger", fill: "bg-danger", track: "bg-danger/12" },
};

export default function AdminTicketRatingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);
  const liveTick = useLiveTick();

  const departmentId = searchParams.get("departmentId") ?? ANY_DEPARTMENT;
  const starsParam = searchParams.get("stars");
  const poorOnly = searchParams.get("poorOnly") === "1";

  const [page, setPage] = useState<TicketRatingsPage | null>(null);
  const [departments, setDepartments] = useState<AdminTicketDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(
        await api.admin.tickets.ratings({
          departmentId: departmentId === ANY_DEPARTMENT ? undefined : departmentId,
          stars: starsParam ? Number(starsParam) : undefined,
          poorOnly: poorOnly || undefined,
          pageSize: 50,
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setRefused(e.message);
      else toast.error(e instanceof ApiError ? e.message : "Couldn't load ratings");
    } finally {
      setLoading(false);
    }
  }, [departmentId, starsParam, poorOnly]);

  useEffect(() => {
    void load();
  }, [load, liveTick]);

  useEffect(() => {
    api.admin.tickets.departments
      .list()
      .then(setDepartments)
      .catch(() => setDepartments([]));
  }, []);

  /** Filters live in the URL, so a view of one department is a link. */
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  const inboxHref = adminHref("/dashboard/admin/tickets", role);

  if (refused) {
    return (
      <Card className="flex min-h-[20rem] flex-col items-center justify-center gap-3 p-8 text-center">
        <Star className="size-10 text-muted-foreground/50" />
        <p className="text-base font-semibold">Not your ratings</p>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{refused}</p>
      </Card>
    );
  }

  const summary = page?.summary;
  const rows = page?.ratings ?? [];
  const filtersActive = Boolean(starsParam) || poorOnly || departmentId !== ANY_DEPARTMENT;
  const rated = summary?.rated ?? 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-4">
          <Button
            variant="outline"
            size="icon"
            asChild
            aria-label="Back to requests"
            className="size-11 rounded-xl text-primary hover:text-primary"
          >
            <Link to={inboxHref}>
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Ratings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {summary && rated > 0
                ? `${rated} rated request${rated === 1 ? "" : "s"}${
                    summary.poor ? ` · ${summary.poor} rated 1–2 stars` : ""
                  }`
                : "Feedback on resolved requests"}
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>

      {/* Summary: the average, then the shape of the scores. */}
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card className="flex flex-col items-center justify-center px-6 py-5 text-center">
          {loading ? (
            <Skeleton className="h-40 w-40 rounded-full" />
          ) : (
            <>
              <div className="flex size-16 items-center justify-center rounded-full bg-primary-tint">
                <Star className="size-7 text-primary" strokeWidth={1.75} />
              </div>
              <span className="mt-4 h-1 w-10 rounded-full bg-primary" />
              <p className="mt-3 text-4xl font-semibold tracking-tight">
                {summary?.average != null ? summary.average.toFixed(1) : "0.0"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Average rating</p>
              <StarRating
                value={summary?.average ? Math.round(summary.average) : null}
                size="lg"
                className="mt-3 gap-1.5"
              />
              <p className="mt-3 text-sm text-muted-foreground">
                {rated ? `From ${rated} rating${rated === 1 ? "" : "s"}` : "No ratings yet"}
              </p>
            </>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-base font-semibold">Score breakdown</h2>
          {loading ? (
            <Skeleton className="h-56" />
          ) : (
            <div className="space-y-1">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = summary?.distribution?.[star] ?? 0;
                const pct = rated ? Math.round((count / rated) * 100) : 0;
                const active = starsParam === String(star);
                const tone = SCORE_TONE[star];
                return (
                  <button
                    key={star}
                    type="button"
                    aria-pressed={active}
                    title={active ? "Show all scores" : `Show only ${star}-star requests`}
                    onClick={() => setParam("stars", active ? null : String(star))}
                    className={cn(
                      "flex w-full items-center gap-4 rounded-xl px-3 py-1.5 text-left transition-colors hover:bg-muted/60",
                      active && "bg-primary-tint hover:bg-primary-tint",
                    )}
                  >
                    <span className="flex w-12 shrink-0 items-center gap-2 text-base font-medium tabular-nums">
                      {star} <Star className={cn("size-4", tone.star)} />
                    </span>
                    <span className={cn("h-2.5 flex-1 overflow-hidden rounded-full", tone.track)}>
                      <span
                        className={cn("block h-full rounded-full transition-[width]", tone.fill)}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                      {count} <span className="text-muted-foreground">({pct}%)</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Per-department — the answer to "how is MY queue doing?" */}
      {!loading && (summary?.byDepartment.length ?? 0) > 1 && (
        <Card className="mt-4 p-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Building2 className="size-4 text-primary" /> By department
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {summary!.byDepartment.map((d) => (
              <button
                key={d.id ?? "none"}
                type="button"
                disabled={!d.id}
                onClick={() => setParam("departmentId", d.id)}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border border-border p-3.5 text-left transition-colors",
                  d.id && "hover:bg-muted/60",
                  departmentId === d.id && "border-primary bg-primary-tint",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{d.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {d.rated} rating{d.rated === 1 ? "" : "s"}
                  </span>
                </span>
                <StarScore value={d.average} />
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Filters + the list of what was rated */}
      <Card className="mt-4 flex flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <Select
            value={departmentId}
            onValueChange={(v) => setParam("departmentId", v === ANY_DEPARTMENT ? null : v)}
          >
            <SelectTrigger className="h-12 w-64 rounded-xl bg-muted/40 pl-4" aria-label="Department">
              <div className="flex min-w-0 items-center gap-3">
                <Building2 className="size-[18px] shrink-0 text-muted-foreground" />
                <SelectValue placeholder="All departments" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_DEPARTMENT}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Only worth showing once someone has actually left a poor score — a
              zero-count filter on a fresh account is just noise. Stays while
              it's switched on so it can always be switched off again. */}
          {((summary?.poor ?? 0) > 0 || poorOnly) && (
            <button
              type="button"
              aria-pressed={poorOnly}
              onClick={() => {
                setParam("poorOnly", poorOnly ? null : "1");
                setParam("stars", null);
              }}
              className={cn(
                "inline-flex h-12 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors",
                poorOnly
                  ? "border-danger/40 bg-danger-tint text-danger"
                  : "border-border bg-card text-foreground hover:bg-muted/60",
              )}
            >
              Low ratings
              <span className="font-normal text-muted-foreground">1–2 stars</span>
              <span
                className={cn(
                  "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
                  poorOnly ? "bg-danger/15 text-danger" : "bg-primary-tint text-primary",
                )}
              >
                {summary?.poor ?? 0}
              </span>
            </button>
          )}

          {filtersActive && (
            <button
              type="button"
              onClick={() => setSearchParams({}, { replace: true })}
              className="text-sm font-medium text-primary hover:underline"
            >
              Clear filters
            </button>
          )}

          <span className="ml-auto text-sm text-muted-foreground">
            {loading ? "Loading…" : `${page?.total ?? 0} shown`}
          </span>
        </div>

        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
              <RatingsEmptyIllustration className="mb-4 h-28" />
              <p className="text-lg font-semibold">
                {filtersActive ? "No ratings match" : "No ratings yet"}
              </p>
              <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                {filtersActive
                  ? "Try another department or score, or clear the filters to see everything."
                  : "Requesters are asked to rate a request once it's resolved or closed. Scores appear here for the queues you work."}
              </p>
              {filtersActive && (
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() => setSearchParams({}, { replace: true })}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`${inboxHref}?ticket=${t.id}`}
                    className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-muted/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StarRating value={t.rating} size="sm" />
                        <p className="line-clamp-1 text-sm font-medium">{t.subject}</p>
                        {t.rating !== null && t.rating <= POOR_RATING_MAX && (
                          <Badge variant="danger">Needs a look</Badge>
                        )}
                      </div>
                      {t.ratingComment ? (
                        <p className="mt-1 line-clamp-2 text-sm italic text-muted-foreground">
                          “{t.ratingComment}”
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground/70">No comment left</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-mono">{t.reference}</span>
                        <span>{t.requester.name}</span>
                        {t.brand && (
                          <Badge variant="outline" className="text-[11px]">
                            {t.brand.name}
                          </Badge>
                        )}
                        {t.department && (
                          <Badge variant="outline" className="text-[11px]">
                            {t.department.name}
                          </Badge>
                        )}
                        <TicketStatusBadge status={t.status} staff />
                        {t.ratedAt && <span>rated {formatDate(t.ratedAt)}</span>}
                      </div>
                    </div>
                    <MessageSquare className="mt-1 size-4 shrink-0 text-muted-foreground/50" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        Scores run from 1 to {MAX_STARS}. Anything at {POOR_RATING_MAX} or below emails the team so
        someone takes another look.
      </p>
    </div>
  );
}
