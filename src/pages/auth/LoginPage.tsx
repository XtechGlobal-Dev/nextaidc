import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PhoneCall, Loader2, ArrowLeft, MailCheck, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { OtpInput } from "@/components/ui/otp-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { ApiError } from "@/lib/api";
import { onboardingRedirectPath } from "@/lib/onboardingRoute";
import { env } from "@/lib/env";
import { NAME_MAX } from "@/lib/limits";
import { toast } from "sonner";
import {
  loginSchema,
  registerSchema,
  forgotSchema,
  resetSchema,
  otpSchema,
  fieldErrors,
  type FieldErrors,
} from "./authSchemas";

type Screen = "login" | "register" | "verify-signup" | "forgot" | "reset";

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-danger">{msg}</p>;
}

const COPY: Record<Screen, { title: string; subtitle: string }> = {
  login: { title: "Welcome back", subtitle: "Sign in to your AI receptionist dashboard" },
  register: { title: "Create your account", subtitle: "Set up your 24/7 AI receptionist" },
  "verify-signup": { title: "Verify your email", subtitle: "Enter the 6-digit code we just sent you" },
  forgot: { title: "Reset your password", subtitle: "We'll email you a code to reset it" },
  reset: { title: "Set a new password", subtitle: "Enter the code we sent and choose a new password" },
};

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const registerStart = useAuthStore((s) => s.registerStart);
  const registerVerify = useAuthStore((s) => s.registerVerify);
  const resendSignupOtp = useAuthStore((s) => s.resendSignupOtp);
  const forgotPassword = useAuthStore((s) => s.forgotPassword);
  const resetPassword = useAuthStore((s) => s.resetPassword);
  const status = useAuthStore((s) => s.status);
  const loadMe = useAuthStore((s) => s.loadMe);
  const suspendedNotice = useAuthStore((s) => s.suspendedNotice);
  const clearSuspendedNotice = useAuthStore((s) => s.clearSuspendedNotice);
  const resetOnboarding = useOnboardingStore((s) => s.reset);
  // Brand door (null on the platform's own). A brand may close self-serve sign-up; the platform
  // door takes no sign-ups at all (every customer is some brand's), so it reads closed once branding loads.
  const brand = useBrandingStore((s) => s.brand);
  const brandLoaded = useBrandingStore((s) => s.loaded);
  const inviteOnly = brand ? brand.signupMode === "invite" : brandLoaded;

  // Keep /login out of search results (vercel.json X-Robots-Tag covers prod; this covers dev/non-Vercel). Removed on unmount so it doesn't leak to other routes.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, follow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Show a clear "account suspended" notice — either because the session was
  // ended by an admin suspension, or a login attempt was rejected for the same.
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    if (suspendedNotice) setSuspended(true);
  }, [suspendedNotice]);

  // New users sign up from the landing page, which captures the website + voice.
  function startSignup() {
    resetOnboarding();
    navigate("/");
  }

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const clearError = (field: string) =>
    setErrors((e) => (e[field] ? { ...e, [field]: "" } : e));

  // Existing session (e.g. another tab) → resolve and bounce; never show the form to an authed user.
  useEffect(() => {
    if (status === "idle") void loadMe();
  }, [status, loadMe]);
  useEffect(() => {
    if (status === "authed") {
      navigate(onboardingRedirectPath(useAuthStore.getState().user), { replace: true });
    }
  }, [status, navigate]);

  const [screen, setScreen] = useState<Screen>("login");
  const [form, setForm] = useState({
    email: "",
    password: "",
    fullName: "",
    businessName: "",
    otp: "",
    newPassword: "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    clearError(k);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  function goTo(next: Screen) {
    setScreen(next);
    setErrors({});
    setSuspended(false);
    clearSuspendedNotice();
  }

  /** Run an async auth action with the busy flag + a friendly error toast. */
  async function runBusy(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // After auth, resume onboarding where the user left off (or go to the dashboard
  // if they've finished / signed up directly).
  function routeAfterAuth(message: string) {
    toast.success(message);
    const user = useAuthStore.getState().user;
    const path = onboardingRedirectPath(user);
    if (path === "/onboarding") {
      const ob = useOnboardingStore.getState();
      ob.markAccountCreated();
      // Sign-out wiped the client-only onboarding cache; rebuild it from the profile or the
      // resumed steps come up empty (and the website guard can loop).
      const p = user?.profile;
      if (p) {
        const website = p.website?.trim() ?? "";
        ob.updateData({
          businessName: p.businessName ?? "",
          fullName: p.fullName ?? user?.fullName ?? "",
          email: p.email ?? user?.email ?? "",
          mobile: p.mobile ?? "",
          phone: p.businessNumber ?? "",
          address: p.address ?? "",
          url: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : "",
        });
        // No website on file → mark the website/analysis steps resolved so the
        // resume never re-runs analysis or bounces back to the landing page.
        if (!website) useOnboardingStore.setState({ skippedWebsite: true, analyzed: true });
      }
      if (p?.onboardingStep) ob.goTo(p.onboardingStep);
    }
    navigate(path, { replace: true });
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    const parsed = loginSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await login(parsed.data.email, parsed.data.password);
      setSuspended(false);
      clearSuspendedNotice();
      routeAfterAuth("Welcome back");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.details === "account_suspended") {
        setSuspended(true);
        toast.error("Your account has been suspended");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitRegisterStart(e: React.FormEvent) {
    e.preventDefault();
    const parsed = registerSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    const { email, password, fullName, businessName } = parsed.data;
    if (await runBusy(() => registerStart({ email, password, fullName, businessName: businessName || undefined }))) {
      setForm((f) => ({ ...f, otp: "" }));
      setScreen("verify-signup");
      toast.success("Verification code sent", { description: `Check ${email} for your 6-digit code` });
    }
  }

  async function submitVerifySignup(e: React.FormEvent) {
    e.preventDefault();
    const parsed = otpSchema.safeParse({ code: form.otp });
    if (!parsed.success) return setErrors({ otp: fieldErrors(parsed.error).code });
    setErrors({});
    if (await runBusy(() => registerVerify(form.email, form.otp))) routeAfterAuth("Account created");
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    const parsed = forgotSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    if (await runBusy(() => forgotPassword(parsed.data.email))) {
      setForm((f) => ({ ...f, otp: "", newPassword: "" }));
      setScreen("reset");
      toast.success("Reset code sent", {
        description: `Check ${parsed.data.email} for your 6-digit code.`,
      });
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    const parsed = resetSchema.safeParse({ code: form.otp, newPassword: form.newPassword });
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error);
      return setErrors({ otp: errs.code, newPassword: errs.newPassword });
    }
    setErrors({});
    if (await runBusy(() => resetPassword(form.email, form.otp, form.newPassword)))
      routeAfterAuth("Password updated");
  }

  async function resendSignup() {
    if (await runBusy(() => resendSignupOtp(form.email)))
      toast.success("New code sent", { description: `Check ${form.email}` });
  }

  // While resolving an existing session (or about to redirect), show a spinner
  // instead of flashing the login form.
  if (status === "idle" || status === "loading" || status === "authed") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary-tint-soft to-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const copy =
    screen === "login" && brand && (brand.loginHeadline || brand.loginBlurb)
      ? {
          title: brand.loginHeadline || COPY.login.title,
          subtitle: brand.loginBlurb || COPY.login.subtitle,
        }
      : COPY[screen];

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary-tint-soft to-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BrandLogo imgClassName="h-12 w-auto max-w-[200px] object-contain">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
              <PhoneCall className="size-6" />
            </div>
          </BrandLogo>
        </div>

        <Card className="overflow-hidden">
          {/* gradient top accent */}
          <div className="h-1.5 w-full bg-gradient-to-r from-primary to-[#1d4ed8]" />
          <CardContent className="pt-6">
            <div className="mb-5 text-center">
              <h1 className="text-2xl font-bold">{copy.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{copy.subtitle}</p>
            </div>

            {screen === "login" && suspended && (
              <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-tint px-3.5 py-3 text-sm text-danger">
                <Ban className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-semibold">Your account has been suspended</p>
                  <p className="mt-0.5 text-danger/90">
                    An administrator has suspended this account, so you can't sign in. Please contact{" "}
                    {env.supportEmail} if you think this is a mistake.
                  </p>
                </div>
              </div>
            )}

            {screen === "login" ? (
              <form onSubmit={submitLogin} noValidate className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={set("email")}
                    aria-invalid={!!errors.email}
                    className={errors.email ? "border-danger" : ""}
                  />
                  <FieldError msg={errors.email} />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <button
                      type="button"
                      onClick={() => goTo("forgot")}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <PasswordInput
                    id="password"
                    value={form.password}
                    onChange={set("password")}
                    aria-invalid={!!errors.password}
                    className={errors.password ? "border-danger" : ""}
                  />
                  <FieldError msg={errors.password} />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Sign In
                </Button>
              </form>
            ) : screen === "register" ? (
              <form onSubmit={submitRegisterStart} noValidate className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="fullName">Full Name</Label>
                  <Input
                    id="fullName"
                    value={form.fullName}
                    onChange={set("fullName")}
                    aria-invalid={!!errors.fullName}
                    className={errors.fullName ? "border-danger" : ""}
                  />
                  <FieldError msg={errors.fullName} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="businessName">Business Name</Label>
                  <Input id="businessName" maxLength={NAME_MAX} value={form.businessName} onChange={set("businessName")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={set("email")}
                    aria-invalid={!!errors.email}
                    className={errors.email ? "border-danger" : ""}
                  />
                  <FieldError msg={errors.email} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <PasswordInput
                    id="password"
                    value={form.password}
                    onChange={set("password")}
                    aria-invalid={!!errors.password}
                    className={errors.password ? "border-danger" : ""}
                  />
                  {errors.password ? (
                    <FieldError msg={errors.password} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      8+ characters with uppercase, lowercase &amp; a special character
                    </p>
                  )}
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Create Account
                </Button>
              </form>
            ) : screen === "verify-signup" ? (
              <form onSubmit={submitVerifySignup} noValidate className="space-y-3">
                <div className="flex justify-center">
                  <div className="flex size-11 items-center justify-center rounded-full bg-primary-tint text-primary">
                    <MailCheck className="size-5" />
                  </div>
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  Sent to <span className="font-medium text-foreground">{form.email}</span>
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="otp">Verification Code</Label>
                  <OtpInput
                    id="otp"
                    value={form.otp}
                    onChange={(v) => {
                      clearError("otp");
                      setForm((f) => ({ ...f, otp: v }));
                    }}
                    invalid={!!errors.otp}
                  />
                  <FieldError msg={errors.otp} />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Verify & create account
                </Button>
                <button
                  type="button"
                  onClick={resendSignup}
                  disabled={busy}
                  className="w-full text-center text-sm text-primary hover:underline disabled:opacity-50"
                >
                  Resend code
                </button>
              </form>
            ) : screen === "forgot" ? (
              <form onSubmit={submitForgot} noValidate className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={set("email")}
                    aria-invalid={!!errors.email}
                    className={errors.email ? "border-danger" : ""}
                  />
                  <FieldError msg={errors.email} />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Send reset code
                </Button>
              </form>
            ) : (
              <form onSubmit={submitReset} noValidate className="space-y-3">
                <p className="text-center text-sm text-muted-foreground">
                  Sent to <span className="font-medium text-foreground">{form.email}</span>
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="otp">Verification Code</Label>
                  <OtpInput
                    id="otp"
                    value={form.otp}
                    onChange={(v) => {
                      clearError("otp");
                      setForm((f) => ({ ...f, otp: v }));
                    }}
                    invalid={!!errors.otp}
                  />
                  <FieldError msg={errors.otp} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="newPassword">New Password</Label>
                  <PasswordInput
                    id="newPassword"
                    value={form.newPassword}
                    onChange={set("newPassword")}
                    aria-invalid={!!errors.newPassword}
                    className={errors.newPassword ? "border-danger" : ""}
                  />
                  {errors.newPassword ? (
                    <FieldError msg={errors.newPassword} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      8+ characters with uppercase, lowercase &amp; a special character
                    </p>
                  )}
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Reset password & sign in
                </Button>
              </form>
            )}

            <div className="my-4 h-px bg-border" />

            {screen === "verify-signup" || screen === "forgot" || screen === "reset" ? (
              <button
                onClick={() => goTo("login")}
                className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-4" /> Back to sign in
              </button>
            ) : inviteOnly && screen !== "register" ? (
              // A closed door says so, instead of offering a sign-up the API
              // will refuse five fields later.
              <p className="text-center text-sm text-muted-foreground">
                Accounts on {brand?.name ?? "this service"} are set up by its team.
                {brand?.supportEmail ? (
                  <>
                    {" "}
                    Contact{" "}
                    <a
                      href={`mailto:${brand.supportEmail}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      {brand.supportEmail}
                    </a>{" "}
                    for access.
                  </>
                ) : null}
              </p>
            ) : (
              <p className="text-center text-sm text-muted-foreground">
                {screen === "register"
                  ? "Already have an account? "
                  : "Don't have an account? "}
                <button
                  onClick={() =>
                    screen === "register"
                      ? goTo("login")
                      : startSignup()
                  }
                  className="font-semibold text-primary hover:underline"
                >
                  {screen === "register" ? "Sign in" : "Sign up"}
                </button>
              </p>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">Need help? {env.supportEmail}</p>
      </div>
    </div>
  );
}
