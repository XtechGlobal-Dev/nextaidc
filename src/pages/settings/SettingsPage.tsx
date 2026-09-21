import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  Check,
  Crown,
  ExternalLink,
  FileText,
  Mail,
  PhoneCall,
  Sparkles,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ProgressBar, StatusPill } from "@/components/ui/misc";
import { clamp, cn, formatDateDMY } from "@/lib/utils";
import { env } from "@/lib/env";
import { intervalLabel } from "@/lib/billingInterval";
import { api, ApiError, type Invoice, type SubscriptionDetail, type SubscriptionPlan } from "@/lib/api";
import { useStripePortal } from "@/hooks/useStripePortal";
import { FREE_PLAN_MINUTES, useProfileStore } from "@/stores/useProfileStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { PhoneInput } from "@/components/ui/phone-input";
import { phoneError } from "@/data/countries";
import { SettingsRow } from "./SettingsRow";
import { hasCustomerWorkspace, isAdminRole } from "@/lib/roles";

// Support contact details (no backend field — maintained here).


// Premium feature list — fallback when plan features can't load.

const PREMIUM_FEATURES_FALLBACK = [
  "SMS follow-ups after every call",
  "Premium, natural-sounding voices",
  "+300 minutes every month",
  "Priority support",
  "Calendar integration & bookings",
  "Personal account manager",
] as const;

export default function SettingsPage() {
  const profile = useProfileStore((s) => s.profile);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const isPremium = useProfileStore((s) => s.isPremium());
  const calls = useCallsStore((s) => s.calls);
  const isAdmin = useAuthStore((s) => isAdminRole(s.user?.role));
  // No customer workspace (STAFF, SUPER_ADMIN) → no profile/usage/plan, but they still change their password here.
  const platformOnly = useAuthStore((s) => !hasCustomerWorkspace(s.user?.role));
  // Full Name lives on the User, not the Profile — falling back here is what fixed the admin's blank name.
  const authFullName = useAuthStore((s) => s.user?.fullName ?? "");

  // Empty id = not yet hydrated. Platform-only accounts have no Profile row, so never
  // block them on the skeleton — it would hang forever.
  if (!platformOnly && !profile.id) {
    return <PageSkeleton variant="form" />;
  }

  return (
    <div>
      <PageHeader
        title="Account Settings"
        subtitle={
          platformOnly
            ? "Manage your account security."
            : "Manage your profile, plan and support options."
        }
      />

      <div className="grid w-full grid-cols-1 items-start gap-6 lg:grid-cols-2">
        {/* No customer profile (business/mobile/plan) to edit here — these
            accounts only need to change their password. */}
        {!platformOnly && (
          <ProfileCard
            className="lg:col-span-2"
            fullName={profile.fullName || authFullName}
            email={profile.email}
            mobile={profile.mobile}
            onSave={updateProfile}
          />
        )}

        <PasswordCard className="lg:col-span-2" />

        {!isAdmin && !platformOnly && <UsageCard className="h-full" calls={calls} />}

        {!isAdmin && !platformOnly && (
          <SubscriptionCard
            className="h-full"
            isPremium={isPremium}
            isAdmin={isAdmin}
          />
        )}

        <SupportCard className="lg:col-span-2" />
      </div>
    </div>
  );
}

// 1. Profile

function ProfileCard({
  className,
  fullName,
  email,
  mobile,
  onSave,
}: {
  className?: string;
  fullName: string;
  email: string;
  mobile: string;
  // Business Name is managed in the AI Brain (Identity), so it's not part of
  // this form.
  onSave: (patch: { fullName: string; email: string; mobile: string }) => void;
}) {
  const [form, setForm] = useState({ fullName, email, mobile });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  };

  const handleSave = () => {
    const next: Record<string, string> = {};
    if (!form.fullName.trim()) next.fullName = "Full name is required.";
    if (!form.email.trim()) next.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = "Enter a valid email address.";
    if (!form.mobile.trim()) next.mobile = "Mobile number is required.";
    else {
      const mobileErr = phoneError(form.mobile);
      if (mobileErr) next.mobile = mobileErr;
    }
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({});
    onSave(form);
    toast.success("Profile saved");
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your account and contact details.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Full Name *" htmlFor="fullName">
          <Input id="fullName" value={form.fullName} onChange={set("fullName")} aria-invalid={!!errors.fullName} />
          {errors.fullName && <p className="text-xs text-danger">{errors.fullName}</p>}
        </Field>

        <Field label="Email *" htmlFor="email">
          <Input id="email" type="email" value={form.email} onChange={set("email")} aria-invalid={!!errors.email} />
          {errors.email && <p className="text-xs text-danger">{errors.email}</p>}
        </Field>

        <Field
          label="Mobile Number *"
          htmlFor="mobile"
          note="This number will be used for SMS and WhatsApp notifications."
        >
          <PhoneInput
            id="mobile"
            value={form.mobile}
            onChange={(val) => { setForm((f) => ({ ...f, mobile: val })); setErrors((prev) => ({ ...prev, mobile: phoneError(val) ?? "" })); }}
            placeholder="Your mobile number"
            aria-invalid={!!errors.mobile}
          />
          {errors.mobile && <p className="text-xs text-danger">{errors.mobile}</p>}
        </Field>

        <div className="sm:col-span-2 flex justify-end">
          <Button onClick={handleSave}>Save Profile</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// 2. Change Password

function PasswordCard({ className }: { className?: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const handleUpdate = async () => {
    if (!current || !next || !confirm) {
      toast.error("Please fill in all password fields.");
      return;
    }
    if (next.length < 8) {
      toast.error("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      toast.error("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Change Password</CardTitle>
        <CardDescription>Keep your account secure.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <Field label="Current Password" htmlFor="currentPassword">
          <PasswordInput
            id="currentPassword"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New Password" htmlFor="newPassword">
            <PasswordInput
              id="newPassword"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p
              className={cn(
                "text-xs",
                next && next.length < 8 ? "text-danger" : "text-muted-foreground",
              )}
            >
              At least 8 characters.
            </p>
          </Field>
          <Field label="Confirm New Password" htmlFor="confirmPassword">
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {confirm && next !== confirm && (
              <p className="text-xs text-danger">Passwords don't match yet.</p>
            )}
          </Field>
        </div>

        <div className="mt-auto flex justify-end">
          <Button onClick={handleUpdate} disabled={busy}>
            {busy ? "Updating…" : "Update Password"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// 3. This Month's Usage

function UsageCard({
  className,
  calls,
}: {
  className?: string;
  calls: { durationSec: number; createdAt: string }[];
}) {
  const trial = useTrialStore((s) => s.trial);

  // Use entitlement data when available (real-time, authoritative), else fall back to call logs.
  const { callsHandled, minutesUsed, allocated, percent } = useMemo(() => {
    const now = new Date();
    const thisMonth = calls.filter((c) => {
      const d = new Date(c.createdAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const callCount = thisMonth.length > 0 ? thisMonth.length : calls.length;

    if (trial && (trial.phase === "trial" || trial.phase === "active")) {
      const alloc = trial.unlimited ? 0 : trial.minutesAllocated;
      const pct = alloc > 0 ? clamp((trial.minutesUsed / alloc) * 100, 0, 100) : 0;
      return {
        callsHandled: callCount,
        minutesUsed: trial.minutesUsed,
        allocated: alloc,
        percent: pct,
      };
    }

    const source = thisMonth.length > 0 ? thisMonth : calls;
    const minutes = source.reduce((sum, c) => sum + c.durationSec, 0) / 60;
    return {
      callsHandled: source.length,
      minutesUsed: minutes,
      allocated: FREE_PLAN_MINUTES,
      percent: clamp((minutes / FREE_PLAN_MINUTES) * 100, 0, 100),
    };
  }, [calls, trial]);

  const label = trial?.phase === "trial" ? "Trial" : trial?.phase === "active" ? "Plan" : "Free";
  const unlimitedPlan = trial?.unlimited;

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Calls & Usage
        </CardTitle>
        <CardDescription>
          {unlimitedPlan
            ? "You have unlimited minutes."
            : `Tracked against your ${label.toLowerCase()} allowance.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Stat icon={PhoneCall} label="Calls handled" value={String(callsHandled)} />
          <Stat
            icon={Timer}
            label="Minutes used"
            value={unlimitedPlan ? `${minutesUsed.toFixed(1)}` : `${minutesUsed.toFixed(1)} / ${allocated}`}
          />
        </div>

        {!unlimitedPlan && (
          <div className="mt-auto flex flex-col gap-2">
            <ProgressBar
              value={Math.min(percent, 100)}
              barClassName={percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warning" : "bg-primary"}
            />
            <p className="text-xs text-muted-foreground">
              {percent.toFixed(0)}% of your {allocated} {label.toLowerCase()} minutes consumed.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 4. Subscription

function SubscriptionCard({
  className,
  isPremium,
  isAdmin,
}: {
  className?: string;
  isPremium: boolean;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const trial = useTrialStore((s) => s.trial);
  const [features, setFeatures] = useState<readonly string[]>(PREMIUM_FEATURES_FALLBACK);
  const [subDetail, setSubDetail] = useState<SubscriptionDetail | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const { open: handleManageBilling, busy: portalBusy } = useStripePortal();

  useEffect(() => {
    let active = true;
    api.billing.plans().then((plans) => {
      if (!active) return;
      const best = plans.find((p) => p.recommended) ?? plans.find((p) => /premium/i.test(p.name)) ?? plans[0] as SubscriptionPlan | undefined;
      if (best?.features?.length) setFeatures(best.features);
    }).catch(() => {});
    api.billing.subscription().then(({ subscription }) => {
      if (active && subscription) setSubDetail(subscription);
    }).catch(() => {});
    api.billing.invoices().then(({ invoices: inv }) => {
      if (active) setInvoices(inv);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const hasSubscription = isPremium || trial?.phase === "trial" || trial?.phase === "active";
  const planName = subDetail?.planName ?? trial?.planName ?? (isPremium ? "Premium" : "Free");
  const statusLabel = trial?.isTrial ? "Trial" : trial?.phase === "active" ? "Active" : subDetail?.status ?? "none";

  const money = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  return (
    <Card className={cn(hasSubscription && "border-premium/40", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {hasSubscription ? (
              <>
                <Crown className="size-4 text-premium" />
                {planName} Plan
              </>
            ) : (
              "Free Plan"
            )}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {subDetail?.legacy && <Badge variant="warning">Legacy</Badge>}
            {hasSubscription ? (
              <Badge variant="premium">
                <Crown className="size-3" />
                {statusLabel}
              </Badge>
            ) : (
              <StatusPill label="No Plan" tone="neutral" />
            )}
          </div>
        </div>
        {subDetail && (
          <CardDescription>
            {money(subDetail.priceCents)}/{intervalLabel(subDetail.interval, subDetail.intervalCount)}
            {subDetail.includedMinutes > 0 && ` — ${subDetail.includedMinutes} min included`}
            {subDetail.includedMinutes === 0 && subDetail.priceCents > 0 && ` — Unlimited minutes`}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {hasSubscription ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-premium-tint p-4 text-premium">
            <Sparkles className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {trial?.isTrial ? `Free trial — ${trial.daysRemaining} days left` : `You're on ${planName}`}
              </p>
              {subDetail?.currentPeriodEnd && !trial?.isTrial && (
                <p className="text-xs opacity-90">
                  Renews {formatDateDMY(subDetail.currentPeriodEnd)}
                </p>
              )}
              {trial?.isTrial && subDetail?.trialEndsAt && (
                <p className="text-xs opacity-90">
                  Trial ends {formatDateDMY(subDetail.trialEndsAt)}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-[var(--radius-card)] border border-border bg-warm p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="size-4 text-premium" />
              <p className="text-sm font-semibold">Choose a Plan</p>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-success-tint text-success">
                    <Check className="size-3" />
                  </span>
                  <span className="text-muted-foreground">{feature}</span>
                </li>
              ))}
            </ul>
            <Button className="mt-4 w-full" onClick={() => navigate("/subscribe")}>
              <Crown className="size-4" />
              Choose a Plan
            </Button>
          </div>
        )}

        {/* Pending downgrade notice */}
        {subDetail?.scheduledPlan && (
          <div className="rounded-[var(--radius-card)] border border-warning/40 bg-warning-tint px-3 py-2 text-xs">
            Downgrade scheduled: you keep <strong>{subDetail.planName}</strong> until{" "}
            <strong>
              {subDetail.scheduledPlan.effectiveAt
                ? formatDateDMY(subDetail.scheduledPlan.effectiveAt)
                : "period end"}
            </strong>
            , then move to <strong>{subDetail.scheduledPlan.name}</strong>. Manage it on the Plans page.
          </div>
        )}

        {/* Billing portal + plan management */}
        {!isAdmin && hasSubscription && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleManageBilling} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage Billing"}
            </Button>
          </div>
        )}

        {/* Invoice history */}
        {invoices.length > 0 && (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <FileText className="size-4" /> Recent Invoices
            </h4>
            <div className="divide-y divide-border rounded-lg border border-border">
              {invoices.slice(0, 5).map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{inv.number ?? inv.id.slice(0, 16)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatDateDMY(inv.created * 1000)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill
                      label={inv.status === "paid" ? "Paid" : inv.status === "open" ? "Open" : inv.status ?? "—"}
                      tone={inv.status === "paid" ? "success" : "neutral"}
                    />
                    <span className="tabular-nums">{money(inv.amountPaid || inv.amountDue)}</span>
                    {inv.hostedInvoiceUrl && (
                      <a
                        href={inv.hostedInvoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 6. Support Centre

function SupportCard({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Support Centre</CardTitle>
        <CardDescription>We&apos;re here whenever you need a hand.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <SettingsRow
          icon={BookOpen}
          label="Documentation"
          description="Guides, FAQs and best practices"
          href={`https://www.${env.appName}/#faq`}
          external
        />
        <SettingsRow
          icon={Mail}
          label="Email support"
          description={env.supportEmail}
          href={`mailto:${env.supportEmail}`}
        />
      </CardContent>
    </Card>
  );
}

// Shared small pieces

function Field({
  label,
  htmlFor,
  note,
  children,
}: {
  label: string;
  htmlFor: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight">{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
