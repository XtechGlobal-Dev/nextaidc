import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Loader2, MailCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/ui/otp-input";
import { useAuthStore } from "@/stores/useAuthStore";
import { api, ApiError } from "@/lib/api";

const PIN_LENGTH = 6;

/** Remaining lockout as m:ss — a ticking clock says "wait" far more plainly
 *  than a rounded "15 minute(s)" that stays 15 for a full minute. */
function countdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Which question the dialog is asking. One dialog rather than three, because
 * every step wants the same thing — six digits — and the admin arriving here
 * has one goal: get into the account.
 */
type Mode = "enter" | "change" | "reset";

/**
 * The PIN prompt behind "Login as Customer".
 *
 * The entry point is hidden (an emoji in the header), but that is presentation,
 * not protection — `POST /customers/:id/impersonate` verifies the PIN itself and
 * refuses without it. Nothing in this component is a security control; if it
 * were deleted entirely, the endpoint would still say no.
 *
 * Changing and resetting the PIN live in here too, rather than on a settings
 * page. The point of the feature is that the whole capability is out of sight,
 * and a "Login as Customer PIN" card in admin settings would advertise it again.
 */
export function ImpersonationPinDialog({
  open,
  onOpenChange,
  customerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
}) {
  const navigate = useNavigate();
  // Resolved when the dialog opens. Naming the account is the point of the
  // confirmation step — "sign in as someone" is not a question anyone should be
  // answering blind.
  const [customerName, setCustomerName] = useState("this customer");
  const [mode, setMode] = useState<Mode>("enter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);

  // "enter" + "change" use `pin` as the CURRENT pin; "reset" uses `code` as the
  // emailed one. `newPin` is shared by change and reset.
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  /* When the server's lockout expires, as epoch ms. Held as an INSTANT rather
   * than the "15 minute(s)" the error message quotes, so the dialog can count it
   * down and let itself back in — a static message left the boxes typable and
   * the button live for the whole fifteen minutes, inviting attempts the server
   * was always going to refuse. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const lockMsLeft = lockedUntil == null ? 0 : Math.max(0, lockedUntil - now);
  /* The reset path is deliberately exempt: the server does not apply the lockout
   * to it, because being locked out is one of the reasons to be resetting. */
  const frozen = lockMsLeft > 0 && mode !== "reset";

  // Ticks only while a lockout is running, and clears itself at zero so the
  // dialog re-opens for business without needing to be closed and re-opened.
  useEffect(() => {
    if (lockedUntil == null) return;
    const t = setInterval(() => {
      if (Date.now() >= lockedUntil) setLockedUntil(null);
      else setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);

  function applyLock(ms: number) {
    setLockedUntil(ms > 0 ? Date.now() + ms : null);
  }

  /** Re-read the authoritative lockout. The failure response says "15 minute(s)"
   *  in prose; this is where the actual remaining time comes from. */
  async function refreshLock() {
    try {
      applyLock((await api.admin.impersonationPin.status()).lockedForMs);
    } catch {
      /* leave whatever we already know */
    }
  }

  // Reset on every open. A PIN left in state from last time would otherwise be
  // submitted by a stray Enter, and the previous error would flash up before
  // this attempt had been made.
  useEffect(() => {
    if (!open) return;
    setMode("enter");
    setPin("");
    setCode("");
    setNewPin("");
    setSentTo(null);
    setError(null);
    setBusy(false);
    setLockedUntil(null);
    api.admin.impersonationPin
      .status()
      .then((s) => {
        setIsDefault(s.isDefault);
        // A lockout survives closing the dialog, so it has to be read on open —
        // otherwise re-opening presented a usable form that could not work.
        applyLock(s.lockedForMs);
      })
      .catch(() => setIsDefault(false));
    api.admin
      .customer(customerId)
      .then((c) => setCustomerName(c.fullName || c.email))
      .catch(() => setCustomerName("this customer"));
  }, [open, customerId]);

  /** Switch step without carrying the previous one's digits or error across. */
  function go(next: Mode) {
    setMode(next);
    setError(null);
    setPin("");
    setCode("");
    setNewPin("");
  }

  function fail(e: unknown, fallback: string) {
    // The server's message carries the useful part — attempts remaining, or how
    // long a lockout has left — so it is shown rather than replaced.
    setError(e instanceof ApiError ? e.message : fallback);
  }

  async function submitLogin() {
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.admin.impersonate(customerId, pin);
      useAuthStore.getState().startImpersonation(token, user);
      toast.success(`Now viewing ${customerName}'s account`);
      onOpenChange(false);
      navigate("/dashboard");
    } catch (e) {
      fail(e, "Could not access account");
      setPin("");
      setBusy(false);
      // That attempt may have been the one that tripped the limit.
      void refreshLock();
    }
  }

  async function submitChange() {
    setBusy(true);
    setError(null);
    try {
      await api.admin.impersonationPin.change(pin, newPin);
      toast.success("PIN updated");
      setIsDefault(false);
      go("enter");
    } catch (e) {
      fail(e, "Could not change the PIN");
      // The change route shares the same lockout — a wrong current PIN here
      // counts, and can be the attempt that closes the door.
      void refreshLock();
    } finally {
      setBusy(false);
    }
  }

  async function startReset() {
    setBusy(true);
    setError(null);
    try {
      const { sentTo: to } = await api.admin.impersonationPin.startReset();
      setSentTo(to);
      setMode("reset");
      setPin("");
      setNewPin("");
    } catch (e) {
      fail(e, "Could not send the reset code");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    setBusy(true);
    setError(null);
    try {
      await api.admin.impersonationPin.completeReset(code, newPin);
      toast.success("PIN reset");
      setIsDefault(false);
      go("enter");
    } catch (e) {
      fail(e, "Could not reset the PIN");
    } finally {
      setBusy(false);
    }
  }

  /** The step's primary action, and whether it has enough digits to run. */
  const step = {
    enter: {
      title: "Access customer account",
      description: `Enter your PIN to sign in as ${customerName}.`,
      cta: "Continue",
      ready: pin.length === PIN_LENGTH,
      run: submitLogin,
    },
    change: {
      title: "Change access PIN",
      description: "Enter your current PIN, then the new one.",
      cta: "Save new PIN",
      ready: pin.length === PIN_LENGTH && newPin.length === PIN_LENGTH,
      run: submitChange,
    },
    reset: {
      title: "Reset access PIN",
      description: sentTo
        ? `We emailed a 6-digit code to ${sentTo}. Enter it, then choose a new PIN.`
        : "Enter the code we emailed you, then choose a new PIN.",
      cta: "Set new PIN",
      ready: code.length === PIN_LENGTH && newPin.length === PIN_LENGTH,
      run: submitReset,
    },
  }[mode];

  /** Labelled block of six boxes. Enter submits when the step is complete. */
  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    autoFocus = false,
  ) => (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && step.ready && !busy && !frozen) {
            e.preventDefault();
            void step.run();
          }
        }}
      >
        <OtpInput
          value={value}
          onChange={onChange}
          length={PIN_LENGTH}
          invalid={!!error && !frozen}
          autoFocus={autoFocus}
          disabled={frozen}
        />
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="items-center text-center">
          <span className="mb-1 grid size-11 place-items-center rounded-full bg-primary-tint text-primary">
            {mode === "reset" ? <MailCheck className="size-5" /> : <KeyRound className="size-5" />}
          </span>
          <DialogTitle>{step.title}</DialogTitle>
          <DialogDescription>{step.description}</DialogDescription>
        </DialogHeader>

        {isDefault && mode === "enter" && (
          <div className="flex items-start gap-2 rounded-xl bg-warning-tint p-3 text-sm text-foreground/80">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Still on the default PIN, so it protects nothing.{" "}
              <button
                type="button"
                className="font-medium text-primary underline underline-offset-2"
                onClick={() => go("change")}
              >
                Set a real one
              </button>
              .
            </span>
          </div>
        )}

        <div className="space-y-4 py-1">
          {mode === "enter" && field("PIN", pin, setPin, true)}
          {mode === "change" && (
            <>
              {field("Current PIN", pin, setPin, true)}
              {field("New PIN", newPin, setNewPin)}
            </>
          )}
          {mode === "reset" && (
            <>
              {field("Emailed code", code, setCode, true)}
              {field("New PIN", newPin, setNewPin)}
            </>
          )}

          {/* While frozen the countdown IS the message — showing the failure
              text as well just repeats a number that is already going stale. */}
          {frozen ? (
            <p className="text-center text-sm text-danger">
              Too many incorrect PINs. Try again in{" "}
              <span className="font-semibold tabular-nums">{countdown(lockMsLeft)}</span>.
            </p>
          ) : (
            error && <p className="text-center text-sm text-danger">{error}</p>
          )}
        </div>

        <div className="space-y-3">
          <Button
            className="w-full"
            onClick={() => void step.run()}
            disabled={busy || !step.ready || frozen}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {frozen ? "Locked" : step.cta}
          </Button>

          {/* Secondary routes as quiet text, so the primary action stays the
              obvious one. A forgotten PIN is otherwise a database job. */}
          <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
            {mode === "enter" ? (
              <>
                {/* Change PIN needs the current one, so the same lockout applies
                    to it — offering it here would only spend another attempt. */}
                <button
                  type="button"
                  className="hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
                  disabled={frozen}
                  onClick={() => go("change")}
                >
                  Change PIN
                </button>
                <span aria-hidden>·</span>
                {/* Stays live while locked ON PURPOSE — it is the way out, and
                    the server exempts it for exactly that reason. */}
                <button
                  type="button"
                  className="hover:text-foreground disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void startReset()}
                >
                  Forgot PIN?
                </button>
              </>
            ) : (
              <button type="button" className="hover:text-foreground" onClick={() => go("enter")}>
                Back
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
