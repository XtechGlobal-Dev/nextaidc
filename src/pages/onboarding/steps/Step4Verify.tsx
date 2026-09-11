import { useState } from "react";
import { ArrowRight, Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";
import { OnboardingShell, OnboardingNav } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { AgentCallPreview } from "@/components/onboarding/AgentCallPreview";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/ui/otp-input";
import { Label } from "@/components/ui/label";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { ApiError } from "@/lib/api";

export default function Step4Verify() {
  const email = useOnboardingStore((s) => s.data.email);
  const mobile = useOnboardingStore((s) => s.data.mobile);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const markAccountCreated = useOnboardingStore((s) => s.markAccountCreated);
  const setPassword = useOnboardingStore((s) => s.setPassword);
  const registerVerify = useAuthStore((s) => s.registerVerify);
  const resendSignupOtp = useAuthStore((s) => s.resendSignupOtp);

  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleVerify() {
    if (busy) return;
    if (otp.length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await registerVerify(email.trim(), otp);
      setPassword("");
      markAccountCreated();
      toast.success("Account verified 🎉");
      next();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setBusy(true);
    try {
      await resendSignupOtp(email.trim());
      toast.success("New code sent", {
        description: mobile.trim() ? `Check ${email.trim()} or your phone` : `Check ${email.trim()}`,
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not resend the code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingShell
      step={4}
      onBack={back}
      message={ONBOARDING_SPEECH.step4}
      aside={<AgentCallPreview scenario="email" />}
    >
      {/* Kept as a <form> for a11y, but it never natively submits — the button
          is type="button" and Enter is handled below — so GTM's form-submission
          listener never fires `gtm.formSubmit`. Only our own `sign_up` event
          goes out (from registerVerify). */}
      <form
        noValidate
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            void handleVerify();
          }
        }}
      >
        <div className="space-y-3 rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <div className="flex justify-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-primary-tint text-primary">
            <MailCheck className="size-5" />
          </div>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Enter the 6-digit code we sent to{" "}
          <span className="font-medium text-foreground">{email.trim()}</span>
          {mobile.trim() && (
            <>
              {" "}and texted to{" "}
              <span className="font-medium text-foreground">{mobile.trim()}</span>
            </>
          )}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="otp">Verification code</Label>
          <OtpInput
            id="otp"
            value={otp}
            onChange={(v) => {
              setOtp(v);
              if (error) setError("");
            }}
            autoFocus
          />
          {error && <p className="text-center text-xs text-danger">{error}</p>}
        </div>
        <button
          type="button"
          onClick={handleResend}
          disabled={busy}
          className="w-full text-center text-sm font-medium text-primary hover:underline disabled:opacity-50"
        >
          Resend code
        </button>
        </div>

        <OnboardingNav>
          <Button type="button" onClick={() => void handleVerify()} className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Verify &amp; continue <ArrowRight className="size-4" />
          </Button>
        </OnboardingNav>
      </form>
    </OnboardingShell>
  );
}
