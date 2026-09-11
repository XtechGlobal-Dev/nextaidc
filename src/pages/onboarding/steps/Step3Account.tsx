import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { OnboardingShell, OnboardingNav } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { AgentCallPreview } from "@/components/onboarding/AgentCallPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { PhoneInput } from "@/components/ui/phone-input";
import { phoneError } from "@/data/countries";
import { Label } from "@/components/ui/label";
import type { OnboardingData } from "@/stores/useOnboardingStore";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { ApiError } from "@/lib/api";
import { passwordError } from "@/pages/auth/authSchemas";

type FieldErrors = {
  fullName?: string;
  email?: string;
  mobile?: string;
  password?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Step3Account() {
  const data = useOnboardingStore((s) => s.data);
  const updateData = useOnboardingStore((s) => s.updateData);
  const password = useOnboardingStore((s) => s.password);
  const setPassword = useOnboardingStore((s) => s.setPassword);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const registerStart = useAuthStore((s) => s.registerStart);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const clearError = (key: keyof FieldErrors) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const validatedKeys: ReadonlyArray<keyof FieldErrors> = ["fullName", "email"];

  const set =
    (key: keyof OnboardingData) => (e: React.ChangeEvent<HTMLInputElement>) => {
      updateData({ [key]: e.target.value } as Partial<OnboardingData>);
      if (validatedKeys.includes(key as keyof FieldErrors)) {
        clearError(key as keyof FieldErrors);
      }
    };

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!data.fullName.trim()) next.fullName = "Please enter your name";
    if (!data.email.trim()) next.email = "Please enter your email address";
    else if (!EMAIL_RE.test(data.email.trim())) next.email = "Enter a valid email address";
    if (!data.mobile.trim()) next.mobile = "Please enter your phone number";
    else {
      const mobileErr = phoneError(data.mobile);
      if (mobileErr) next.mobile = mobileErr;
    }
    const pwErr = passwordError(password);
    if (pwErr) next.password = pwErr;
    return next;
  }

  async function handleCreate() {
    if (busy) return;
    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      await registerStart({
        email: data.email.trim(),
        password,
        fullName: data.fullName.trim(),
        businessName: data.businessName,
        mobile: data.mobile.trim() || undefined,
        businessNumber: data.phone.trim() || undefined,
        address: data.address.trim() || undefined,
        viaOnboarding: true,
      });
      toast.success("Verification code sent", {
        description: data.mobile.trim()
          ? `Check ${data.email.trim()} or your phone for your 6-digit code`
          : `Check ${data.email.trim()} for your 6-digit code`,
      });
      next();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create your account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingShell
      step={3}
      onBack={back}
      message={ONBOARDING_SPEECH.step3}
      aside={<AgentCallPreview scenario="sms" />}
    >
      {/* Kept as a <form> for autofill / password-manager support, but it never
          natively submits — the button is type="button" and Enter is handled
          below — so GTM's form-submission listener never fires `gtm.formSubmit`.
          Only our own `sign_up` event goes out (on OTP verify). */}
      <form
        noValidate
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            void handleCreate();
          }
        }}
      >
        <div className="space-y-3 rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <div className="space-y-1.5">
          <Label htmlFor="fullName">
            Your name <span className="text-danger">*</span>
          </Label>
          <Input
            id="fullName"
            type="text"
            autoComplete="name"
            value={data.fullName}
            onChange={set("fullName")}
            placeholder="Jane Smith"
            aria-invalid={!!errors.fullName}
            className={errors.fullName ? "border-danger focus-visible:focus-ring" : undefined}
          />
          {errors.fullName && <p className="text-xs text-danger">{errors.fullName}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">
            Email address <span className="text-danger">*</span>
          </Label>
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={data.email}
            onChange={set("email")}
            placeholder="you@business.com"
            aria-invalid={!!errors.email}
            className={errors.email ? "border-danger" : undefined}
          />
          {errors.email && <p className="text-xs text-danger">{errors.email}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mobile">
            Mobile number <span className="text-danger">*</span>
          </Label>
          <PhoneInput
            id="mobile"
            value={data.mobile}
            onChange={(val) => {
              updateData({ mobile: val });
              const mobile = phoneError(val) ?? undefined;
              setErrors((prev) => (prev.mobile === mobile ? prev : { ...prev, mobile }));
            }}
            placeholder="Your mobile number"
            aria-invalid={!!errors.mobile}
          />
          <p className="text-xs font-medium text-primary">This number will be used for SMS and WhatsApp notifications.</p>
          {errors.mobile && <p className="text-xs text-danger">{errors.mobile}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">
            Business number <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={data.phone}
            onChange={(e) => updateData({ phone: e.target.value.replace(/\D/g, "") })}
            placeholder="Support number customers call"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="address">
            Address <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="address"
            type="text"
            autoComplete="street-address"
            value={data.address}
            onChange={set("address")}
            placeholder="Business address"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">
            Password <span className="text-danger">*</span>
          </Label>
          <PasswordInput
            id="password"
            minLength={8}
            maxLength={40}
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearError("password");
            }}
            placeholder="8+ chars with upper, lower & a special character"
            aria-invalid={!!errors.password}
            className={errors.password ? "border-danger" : undefined}
          />
          {errors.password && <p className="text-xs text-danger">{errors.password}</p>}
        </div>
        </div>

        <OnboardingNav>
          <Button type="button" onClick={() => void handleCreate()} className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create account <ArrowRight className="size-4" />
          </Button>
        </OnboardingNav>
      </form>
    </OnboardingShell>
  );
}
