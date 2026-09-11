import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  Handshake,
  Hourglass,
  Package,
  Phone,
  PhoneCall,
  Timer,
  UserCircle2,
  UserCog,
  Users,
  UserPlus,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  CardSkeleton,
} from "@/components/ui/skeleton";
import { api, type AdminOverview } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ className?: string }>;

/** Animate a number from 0 → target once on mount (easeOutCubic). */
function useCountUp(target: number, duration = 850): number {
  const [val, setVal] = useState(0);
  const ref = useRef(target);
  ref.current = target;
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(ref.current * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setVal(ref.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function StatCard({
  label,
  value,
  icon: Icon,
  prefix = "",
  sub,
  accent,
  to,
  delay = 0,
}: {
  label: string;
  value: number;
  icon: IconType;
  prefix?: string;
  sub?: string;
  accent: string;
  to?: string;
  delay?: number;
}) {
  const animated = useCountUp(value);
  const display = prefix + Math.round(animated).toLocaleString();

  const inner = (
    <>
      {/* faint accent wash in the corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full opacity-[0.07] blur-2xl transition-opacity group-hover:opacity-[0.13]"
        style={{ backgroundColor: accent }}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{display}</p>
          {sub && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-medium" style={{ color: accent }}>
              {sub}
            </p>
          )}
        </div>
        <div
          className="grid size-11 shrink-0 place-items-center rounded-xl"
          style={{
            color: accent,
            backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
          }}
        >
          <Icon className="size-5" />
        </div>
      </div>
      {to && (
        <ArrowUpRight className="absolute bottom-3 right-3 size-4 text-muted-foreground/0 transition-all group-hover:text-muted-foreground" />
      )}
    </>
  );

  const className = cn(
    "lift animate-rise group relative block overflow-hidden rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)]",
    to && "cursor-pointer hover:border-primary/30",
  );
  const style = { animationDelay: `${delay}ms` } as const;

  return to ? (
    <Link to={to} className={className} style={style}>
      {inner}
    </Link>
  ) : (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}

// Deterministic avatar accent per name so the signups list feels lively but stable.
const AVATAR_ACCENTS = [
  "var(--color-step-1)",
  "var(--color-step-2)",
  "var(--color-step-3)",
  "var(--color-step-4)",
  "var(--color-step-5)",
];
function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_ACCENTS[h % AVATAR_ACCENTS.length];
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

// Map a real subscription status → a customer-facing label + badge variant.
function statusBadge(status: string): { label: string; variant: "success" | "primary" | "warning" | "neutral" } {
  switch (status) {
    case "active":
      return { label: "Active", variant: "success" };
    case "trialing":
      return { label: "Trial", variant: "primary" };
    case "past_due":
      return { label: "Past due", variant: "warning" };
    case "canceled":
      return { label: "Canceled", variant: "neutral" };
    default:
      return { label: "Free", variant: "neutral" };
  }
}

export default function AdminOverviewPage() {
  const [data, setData] = useState<AdminOverview | null>(null);
  // Re-run on every live tick so the KPIs (calls, customers, leads) stay current
  // without a manual reload. Data is only swapped on success, so the already-
  // rendered cards never flash back to skeletons on a background refresh.
  const liveTick = useLiveTick();

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.admin.overview();
        if (active) setData(res);
      } catch {
        if (liveTick === 0) toast.error("Failed to load overview");
      }
    })();
    return () => {
      active = false;
    };
  }, [liveTick]);

  if (!data) {
    return (
      <div>
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={6} className="mt-6 lg:grid-cols-3" />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <CardSkeleton rows={4} className="lg:col-span-3" />
          <CardSkeleton rows={5} className="lg:col-span-2" />
        </div>
        <StatCardsSkeleton count={3} className="mt-6 lg:grid-cols-3" />
      </div>
    );
  }

  // Honest derived metrics (no faked trends).
  const conversion = data.customers > 0 ? Math.round((data.paying / data.customers) * 100) : 0;
  const livePlanCount = data.planMix.filter((p) => p.id).length;
  const minutesSub =
    data.totalMinutes > 0
      ? `${data.trialMinutes.toLocaleString()} trial · ${data.planMinutes.toLocaleString()} paid`
      : "No minutes consumed yet";

  return (
    <div>
      <PageHeader title="Overview" subtitle="Your platform at a glance" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Customers"
          value={data.customers}
          icon={Users}
          sub={data.newCustomers > 0 ? `+${data.newCustomers} new this month` : "No new signups this month"}
          accent="var(--color-step-1)"
          to="/dashboard/admin/customers"
          delay={0}
        />
        <StatCard
          label="Paid subscribers"
          value={data.paying}
          icon={BadgeCheck}
          sub={`${conversion}% of customers converted`}
          accent="var(--color-premium)"
          to="/dashboard/admin/customers"
          delay={60}
        />
        <StatCard
          label="On trial"
          value={data.trialing}
          icon={Hourglass}
          sub="In free-trial period"
          accent="var(--color-step-3)"
          to="/dashboard/admin/customers"
          delay={120}
        />
        <StatCard
          label="Customer calls"
          value={data.totalCalls}
          icon={PhoneCall}
          sub="Across all customers"
          accent="var(--color-step-2)"
          delay={180}
        />
        <StatCard
          label="Minutes used"
          value={data.totalMinutes}
          icon={Timer}
          sub={minutesSub}
          accent="var(--color-step-4)"
          delay={240}
        />
        <StatCard
          label="Phone numbers"
          value={data.phones.total}
          icon={Phone}
          sub={`${data.phones.assigned} assigned · ${data.phones.available} available`}
          accent="var(--color-step-5)"
          to="/dashboard/admin/phone-numbers"
          delay={300}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Plan mix — real subscription plans (scales to any number of plans) */}
        <Card className="p-6 lg:col-span-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold leading-tight">Plan mix</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Live customers across your actual plans
              </p>
            </div>
            <Link
              to="/dashboard/admin/plans"
              className="grid size-9 place-items-center rounded-xl bg-primary-tint text-primary transition-colors hover:bg-primary/15"
            >
              <Package className="size-4" />
            </Link>
          </div>

          {data.planMix.length === 0 ? (
            <div className="mt-4 flex flex-col items-center gap-2 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Package className="size-6" />
              </span>
              <p className="text-sm text-muted-foreground">
                No customers yet — plan distribution will appear here.
              </p>
            </div>
          ) : (
            <PlanMix mix={data.planMix} total={data.customers} />
          )}
        </Card>

        {/* Recent signups — capped at the 5 most recent */}
        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold leading-tight">Recent signups</h3>
              <p className="mt-1 text-sm text-muted-foreground">Latest accounts created</p>
            </div>
            <span className="grid size-9 place-items-center rounded-xl bg-primary-tint text-primary">
              <UserPlus className="size-4" />
            </span>
          </div>

          {data.recentSignups.length === 0 ? (
            <div className="mt-4 flex flex-col items-center gap-2 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <UserCircle2 className="size-6" />
              </span>
              <p className="text-sm text-muted-foreground">
                No recent signups yet — new customers will appear here.
              </p>
            </div>
          ) : (
            <ul className="mt-2">
              {data.recentSignups.map((s) => {
                const accent = accentFor(s.id || s.email);
                const badge = statusBadge(s.status);
                return (
                  <li key={s.id}>
                    <Link
                      to={`/dashboard/admin/customers/${s.id}`}
                      className="group flex items-center gap-3 border-b border-border px-2 py-3 transition-colors last:border-b-0 hover:bg-muted/40"
                    >
                      <div
                        className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold"
                        style={{
                          color: accent,
                          backgroundColor: `color-mix(in srgb, ${accent} 16%, transparent)`,
                        }}
                      >
                        {initials(s.fullName) || <UserCircle2 className="size-5" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium group-hover:text-primary">{s.fullName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {s.planName ?? s.email}
                        </p>
                      </div>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Manage — the other surfaces the admin owns */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ManageCard
          label="Resellers"
          value={data.resellers}
          icon={Handshake}
          sub={
            data.pendingCommission > 0
              ? `$${data.pendingCommission.toLocaleString()} in pending payouts`
              : "No pending payouts"
          }
          accent="var(--color-step-2)"
          to="/dashboard/admin/resellers"
          delay={0}
        />
        <ManageCard
          label="Plans"
          value={livePlanCount}
          icon={Package}
          sub="Manage pricing & tiers"
          accent="var(--color-premium)"
          to="/dashboard/admin/plans"
          delay={60}
        />
        <ManageCard
          label="Team"
          value={data.staff}
          icon={UserCog}
          sub={`${data.admins} admin${data.admins === 1 ? "" : "s"} · staff & access`}
          accent="var(--color-success)"
          to="/dashboard/admin/staff"
          delay={120}
        />
      </div>
    </div>
  );
}

const PLAN_BAR_COLORS = [
  "var(--color-step-1)",
  "var(--color-step-2)",
  "var(--color-step-3)",
  "var(--color-step-4)",
  "var(--color-step-5)",
];

function PlanMix({
  mix,
  total,
}: {
  mix: AdminOverview["planMix"];
  total: number;
}) {
  const denom = total > 0 ? total : 1;
  const colorFor = (i: number, isFree: boolean) =>
    isFree ? "color-mix(in srgb, var(--color-muted-foreground) 40%, transparent)" : PLAN_BAR_COLORS[i % PLAN_BAR_COLORS.length];

  return (
    <div className="mt-5 space-y-5">
      {/* Stacked distribution bar — thin segment gaps keep adjacent colors legible */}
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {mix.map((p, i) => (
          <div
            key={p.id ?? "free"}
            className="h-full transition-[width] duration-500 ease-out first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(p.subscribers / denom) * 100}%`,
              backgroundColor: colorFor(i, p.id === null),
            }}
            title={`${p.name} — ${p.subscribers}`}
          />
        ))}
      </div>

      <div className="space-y-0.5">
        {mix.map((p, i) => {
          const pct = (p.subscribers / denom) * 100;
          return (
            <div
              key={p.id ?? "free"}
              className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/40"
            >
              <span
                className="size-2.5 shrink-0 rounded-full ring-2 ring-inset ring-white/20"
                style={{ backgroundColor: colorFor(i, p.id === null) }}
              />
              <span className="flex min-w-0 items-center gap-1.5 truncate text-sm">
                <span className="truncate font-medium text-foreground/90">{p.name}</span>
                {p.legacy && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
                    Legacy
                  </Badge>
                )}
              </span>
              <span className="ml-auto text-sm font-semibold tabular-nums">{p.subscribers}</span>
              <span className="w-11 text-right text-xs font-medium tabular-nums text-muted-foreground">
                {Math.round(pct)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ManageCard({
  label,
  value,
  icon: Icon,
  sub,
  accent,
  to,
  delay = 0,
}: {
  label: string;
  value: number;
  icon: IconType;
  sub: string;
  accent: string;
  to: string;
  delay?: number;
}) {
  return (
    <Link
      to={to}
      className="lift animate-rise group relative flex items-center gap-4 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)] hover:border-primary/30"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="grid size-12 shrink-0 place-items-center rounded-xl"
        style={{
          color: accent,
          backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
        }}
      >
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-bold tabular-nums leading-none">{value.toLocaleString()}</p>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
    </Link>
  );
}
