import { useEffect, useState } from "react";
import {
  BadgePercent,
  CalendarDays,
  Copy,
  Loader2,
  Lock,
  Package,
  Plus,
  SlidersHorizontal,
  Ticket,
  Trash2,
  Users,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardSkeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  api,
  ApiError,
  type Coupon,
  type CouponInput,
  type CouponRedemptionRow,
  type SubscriptionPlan,
} from "@/lib/api";
import { cn, formatDateDMY } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";

interface FormState {
  code: string;
  displayName: string;
  description: string;
  percentOff: string;
  bonusMinutes: string;
  durationCycles: string;
  startsAt: string; // yyyy-mm-dd
  expiresAt: string;
  maxRedemptions: string;
  newCustomersOnly: boolean;
  planIds: string[];
  active: boolean;
}

const EMPTY: FormState = {
  code: "",
  displayName: "",
  description: "",
  percentOff: "",
  bonusMinutes: "",
  durationCycles: "1",
  startsAt: "",
  expiresAt: "",
  maxRedemptions: "",
  newCustomersOnly: true,
  planIds: [],
  active: true,
};

/** A yyyy-mm-dd input value → an ISO instant, or null when blank. */
function toIso(day: string, endOfDay = false): string | null {
  if (!day) return null;
  return new Date(`${day}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString();
}

/** A Date → the yyyy-mm-dd a date input wants, in LOCAL time.
 *
 *  Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first, so
 *  a start date saved as local midnight comes back a day early for anyone east
 *  of UTC — which is most of this product's market. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An ISO instant → the yyyy-mm-dd a date input wants. */
function toDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : localDay(d);
}

/** Today, for capping the expiry picker. A coupon that expires in the past is
 *  dead on arrival — to stop an existing one, turn Active off instead. */
const TODAY = localDay(new Date());

function describeDuration(cycles: number): string {
  return cycles === 1 ? "First charge only" : `First ${cycles} billing cycles`;
}

/** Decorative barcode — bar widths derived from the code's characters, so every
 *  coupon prints its own pattern. Pure ornament, hence aria-hidden. */
function Barcode({ seed, className }: { seed: string; className?: string }) {
  const bars: number[] = [];
  for (let i = 0; bars.length < 24; i++) {
    const ch = seed.charCodeAt(i % Math.max(1, seed.length)) || 65;
    bars.push(((ch + i * 7) % 3) + 1);
  }
  return (
    <div aria-hidden className={cn("flex h-6 items-stretch gap-px", className)}>
      {bars.map((w, i) => (
        <span key={i} className="bg-current" style={{ width: w }} />
      ))}
    </div>
  );
}

function copyCode(code: string) {
  navigator.clipboard.writeText(code).then(
    () => toast.success("Code copied"),
    () => toast.error("Couldn't copy the code"),
  );
}

/** Micro-heading that groups the form into scannable sections. Each section
 *  carries one of the app's step accents (see --color-step-* in index.css) as a
 *  tinted icon chip — the same colour language as the AI Brain sections. */
const SECTION_TONES = {
  blue: "bg-step-1/12 text-step-1",
  violet: "bg-step-2/12 text-step-2",
  green: "bg-step-3/12 text-step-3",
  amber: "bg-step-4/14 text-step-4",
  sky: "bg-step-5/12 text-step-5",
} as const;

function SectionHeading({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone: keyof typeof SECTION_TONES;
  children: string;
}) {
  return (
    <h3 className="flex items-center gap-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-lg",
          SECTION_TONES[tone],
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
        {children}
      </span>
    </h3>
  );
}

export default function AdminCouponsPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canCreate = hasPermission("coupons.create");
  const canEdit = hasPermission("coupons.edit");
  const canDelete = hasPermission("coupons.delete");

  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Coupon | null>(null);
  const [redemptionsFor, setRedemptionsFor] = useState<Coupon | null>(null);
  const [redemptions, setRedemptions] = useState<CouponRedemptionRow[] | null>(null);

  async function load() {
    try {
      const [list, pl] = await Promise.all([
        api.admin.coupons.list(),
        api.billing.plans().catch(() => [] as SubscriptionPlan[]),
      ]);
      setCoupons(list);
      setPlans(pl);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to load coupons");
      setCoupons([]);
    }
  }

  // Refresh when the tab regains focus. Redemptions happen in the CUSTOMER's
  // session, so there's no client event here to push the counts — and watching a
  // campaign means flipping between this tab and a checkout. Focus-only, not
  // polled: unlike the customer Plans page (where a live call moves the usage
  // meter every few seconds), these counts only change on a real charge.
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // `load` only closes over setters, so a stale reference is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(c: Coupon) {
    setEditing(c);
    setForm({
      code: c.code,
      displayName: c.displayName,
      description: c.description,
      percentOff: c.percentOff?.toString() ?? "",
      bonusMinutes: c.bonusMinutes?.toString() ?? "",
      durationCycles: c.durationCycles.toString(),
      startsAt: toDay(c.startsAt),
      expiresAt: toDay(c.expiresAt),
      maxRedemptions: c.maxRedemptions?.toString() ?? "",
      newCustomersOnly: c.newCustomersOnly,
      planIds: c.planIds,
      active: c.active,
    });
    setOpen(true);
  }

  /** Terms are frozen once anyone has been shown them — a completed redemption,
   *  or a checkout in progress. Changing them would rewrite a deal someone is
   *  already on. Mirrors the in-use plan rule. Server-computed, so the form can
   *  never offer a field the API will reject. */
  const termsLocked = !!editing && editing.locked;

  /** Floor for the "Redeemable from" picker.
   *
   *  Today in every case but one: a coupon that genuinely opened in the past must
   *  keep its OWN start selectable, or `min` would mark the stored value invalid
   *  and get in the way of editing the coupon's name, limits or Active state.
   *
   *  That single exception used to be handled by dropping the floor entirely while
   *  editing, which also offered every other past date — and the save guard then
   *  refused them. A control should not present a choice it will reject, so the
   *  floor now moves only as far back as that coupon's own start. */
  const existingStart = toDay(editing?.startsAt ?? null);
  const minStartsAt = existingStart && existingStart < TODAY ? existingStart : TODAY;

  async function save() {
    const percentOff = form.percentOff.trim() ? Number(form.percentOff) : null;
    const bonusMinutes = form.bonusMinutes.trim() ? Number(form.bonusMinutes) : null;
    if (percentOff == null && bonusMinutes == null) {
      toast.error("Give the coupon a percentage discount, bonus minutes, or both.");
      return;
    }
    if (percentOff != null && (percentOff < 1 || percentOff > 100)) {
      toast.error("The percentage must be between 1 and 100.");
      return;
    }
    // Both date guards fire only when the admin actually picked a NEW value —
    // an existing coupon legitimately has dates in the past, and rejecting them
    // would block editing its name, limits or Active state.
    const startChanged = form.startsAt !== toDay(editing?.startsAt ?? null);
    if (form.startsAt && startChanged && form.startsAt < TODAY) {
      toast.error("The start date can't be in the past — leave it blank to start straight away.");
      return;
    }
    const expiryChanged = form.expiresAt !== toDay(editing?.expiresAt ?? null);
    if (form.expiresAt && expiryChanged && form.expiresAt < TODAY) {
      toast.error("The expiry date can't be in the past. To stop a coupon now, turn Active off.");
      return;
    }
    if (form.startsAt && form.expiresAt && form.startsAt > form.expiresAt) {
      toast.error("The start date must be before the expiry date.");
      return;
    }
    // An end date is required on every new coupon, and can't be cleared off one
    // that has it — a code with no expiry stays claimable long after its campaign
    // is over. Coupons created before this rule have no expiry and stay editable,
    // so this only fires when the admin is creating or actively erasing a date.
    if (!form.expiresAt && (!editing || editing.expiresAt)) {
      toast.error("Pick a 'Redeemable until' date — every coupon needs an end date.");
      return;
    }

    const payload: CouponInput = {
      code: form.code.trim().toUpperCase(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
      percentOff,
      bonusMinutes,
      durationCycles: Number(form.durationCycles) || 1,
      startsAt: toIso(form.startsAt),
      expiresAt: toIso(form.expiresAt, true),
      maxRedemptions: form.maxRedemptions.trim() ? Number(form.maxRedemptions) : null,
      newCustomersOnly: form.newCustomersOnly,
      planIds: form.planIds,
      active: form.active,
    };

    setSaving(true);
    try {
      if (editing) {
        // Locked fields are omitted rather than sent unchanged, so a redeemed
        // coupon never trips the server guard on a no-op edit.
        const { code, percentOff: _p, bonusMinutes: _b, durationCycles: _d, ...safe } = payload;
        await api.admin.coupons.update(
          editing.id,
          termsLocked ? safe : { ...safe, code, percentOff, bonusMinutes, durationCycles: payload.durationCycles },
        );
        toast.success("Coupon updated");
      } else {
        await api.admin.coupons.create(payload);
        toast.success("Coupon created");
      }
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save coupon");
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: Coupon) {
    try {
      await api.admin.coupons.remove(c.id);
      toast.success("Coupon deleted");
      setDeleting(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to delete coupon");
    }
  }

  async function showRedemptions(c: Coupon) {
    setRedemptionsFor(c);
    setRedemptions(null);
    try {
      setRedemptions(await api.admin.coupons.redemptions(c.id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to load redemptions");
      setRedemptions([]);
    }
  }

  return (
    <div>
      <PageHeader
        title="Coupons"
        subtitle="Discount codes customers redeem at checkout, or you grant to an account."
        actions={
          canCreate ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" /> New coupon
            </Button>
          ) : undefined
        }
      />

      {coupons === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : coupons.length === 0 ? (
        <Card className="py-16 text-center">
          <Ticket className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No coupons yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a code customers can redeem at checkout.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {coupons.map((c) => {
            const expired = !!c.expiresAt && new Date(c.expiresAt) <= new Date();
            // ONE status, by precedence. Three stacked grey pills made a dead
            // coupon look much like a live one; the question an admin is
            // actually asking is "does this work right now, and if not why".
            // Amber, not red, for all three: a campaign that ended or sold out
            // did its job — none of these are failures, they just mean "not
            // redeemable right now", and each is reversible by an admin.
            const status = !c.active
              ? { label: "Inactive", variant: "warning" as const }
              : expired
                ? { label: "Expired", variant: "warning" as const }
                : c.soldOut
                  ? { label: "Sold out", variant: "warning" as const }
                  : null;
            return (
              // A real-ticket coupon: the offer face on top, a perforated tear
              // line with punch-hole notches, and the operational stub below.
              <div
                key={c.id}
                className={cn(
                  "relative flex flex-col overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-soft)] transition-shadow hover:shadow-[var(--shadow-panel)]",
                  // A coupon that can't be redeemed should be obvious while
                  // scanning, not just from a small pill in the corner.
                  status ? "border-dashed border-border" : "border-primary/25",
                )}
              >
                {/* ---- Offer face — the tear line lives INSIDE this surface,
                     so the perforation reads as punched through the ticket
                     itself rather than a separate band below it. ---- */}
                <div
                  className={cn(
                    "relative",
                    // Live coupons print on the brand gradient (same as the
                    // dashboard hero band); dead ones fade to a grey stub.
                    status
                      ? "bg-muted/50"
                      : "bg-[linear-gradient(120deg,#1E63DD_0%,#2C76ED_55%,#5B93F2_100%)]",
                  )}
                >
                  <div className="px-5 pt-4">
                  <div className="flex items-start justify-between gap-3">
                    <p
                      className={cn(
                        "min-w-0 truncate pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
                        status ? "text-muted-foreground" : "text-white/90",
                      )}
                    >
                      {c.displayName}
                    </p>
                    {status ? (
                      <Badge variant={status.variant} className="shrink-0">
                        {status.label}
                      </Badge>
                    ) : (
                      // Solid white pill — a translucent one washed out against
                      // the light end of the gradient.
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-primary shadow-sm">
                        <span className="size-1.5 animate-pulse rounded-full bg-success" />
                        Live
                      </span>
                    )}
                  </div>

                  <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {c.percentOff != null && (
                      <span
                        className={cn(
                          "text-3xl font-extrabold tracking-tight",
                          status ? "text-muted-foreground" : "text-white drop-shadow-sm",
                        )}
                      >
                        {c.percentOff}% OFF
                      </span>
                    )}
                    {c.percentOff != null && c.bonusMinutes != null && (
                      <span className={cn("text-sm", status ? "text-muted-foreground" : "text-white/90")}>
                        +
                      </span>
                    )}
                    {c.bonusMinutes != null && (
                      <span
                        className={cn(
                          "text-2xl font-extrabold tracking-tight",
                          status ? "text-muted-foreground" : "text-white drop-shadow-sm",
                        )}
                      >
                        {c.bonusMinutes} min
                      </span>
                    )}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 text-xs font-medium",
                      status ? "text-muted-foreground" : "text-white/90",
                    )}
                  >
                    {describeDuration(c.durationCycles)}
                    {c.bonusMinutes != null ? " · minutes granted each cycle" : ""}
                  </p>

                  {/* The code, presented the way a voucher prints it — click to copy. */}
                  <button
                    type="button"
                    onClick={() => copyCode(c.code)}
                    title="Copy code"
                    className={cn(
                      "group mt-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 transition-colors",
                      status
                        ? "border-border bg-card/60 text-muted-foreground hover:bg-card"
                        : "border-white/70 bg-white/20 text-white backdrop-blur-sm hover:bg-white/30",
                    )}
                  >
                    <span className="truncate font-mono text-sm font-bold tracking-[0.15em]">
                      {c.code}
                    </span>
                    <Copy
                      className={cn(
                        "size-3.5 shrink-0 transition-opacity",
                        status
                          ? "opacity-50 group-hover:opacity-100"
                          : "opacity-80 group-hover:opacity-100",
                      )}
                    />
                  </button>
                  </div>

                  {/* Tear line at the EXACT junction of the ticket face and the
                      stub: the dashes sit flush against the boundary, and the
                      notch circles straddle it — top half punched out of the
                      colour, bottom half melting into the card. */}
                  <div
                    aria-hidden
                    className={cn(
                      "mx-4 mt-4 border-t-2 border-dashed",
                      status ? "border-border" : "border-white/60",
                    )}
                  />
                  <div
                    aria-hidden
                    className="absolute -bottom-2.5 -left-2.5 size-5 rounded-full bg-background"
                  />
                  <div
                    aria-hidden
                    className="absolute -bottom-2.5 -right-2.5 size-5 rounded-full bg-background"
                  />
                </div>

                {/* ---- Stub: the operational half ---- */}
                <div className="flex flex-1 flex-col p-5 pt-4">
                {/* Redemptions, with a usage bar when there's a cap to fill. */}
                <button
                  type="button"
                  onClick={() => void showRedemptions(c)}
                  className="w-full text-left"
                >
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      <Users className="size-4 shrink-0" /> Redemptions
                    </span>
                    <span className="font-semibold tabular-nums">
                      {c.redeemedCount}
                      {c.maxRedemptions != null && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          / {c.maxRedemptions}
                        </span>
                      )}
                    </span>
                  </span>
                  {c.maxRedemptions != null && (
                    <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <span
                        className={cn(
                          "block h-full rounded-full transition-all",
                          c.soldOut ? "bg-warning" : "bg-primary",
                        )}
                        style={{
                          width: `${Math.min(100, (c.redeemedCount / c.maxRedemptions) * 100)}%`,
                        }}
                      />
                    </span>
                  )}
                  {c.activeRedemptions > 0 && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {c.activeRedemptions} currently running
                    </span>
                  )}
                </button>

                {/* Restrictions as chips — secondary detail, scannable in one line. */}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {c.newCustomersOnly && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <Users className="size-3" /> New customers
                    </span>
                  )}
                  {c.planIds.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <Package className="size-3" /> {c.planIds.length} plan
                      {c.planIds.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {c.expiresAt && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <CalendarDays className="size-3" /> Until {formatDateDMY(c.expiresAt)}
                    </span>
                  )}
                </div>

                <div className="mt-auto flex items-end gap-2 pt-4">
                  {canEdit && (
                    <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                      <Pencil className="size-4" /> Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:text-danger"
                      onClick={() => setDeleting(c)}
                      disabled={c.locked}
                      title={
                        c.totalRedemptions > 0
                          ? "Redeemed coupons can't be deleted — deactivate it instead"
                          : c.livePending > 0
                            ? "Someone is checking out with this coupon right now"
                            : undefined
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                  {/* Barcode stamp — each code prints its own bar pattern. */}
                  <div className="ml-auto shrink-0">
                    <Barcode seed={c.code} className="text-foreground/25" />
                    <p className="mt-0.5 text-center font-mono text-[8px] tracking-[0.2em] text-muted-foreground/70">
                      {c.code}
                    </p>
                  </div>
                </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------- Create / edit ------------------------- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-3">
              {/* Same brand gradient as the dashboard hero band. */}
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#1E63DD_0%,#2C76ED_55%,#5B93F2_100%)] text-white shadow-[var(--shadow-soft)]">
                <Ticket className="size-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle>{editing ? "Edit coupon" : "New coupon"}</DialogTitle>
                <DialogDescription className="mt-0.5">
                  {editing
                    ? "Change how this code is presented and when it can be redeemed."
                    : "Customers type this code at checkout to get the discount."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Live preview of the offer as it's typed — the same headline the
              coupon card shows once saved, so the admin sees what they're
              building instead of a wall of inputs. */}
          {(form.percentOff.trim() !== "" || form.bonusMinutes.trim() !== "") && (
            <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary-tint to-primary-tint-soft px-4 py-3">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {form.code.trim() && (
                  <span className="mr-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-bold tracking-wide text-primary">
                    {form.code.trim()}
                  </span>
                )}
                {form.percentOff.trim() !== "" && (
                  <span className="text-xl font-bold tracking-tight text-primary">
                    {form.percentOff}% off
                  </span>
                )}
                {form.percentOff.trim() !== "" && form.bonusMinutes.trim() !== "" && (
                  <span className="text-sm text-muted-foreground">+</span>
                )}
                {form.bonusMinutes.trim() !== "" && (
                  <span className="text-xl font-bold tracking-tight text-primary">
                    {form.bonusMinutes} min
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                {describeDuration(Number(form.durationCycles) || 1)}
                {form.bonusMinutes.trim() !== "" ? " · minutes granted each cycle" : ""}
              </p>
            </div>
          )}

          {termsLocked && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {editing && editing.totalRedemptions > 0 ? (
                  <>
                    This coupon has been redeemed {editing.totalRedemptions} time(s), so its code,
                    discount and duration are locked — changing them would alter discounts already
                    running. Deactivate it and create a new code instead.
                  </>
                ) : (
                  <>
                    Someone is checking out with this coupon right now, so its code, discount and
                    duration are locked for a few minutes — they've already been shown these terms.
                    Try again shortly, or turn it off below to stop new redemptions.
                  </>
                )}
              </span>
            </div>
          )}

          <div className="space-y-5">
            <section className="space-y-3">
              <SectionHeading icon={Ticket} tone="blue">Code</SectionHeading>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={form.code}
                    disabled={termsLocked}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="LAUNCH30"
                    className="font-mono uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="displayName">Name shown to customers</Label>
                  <Input
                    id="displayName"
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    placeholder="Launch offer"
                  />
                </div>
              </div>
            </section>

            <section className="space-y-3 border-t border-border pt-5">
              <SectionHeading icon={BadgePercent} tone="violet">Discount</SectionHeading>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="percentOff">% off</Label>
                  <Input
                    id="percentOff"
                    type="number"
                    min={1}
                    max={100}
                    value={form.percentOff}
                    disabled={termsLocked}
                    onChange={(e) => setForm({ ...form, percentOff: e.target.value })}
                    placeholder="30"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bonusMinutes">Bonus minutes</Label>
                  <Input
                    id="bonusMinutes"
                    type="number"
                    min={1}
                    value={form.bonusMinutes}
                    disabled={termsLocked}
                    onChange={(e) => setForm({ ...form, bonusMinutes: e.target.value })}
                    placeholder="200"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="durationCycles">Billing cycles</Label>
                  <Input
                    id="durationCycles"
                    type="number"
                    min={1}
                    max={60}
                    value={form.durationCycles}
                    disabled={termsLocked}
                    onChange={(e) => setForm({ ...form, durationCycles: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cycles are charges, not months — a plan renews early when its minutes run out, so a
                2-cycle coupon covers the next 2 charges however quickly they happen.
              </p>
            </section>

            <section className="space-y-3 border-t border-border pt-5">
              <SectionHeading icon={CalendarDays} tone="sky">Redemption window</SectionHeading>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="startsAt">Redeemable from</Label>
                  <Input
                    id="startsAt"
                    type="date"
                    // A coupon can't have been redeemable before it existed, so a
                    // past start is meaningless. The only past date the picker
                    // offers is this coupon's own start, when it already opened —
                    // see minStartsAt.
                    min={minStartsAt}
                    value={form.startsAt}
                    onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="expiresAt">
                    Redeemable until <span className="text-danger">*</span>
                  </Label>
                  <Input
                    id="expiresAt"
                    required
                    type="date"
                    // Can't expire in the past, and can't land before it opens.
                    // An already-expired coupon keeps its stored date until the
                    // admin actually picks a new one.
                    min={form.startsAt && form.startsAt > TODAY ? form.startsAt : TODAY}
                    value={form.expiresAt}
                    onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The window for entering the code — leave the start blank to open it straight away.
                An end date is required so no code stays claimable forever; neither date ever cuts
                short a discount someone has already started.
              </p>
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <SectionHeading icon={Users} tone="amber">Limits</SectionHeading>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="maxRedemptions">Total redemptions</Label>
                  <span className="text-xs text-muted-foreground">Blank = unlimited</span>
                </div>
                <Input
                  id="maxRedemptions"
                  type="number"
                  min={1}
                  value={form.maxRedemptions}
                  onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
                  placeholder="Unlimited"
                />
              </div>

              {plans.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label>Limit to specific plans</Label>
                    <span className="text-xs text-muted-foreground">None = every plan</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {plans.map((p) => {
                      const on = form.planIds.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              planIds: on
                                ? form.planIds.filter((id) => id !== p.id)
                                : [...form.planIds, p.id],
                            })
                          }
                          className={cn(
                            "rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all",
                            on
                              ? "border-primary bg-primary text-primary-foreground shadow-[0_4px_12px_-4px_hsl(217_84%_55%/0.5)]"
                              : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-primary-tint-soft hover:text-foreground",
                          )}
                        >
                          {p.displayName}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-3 border-t border-border pt-5">
              <SectionHeading icon={SlidersHorizontal} tone="green">Behaviour</SectionHeading>
              <div className="card-glass divide-y divide-border rounded-xl border border-border shadow-[var(--shadow-soft)]">
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">New customers only</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Checked against plan history, so someone who cancelled and came back doesn't
                      count as new.
                    </p>
                  </div>
                  <Switch
                    checked={form.newCustomersOnly}
                    onCheckedChange={(v) => setForm({ ...form, newCustomersOnly: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">Active</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Turning this off stops new redemptions. Discounts already running continue.
                    </p>
                  </div>
                  <Switch
                    checked={form.active}
                    onCheckedChange={(v) => setForm({ ...form, active: v })}
                  />
                </div>
              </div>
            </section>
          </div>

          <DialogFooter className="border-t border-border pt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.code.trim() || !form.displayName.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create coupon"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------- Redemptions ------------------------- */}
      <Dialog open={!!redemptionsFor} onOpenChange={(v) => !v && setRedemptionsFor(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{redemptionsFor?.code} — redemptions</DialogTitle>
            <DialogDescription>
              Who has used this code, and how much of their discount is left.
            </DialogDescription>
          </DialogHeader>
          {redemptions === null ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
            </div>
          ) : redemptions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nobody has redeemed this code yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {redemptions.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.user.fullName || r.user.email}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.user.email}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge variant={r.status === "active" ? "success" : "neutral"}>
                      {r.status}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {r.cyclesUsed} of {redemptionsFor?.durationCycles} cycles
                      {r.grantedBy ? " · granted" : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        resourceType="coupon"
        resourceName={deleting?.code ?? ""}
        onConfirm={async () => {
          if (deleting) await remove(deleting);
        }}
      />
    </div>
  );
}
