import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  DollarSign,
  Gauge,
  Layers,
  Loader2,
  Lock,
  Package,
  Pencil,
  PhoneCall,
  Plus,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { api, ApiError, BRAND_MODULES, isAddonEligible, type BrandAddon, type BrandModuleId, type BrandPlan, type BrandPlanInput } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { BrandAddonsDialog } from "./BrandAddonsDialog";

// Brand plans: what a BRAND pays the platform each month. Laid out exactly like the customer Plans page (cards
// + the same sectioned New plan dialog) so the two read as siblings — but it's a separate catalog: a brand
// plan is a price plus the modules it includes, and whatever it leaves out is sold as an add-on (priced under
// Add-ons). The plans a brand sells its own customers live under Plans and never appear here.

const CURRENCIES = ["usd", "aud"] as const;

interface FormState {
  name: string;
  description: string;
  price: string;
  currency: string;
  minuteLimit: string;
  aiLimit: string;
  sortOrder: string;
  features: BrandModuleId[];
  active: boolean;
  recommended: boolean;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  price: "50",
  currency: "usd",
  minuteLimit: "",
  aiLimit: "",
  sortOrder: "0",
  features: BRAND_MODULES.map((m) => m.id),
  active: true,
  recommended: false,
  isDefault: false,
};

function planToForm(p: BrandPlan): FormState {
  return {
    name: p.name,
    description: p.description,
    price: String(p.priceCents / 100),
    currency: p.currency,
    minuteLimit: p.monthlyMinuteLimit == null ? "" : String(p.monthlyMinuteLimit),
    aiLimit: p.monthlyAiLimit == null ? "" : String(p.monthlyAiLimit),
    sortOrder: String(p.sortOrder),
    features: p.features,
    active: p.active,
    recommended: p.recommended,
    isDefault: p.isDefault,
  };
}

/** A limit field's text as a cap: blank = none. */
function limitValue(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function AdminBrandPlansPage() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<BrandPlan[] | null>(null);
  const [addons, setAddons] = useState<BrandAddon[]>([]);
  const [addonsOpen, setAddonsOpen] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BrandPlan | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<BrandPlan | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.super.brandPlans.list(), api.super.brandAddons.list()])
      .then(([list, addonList]) => {
        if (!active) return;
        setPlans(list);
        setAddons(addonList);
      })
      .catch((e) => {
        toast.error(e instanceof ApiError ? e.message : "Failed to load brand plans");
        if (active) setPlans([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const addonFor = (id: BrandModuleId) => addons.find((a) => a.moduleId === id && a.active && a.priceCents);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }
  function openEdit(p: BrandPlan) {
    setEditing(p);
    setForm(planToForm(p));
    setDialogOpen(true);
  }

  async function submit() {
    if (form.name.trim().length < 2) {
      toast.error("Give the plan a name");
      return;
    }
    const dollars = parseFloat(form.price);
    if (Number.isNaN(dollars) || dollars < 0) {
      toast.error("Enter a valid price");
      return;
    }
    const payload: BrandPlanInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      priceCents: Math.round(dollars * 100),
      currency: form.currency,
      features: form.features,
      monthlyMinuteLimit: limitValue(form.minuteLimit),
      monthlyAiLimit: limitValue(form.aiLimit),
      sortOrder: Math.max(0, Math.floor(Number(form.sortOrder) || 0)),
      active: form.active,
      recommended: form.recommended,
      isDefault: form.isDefault,
    };
    setSaving(true);
    try {
      // Only one plan is the default — when this save sets it, the server clears the others; mirror that.
      const clearOtherDefaults = (list: BrandPlan[], keptId: string) =>
        payload.isDefault ? list.map((p) => (p.id === keptId ? p : { ...p, isDefault: false })) : list;
      if (editing) {
        const updated = await api.super.brandPlans.update(editing.id, payload);
        setPlans((prev) => clearOtherDefaults((prev ?? []).map((p) => (p.id === editing.id ? updated : p)), editing.id));
        toast.success(
          updated.brandCount
            ? `Plan updated — its ${updated.brandCount} brand${updated.brandCount === 1 ? "" : "s"} follow from their next invoice`
            : "Plan updated",
        );
      } else {
        const created = await api.super.brandPlans.create(payload);
        setPlans((prev) => clearOtherDefaults([...(prev ?? []), created], created.id));
        toast.success("Plan created");
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save plan");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    await api.super.brandPlans.remove(toDelete.id);
    setPlans((prev) => (prev ?? []).filter((p) => p.id !== toDelete.id));
    toast.success(`${toDelete.name} deleted`);
  }

  const inUse = !!editing && (editing.brandCount ?? 0) > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate("/dashboard/admin/brand-subscriptions")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Brand Subscriptions
      </button>

      <PageHeader
        title="Brand plans"
        subtitle="What brands pay the platform each month. Not the plans brands sell their customers — those are under Plans."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAddonsOpen(true)}>
              <Puzzle className="size-4" /> Add-ons
            </Button>
            <Button onClick={openCreate}>
              <Plus className="size-4" /> New plan
            </Button>
          </div>
        }
      />

      {plans === null ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} rows={5} />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <Layers className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No brand plans yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Create one — for example a $50/month plan — and brands requesting setup can pick it.
          </p>
          <Button className="mt-2" onClick={openCreate}>
            <Plus className="size-4" /> New plan
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const included = new Set(plan.features);
            return (
              <Card key={plan.id} className={cn("flex flex-col p-6", !plan.active && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                      <Layers className="size-5" />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold leading-tight">{plan.name}</h3>
                      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Users className="size-3" /> {plan.brandCount ?? 0} brand{plan.brandCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {plan.isDefault && <Badge variant="success">Default</Badge>}
                    {!plan.active && <Badge variant="neutral">Archived</Badge>}
                  </div>
                </div>
                {(plan.brandCount ?? 0) > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {plan.brandCount} brand{plan.brandCount === 1 ? "" : "s"} on it — currency locked
                  </p>
                )}

                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-2xl font-semibold tracking-tight">
                    {plan.priceCents ? `${formatMoney(plan.priceCents, plan.currency)} / month` : "Free"}
                  </span>
                </div>
                {plan.description && <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-tint px-2.5 py-1 text-xs font-semibold text-primary">
                    <PhoneCall className="size-3.5" />
                    {plan.monthlyMinuteLimit != null ? `${plan.monthlyMinuteLimit.toLocaleString()} min` : "Unlimited min"} / month
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <Sparkles className="size-3.5" />
                    {plan.monthlyAiLimit != null ? `${plan.monthlyAiLimit.toLocaleString()} AI interactions` : "Unlimited AI"}
                  </span>
                  {plan.recommended && <Badge variant="premium">Popular</Badge>}
                </div>

                {/* Every feature, in the catalog's order: in the price, sold as an add-on, or switched off. */}
                <ul className="mt-4 flex flex-1 flex-col gap-2">
                  {BRAND_MODULES.map((m) => {
                    const addon = addonFor(m.id);
                    return (
                      <li key={m.id} className="flex items-start gap-2 text-sm">
                        {included.has(m.id) ? (
                          <>
                            <Check className="mt-0.5 size-4 shrink-0 text-success" />
                            <span>{m.label}</span>
                          </>
                        ) : addon ? (
                          <>
                            <Plus className="mt-0.5 size-4 shrink-0 text-primary" />
                            <span>
                              {m.label}{" "}
                              <span className="text-muted-foreground">
                                — add-on {formatMoney(addon.priceCents ?? 0, plan.currency)}/mo
                              </span>
                            </span>
                          </>
                        ) : (
                          <>
                            <X className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                            <span className="text-muted-foreground/70 line-through">{m.label}</span>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-6 flex gap-2 border-t border-border pt-4">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(plan)}>
                    <Pencil className="size-4" /> Edit
                  </Button>
                  {/* A plan brands are on is archived (Active off), not deleted. */}
                  {!plan.brandCount && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:bg-danger-tint hover:text-danger"
                      onClick={() => setToDelete(plan)}
                      aria-label={`Delete ${plan.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog — same shape as the customer plan dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle>{editing ? "Edit brand plan" : "New brand plan"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update this plan's details." : "Define a plan brands pay the platform each month."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
            {/* Plan basics */}
            <section className="space-y-5">
              <SectionHeading icon={<Package className="size-3.5" />}>Plan basics</SectionHeading>
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                <Field label="Name" htmlFor="bp-name" hint="Shown to brands on the request form.">
                  <Input
                    id="bp-name"
                    placeholder="Starter"
                    maxLength={60}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </Field>
                <Field label="Sort order" htmlFor="bp-sort" hint="0, 1, 2… — lower is shown first.">
                  <Input
                    id="bp-sort"
                    type="number"
                    min={0}
                    step={1}
                    value={form.sortOrder}
                    onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value.replace(/[^0-9]/g, "") }))}
                  />
                </Field>
              </div>
              <Field label="Description" htmlFor="bp-desc">
                <Input
                  id="bp-desc"
                  placeholder="Short one-line summary"
                  maxLength={500}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </Field>
            </section>

            {/* Pricing & usage */}
            <section className="space-y-5">
              <SectionHeading icon={<DollarSign className="size-3.5" />}>Pricing &amp; usage</SectionHeading>
              {inUse && (
                <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-tint px-3.5 py-2.5 text-xs text-foreground">
                  <Lock className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>
                    {editing!.brandCount} brand{editing!.brandCount === 1 ? " is" : "s are"} on this plan, so its
                    currency is locked. Price, features and limits can still change — those brands follow from
                    their next invoice.
                  </span>
                </div>
              )}
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-3">
                <Field label={`Price (${form.currency.toUpperCase()})`} htmlFor="bp-price">
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-muted-foreground">
                      $
                    </span>
                    <Input
                      id="bp-price"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="50"
                      value={form.price}
                      onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                      className="pl-7"
                    />
                  </div>
                </Field>
                <Field label="Currency" htmlFor="bp-currency">
                  <Select
                    value={form.currency}
                    onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
                    disabled={inUse}
                  >
                    <SelectTrigger id="bp-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Billing interval" htmlFor="bp-interval">
                  {/* Brand plans renew monthly — shown for parity with customer plans. */}
                  <Select value="month" disabled>
                    <SelectTrigger id="bp-interval">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="month">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                <Field
                  label="Call minutes / month"
                  htmlFor="bp-minutes"
                  hint="Across all the brand's customers. Blank = unlimited."
                >
                  <div className="relative">
                    <Input
                      id="bp-minutes"
                      type="number"
                      min={0}
                      step="1"
                      placeholder="Unlimited"
                      value={form.minuteLimit}
                      onChange={(e) => setForm((f) => ({ ...f, minuteLimit: e.target.value }))}
                      className="pr-12"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-muted-foreground">
                      min
                    </span>
                  </div>
                </Field>
                <Field
                  label="AI interactions / month"
                  htmlFor="bp-ai"
                  hint="Calls, AI texts, WhatsApp replies and booking actions. Blank = unlimited."
                >
                  <div className="relative">
                    <Input
                      id="bp-ai"
                      type="number"
                      min={0}
                      step="1"
                      placeholder="Unlimited"
                      value={form.aiLimit}
                      onChange={(e) => setForm((f) => ({ ...f, aiLimit: e.target.value }))}
                      className="pr-10"
                    />
                    <Gauge className="pointer-events-none absolute right-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </Field>
              </div>
            </section>

            {/* Features & visibility */}
            <section className="space-y-5">
              <SectionHeading icon={<SlidersHorizontal className="size-3.5" />}>Features &amp; visibility</SectionHeading>
              <p className="-mt-2 text-xs text-muted-foreground">
                On = included in the price. Off = sold as an add-on at its price under Add-ons, or not offered when
                it has none. SMS to Caller and WhatsApp are default features — on free, or off, never an add-on.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {BRAND_MODULES.map((m) => {
                  const on = form.features.includes(m.id);
                  const eligible = isAddonEligible(m.id);
                  const addon = addonFor(m.id);
                  return (
                    <ToggleCard
                      key={m.id}
                      title={m.label}
                      desc={
                        on
                          ? "Included in the price."
                          : !eligible
                            ? "Switched off for this plan — not sold as an add-on."
                            : addon
                              ? `Add-on · ${formatMoney(addon.priceCents ?? 0, form.currency)}/mo`
                              : "Not offered — no add-on price."
                      }
                      checked={on}
                      onChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          features: v ? [...f.features, m.id] : f.features.filter((x) => x !== m.id),
                        }))
                      }
                    />
                  );
                })}
                <ToggleCard
                  title="Active"
                  desc="Offered to new brands. Archived plans stay on their brands."
                  checked={form.active}
                  // An archived plan can't be the default — turning Active off clears Default too.
                  onChange={(v) => setForm((f) => ({ ...f, active: v, isDefault: v ? f.isDefault : false }))}
                />
                <ToggleCard
                  title="Recommended"
                  desc="Highlighted as “Popular” on the request form."
                  checked={form.recommended}
                  onChange={(v) => setForm((f) => ({ ...f, recommended: v }))}
                />
                <ToggleCard
                  title="Default plan"
                  desc={form.active ? "Pre-selected on the request form and in the wizard." : "Activate this plan to make it the default."}
                  checked={form.isDefault}
                  disabled={!form.active}
                  onChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
                />
              </div>
            </section>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="brand plan"
        resourceName={toDelete?.name ?? ""}
        onConfirm={confirmDelete}
        description="No brand is on it, so nothing else changes. To stop offering a plan brands use, archive it instead."
      />

      <BrandAddonsDialog open={addonsOpen} onOpenChange={setAddonsOpen} onSaved={setAddons} />
    </div>
  );
}

// The three form helpers below match AdminPlansPage's, so the two dialogs look the same.

/** Small uppercase section label (with icon) used to group the plan form fields. */
function SectionHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">{icon}</span>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A labelled form field: label → control → optional hint. */
function Field({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-2 block leading-snug">
        {label}
      </Label>
      {children}
      {hint && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A bordered on/off row; highlights when enabled. */
function ToggleCard({
  title,
  desc,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        checked ? "border-primary/40 bg-primary-tint-soft" : "border-border",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={title} />
    </div>
  );
}
