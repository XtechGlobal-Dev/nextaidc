import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Ban, Check, Info, Loader2, Percent, Ticket, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  ApiError,
  type CustomerCouponState,
  type GrantableCoupon,
} from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";

/** "30% off · +100 minutes" — whichever parts the coupon actually carries. */
function describeValue(c: {
  percentOff: number | null;
  bonusMinutes: number | null;
}): string {
  return (
    [
      c.percentOff ? `${c.percentOff}% off` : null,
      c.bonusMinutes ? `+${c.bonusMinutes} minutes` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "No value set"
  );
}

function describeDuration(cycles: number): string {
  return cycles === 1 ? "first charge only" : `first ${cycles} charges`;
}

/** A value pill — same visual language as the plan feature pills. */
function Pill({
  icon: Icon,
  children,
  tone = "muted",
}: {
  icon?: typeof Percent;
  children: React.ReactNode;
  tone?: "muted" | "primary";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "primary" ? "bg-primary-tint text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {children}
    </span>
  );
}

/**
 * One selectable coupon in the grant picker.
 *
 * Ineligible coupons are shown rather than hidden — "why can't I give them
 * this?" is the question an admin actually has, and hiding the row leaves it
 * unanswered. They're visibly inert (dimmed, no hover, radio removed) with the
 * server's reason underneath, so there's no ambiguity about what's clickable.
 */
function CouponOption({
  coupon,
  selected,
  onSelect,
}: {
  coupon: GrantableCoupon;
  selected: boolean;
  onSelect: () => void;
}) {
  const disabled = !coupon.eligible;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border/70 bg-muted/50"
          : selected
            ? "border-primary bg-primary-tint shadow-[var(--shadow-soft)]"
            : "border-border hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      {/* Radio affordance, matching the plan picker. Omitted when disabled —
          an empty circle on an unclickable row just invites a click. */}
      {!disabled && (
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            selected ? "border-primary bg-primary" : "border-border bg-transparent",
          )}
        >
          {selected && <Check className="size-3 text-primary-foreground" strokeWidth={3} />}
        </span>
      )}
      {disabled && <Ban className="mt-0.5 size-5 shrink-0 text-muted-foreground/70" />}

      <span className={cn("min-w-0 flex-1", disabled && "opacity-70")}>
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-sm font-bold tracking-wide">{coupon.code}</span>
          <span className="truncate text-sm text-muted-foreground">{coupon.displayName}</span>
        </span>

        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {coupon.percentOff && (
            <Pill icon={Percent} tone={disabled ? "muted" : "primary"}>
              {coupon.percentOff}% off
            </Pill>
          )}
          {coupon.bonusMinutes && (
            <Pill icon={Timer} tone={disabled ? "muted" : "primary"}>
              +{coupon.bonusMinutes} min
            </Pill>
          )}
          <Pill>{describeDuration(coupon.durationCycles)}</Pill>
        </span>

        {coupon.reason && (
          <span className="mt-2 flex items-start gap-1.5 border-t border-border/70 pt-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {coupon.reason}
          </span>
        )}
        {coupon.warning && (
          <span className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-tint px-2 py-1.5 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {coupon.warning}
          </span>
        )}
      </span>
    </button>
  );
}

/** Section heading inside the picker, separating what applies from what doesn't. */
function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Grant or remove a customer's coupon discount, from the admin customer page.
 *
 * Eligibility is resolved SERVER-side (`GET /customers/:id/coupon`) and merely
 * rendered here, so the option the admin sees and the rule the API enforces
 * can't drift apart. Every mutation re-checks on the server regardless — this
 * exists so the admin learns the answer before clicking, not after.
 */
export function CustomerDiscountCard({
  userId,
  customerName,
}: {
  userId: string;
  customerName: string;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission("coupons");
  const canEdit = hasPermission("coupons.edit");

  const [state, setState] = useState<CustomerCouponState | null>(null);
  const [failed, setFailed] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [selected, setSelected] = useState<GrantableCoupon | null>(null);
  /** Ticked to grant a coupon that breaks a rule normally enforced at checkout —
   *  expired, not started yet, or restricted to other plans. Cleared whenever the
   *  selection changes so consent can never carry over from a coupon the admin
   *  looked at and moved on from. */
  const [override, setOverride] = useState(false);
  const [releaseSlot, setReleaseSlot] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.admin.coupons.forCustomer(userId));
      setFailed(false);
    } catch {
      // A staff member without coupon rights simply doesn't get this card; any
      // other failure shouldn't take the rest of the customer page down either.
      setFailed(true);
    }
  }, [userId]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView || failed) return null;

  const discount = state?.discount ?? null;
  const coupons = state?.coupons ?? [];
  // Three groups, not two. A coupon the customer doesn't qualify for used to sit
  // at the top of the list looking like a normal choice, which reads as "the
  // system is offering me this" — the admin only found out it was wrong after
  // selecting it. It stays in the dialog (an admin may deliberately comp it, and
  // hiding it leaves "why isn't this listed?" unanswered) but below the ones
  // that genuinely apply, under its own heading.
  const available = coupons.filter((c) => c.eligible && !c.requiresOverride);
  const needsOverride = coupons.filter((c) => c.eligible && c.requiresOverride);
  const blocked = coupons.filter((c) => !c.eligible);
  const grantableCount = available.length + needsOverride.length;

  async function grant() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.admin.coupons.grant(userId, selected.id, override);
      toast.success(
        override
          ? `${selected.code} applied to ${customerName} — granted as an override`
          : `${selected.code} applied to ${customerName}`,
      );
      setGrantOpen(false);
      setSelected(null);
      setOverride(false);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't apply that coupon");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await api.admin.coupons.revoke(userId, releaseSlot);
      toast.success(
        res.releaseSlot
          ? "Discount removed — they can redeem this code again."
          : "Discount removed.",
      );
      setRemoveOpen(false);
      setReleaseSlot(false);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove the discount");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="mt-4 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Discount</h3>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGrantOpen(true)}
              disabled={!state}
            >
              <Ticket className="size-4" />
              {/* Swapping a small discount for a bigger one is a normal retention
                  move — don't force a remove-then-grant round trip for it. */}
              {discount ? "Replace coupon" : "Grant coupon"}
            </Button>
          )}
        </div>

        {!state ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : discount ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success-tint px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success text-white shadow-sm">
                <Ticket className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {discount.displayName}{" "}
                  <span className="font-mono text-xs font-normal text-muted-foreground">
                    ({discount.code})
                  </span>
                  {discount.grantedByAdmin && (
                    <Badge variant="neutral" className="ml-2 align-middle">
                      Granted
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {describeValue(discount)} —{" "}
                  {discount.cyclesLeft > 0
                    ? `${discount.cyclesLeft} of ${discount.durationCycles} charge${discount.durationCycles === 1 ? "" : "s"} left`
                    : "finished"}
                  {discount.appliedAt ? ` · applied ${formatDate(discount.appliedAt)}` : ""}
                </p>
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  onClick={() => setRemoveOpen(true)}
                >
                  <X className="size-4" /> Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Applies to renewals, not to a one-off upgrade charge. Replacing it with another
              coupon ends this one.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No discount on this account.
            {canEdit && grantableCount === 0 && coupons.length > 0 && (
              <> None of the active coupons can be granted to this customer right now.</>
            )}
            {canEdit && coupons.length === 0 && (
              <> No active coupons exist yet — create one on the Coupons page.</>
            )}
          </p>
        )}
      </Card>

      {/* ------------------------------ Grant ------------------------------ */}
      <Dialog
        open={grantOpen}
        onOpenChange={(v) => {
          if (v) return;
          setGrantOpen(false);
          setOverride(false);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{discount ? "Replace coupon" : "Grant a coupon"}</DialogTitle>
            <DialogDescription>
              Applies the discount to {customerName} immediately — they don't type a code. It
              counts as a redemption, exactly like one they'd entered themselves.
            </DialogDescription>
          </DialogHeader>

          {coupons.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-10 text-center">
              <Ticket className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No active coupons</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one on the Coupons page first.
              </p>
            </div>
          ) : grantableCount === 0 ? (
            /* Nothing can be granted. Lead with WHY and what to do about it —
               a bare "not available" divider with no section above it reads as
               a rendering mistake, and repeating the message below it is noise. */
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-tint px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning text-white shadow-sm">
                  <Ban className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    Nothing can be granted to {customerName} right now
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Every active coupon is blocked for this account — the reason is on each one
                    below. Create a new coupon if you need to give them something.
                  </p>
                  <Link
                    to="/dashboard/admin/coupons"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <Ticket className="size-3.5" /> Go to Coupons
                  </Link>
                </div>
              </div>

              {blocked.map((c) => (
                <CouponOption key={c.id} coupon={c} selected={false} onSelect={() => {}} />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {/* What genuinely applies, first — the admin should see what they
                  CAN do before anything that needs a decision or is off limits. */}
              {available.map((c) => (
                <CouponOption
                  key={c.id}
                  coupon={c}
                  selected={selected?.id === c.id}
                  onSelect={() => {
                    setSelected(c);
                    setOverride(false);
                  }}
                />
              ))}

              {needsOverride.length > 0 && (
                <>
                  <Divider>
                    {available.length === 0
                      ? `Doesn't apply to ${customerName} — grantable only as an override`
                      : "Only as an override"}
                  </Divider>
                  {needsOverride.map((c) => (
                    <CouponOption
                      key={c.id}
                      coupon={c}
                      selected={selected?.id === c.id}
                      onSelect={() => {
                        setSelected(c);
                        setOverride(false);
                      }}
                    />
                  ))}
                </>
              )}

              {blocked.length > 0 && (
                <>
                  <Divider>Not available for this customer</Divider>
                  {blocked.map((c) => (
                    <CouponOption key={c.id} coupon={c} selected={false} onSelect={() => {}} />
                  ))}
                </>
              )}
            </div>
          )}

          {selected?.requiresOverride && (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-warning/40 bg-warning-tint p-3">
              <Checkbox
                checked={override}
                onCheckedChange={(v) => setOverride(v === true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-medium">
                  Grant {selected.code} anyway — it breaks{" "}
                  {selected.restrictions.length > 1 ? "rules" : "a rule"} this customer
                  couldn&apos;t get past themselves
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {selected.warning}
                  {selected.windowEndsAt
                    ? ` (${
                        new Date(selected.windowEndsAt) <= new Date() ? "closed" : "opens"
                      } ${formatDate(selected.windowEndsAt)})`
                    : ""}{" "}
                  Granting it is recorded against your account. Change the coupon on the Coupons
                  page instead if it should be open to customers like this one.
                </span>
              </span>
            </label>
          )}

          {discount && selected && (
            <p className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This replaces their current {discount.code} discount, which ends immediately. They
              still won't be able to redeem {discount.code} again.
            </p>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setGrantOpen(false);
                setOverride(false);
              }}
            >
              Cancel
            </Button>
            {/* Nothing grantable → don't dangle a permanently dead primary
                button; the row reasons already explain why. */}
            {grantableCount > 0 && (
              <Button
                onClick={grant}
                disabled={busy || !selected || (selected.requiresOverride && !override)}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {!selected
                  ? "Choose one above"
                  : selected.requiresOverride && !override
                    ? "Confirm the override above"
                    : `Apply ${selected.code}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------ Remove ------------------------------ */}
      <Dialog open={removeOpen} onOpenChange={(v) => !v && setRemoveOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove discount</DialogTitle>
            <DialogDescription>
              {customerName} stops getting {discount ? discount.code : "this discount"} from their
              next charge. Charges already taken aren't affected.
            </DialogDescription>
          </DialogHeader>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
            <Checkbox
              checked={releaseSlot}
              onCheckedChange={(v) => setReleaseSlot(v === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              <span className="font-medium">Let them use this code again</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Tick this only if the coupon was granted by mistake — it deletes the record and
                returns the slot to the campaign. Left unticked, the code stays used up for this
                customer, which is right when they genuinely had the discount.
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Remove discount
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
