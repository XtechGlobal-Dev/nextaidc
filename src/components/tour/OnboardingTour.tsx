import { useEffect, useState, useCallback, useRef } from "react";
import { X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useTourStore, TOUR_STEPS } from "@/stores/useTourStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { cn } from "@/lib/utils";

interface TooltipPos {
  top: number;
  left: number;
  arrowSide: "left" | "right" | "top" | "bottom";
}

export function OnboardingTour() {
  const active = useTourStore((s) => s.active);
  const completed = useTourStore((s) => s.completed);
  const currentStep = useTourStore((s) => s.currentStep);
  const nextStep = useTourStore((s) => s.nextStep);
  const prevStep = useTourStore((s) => s.prevStep);
  const endTour = useTourStore((s) => s.endTour);
  const startTour = useTourStore((s) => s.startTour);

  const [pos, setPos] = useState<TooltipPos | null>(null);
  const [targetRect, setTargetRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // The Quick Setup wizard auto-opens first; don't start the tour until it's
  // fully resolved (seen/skipped/completed), so the two guides never overlap.
  const quickSetupOpen = useQuickSetupStore((s) => s.open);
  const quickSetupCompleted = useQuickSetupStore((s) => s.completed);
  const quickSetupDismissed = useQuickSetupStore((s) => s.dismissed);
  // The tour walks through customer features (and its steps target customer nav).
  // Admins/resellers aren't onboarded this way, so don't auto-start it for them.
  const isCustomer = useAuthStore((s) => s.user?.role === "USER");
  // Server-side "quick setup seen" flag + whether the profile has loaded. We must
  // wait for the profile before deciding, or the tour can fire during the load gap
  // (before Quick Setup auto-opens) and the two end up on screen together.
  const quickSetupSeen = useProfileStore((s) => Boolean(s.profile.quickSetupSeenAt));
  const profileLoaded = useProfileStore((s) => Boolean(s.profile.id));
  const quickSetupResolved = quickSetupSeen || quickSetupCompleted || quickSetupDismissed;

  // Auto-start for first-time customers — only once the profile is loaded AND the
  // Quick Setup wizard is resolved (so it can't pop open over the tour).
  useEffect(() => {
    if (!isCustomer || !profileLoaded || completed || active || quickSetupOpen || !quickSetupResolved)
      return;
    const timer = setTimeout(() => startTour(), 800);
    return () => clearTimeout(timer);
  }, [isCustomer, profileLoaded, completed, active, quickSetupOpen, quickSetupResolved, startTour]);

  const positionTooltip = useCallback(() => {
    if (!active) return;
    const step = TOUR_STEPS[currentStep];
    const el = document.querySelector(step.target);
    if (!el) {
      setPos(null);
      setTargetRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setTargetRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const placement = step.placement || "right";
    const gap = 12;
    const margin = 12;
    const ttW = tooltipRef.current?.offsetWidth ?? 320;
    const ttH = tooltipRef.current?.offsetHeight ?? 200;

    let top = 0;
    let left = 0;
    let arrowSide: TooltipPos["arrowSide"] = "left";

    switch (placement) {
      case "right":
        top = rect.top + rect.height / 2 - ttH / 2;
        left = rect.right + gap;
        arrowSide = "left";
        break;
      case "left":
        top = rect.top + rect.height / 2 - ttH / 2;
        left = rect.left - gap - ttW;
        arrowSide = "right";
        break;
      case "bottom":
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - ttW / 2;
        arrowSide = "top";
        break;
      case "top":
        top = rect.top - gap - ttH;
        left = rect.left + rect.width / 2 - ttW / 2;
        arrowSide = "bottom";
        break;
    }

    // Keep the tooltip fully on screen — the target can sit near a viewport edge.
    left = Math.min(Math.max(margin, left), window.innerWidth - ttW - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - ttH - margin);

    setPos({ top, left, arrowSide });
  }, [active, currentStep]);

  useEffect(() => {
    positionTooltip();
    // Re-run once the tooltip has mounted so clamping uses its real measured size.
    const raf = requestAnimationFrame(positionTooltip);
    window.addEventListener("resize", positionTooltip);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", positionTooltip);
    };
  }, [positionTooltip]);

  const step = TOUR_STEPS[currentStep];
  const isLast = currentStep === TOUR_STEPS.length - 1;
  // Tour is visible only when active and the Quick Setup wizard is closed.
  const showTour = active && !quickSetupOpen;

  const finish = () => {
    setCelebrating(true);
    nextStep(); // marks the tour completed + inactive
    window.setTimeout(() => setCelebrating(false), 2800);
  };

  useBodyScrollLock(showTour || celebrating);

  if (!showTour && !celebrating) return null;

  return (
    <>
      {celebrating && <CelebrationOverlay />}

      {showTour && (
        <>
      {/* Click-catcher — clicking the dimmed area ends the tour. */}
      <div className="fixed inset-0 z-[997]" onClick={endTour} />

      {/* Spotlight: a cutout + ring around the current step's target so the user
          clearly sees which module it points to. The huge box-shadow dims the
          rest of the screen, leaving the target lit. */}
      {targetRect && (
        <div
          className="pointer-events-none fixed z-[998] rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-transparent transition-all duration-300"
          style={{
            top: targetRect.top - 6,
            left: targetRect.left - 6,
            width: targetRect.width + 12,
            height: targetRect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      )}

      {/* Tooltip */}
      {pos && (
        <div
          ref={tooltipRef}
          className="fixed z-[999] w-80 animate-in rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-primary">
                Step {currentStep + 1} of {TOUR_STEPS.length}
              </p>
              <h4 className="mt-1 text-sm font-semibold">{step.title}</h4>
            </div>
            <button onClick={endTour} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
              <X className="size-4" />
            </button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{step.content}</p>
          <div className="mt-4 flex items-center justify-between">
            <div className="flex gap-1">
              {TOUR_STEPS.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "size-1.5 rounded-full transition-colors",
                    i === currentStep ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>
            <div className="flex gap-2">
              {currentStep > 0 && (
                <Button variant="outline" size="sm" onClick={prevStep}>
                  Back
                </Button>
              )}
              <Button size="sm" onClick={isLast ? finish : nextStep}>
                {isLast ? "Finish" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </>
  );
}

const CONFETTI_COLORS = ["#2C76ED", "#10B981", "#F59E0B", "#7C5CFC", "#EF4444", "#06B6D4"];

/** Brief celebratory overlay shown when the tour is finished. */
function CelebrationOverlay() {
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      {/* Confetti */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {Array.from({ length: 16 }).map((_, i) => (
          <span
            key={i}
            className="animate-confetti absolute top-0 size-2 rounded-[2px]"
            style={{
              left: `${(i * 6.25 + (i % 3) * 3) % 100}%`,
              backgroundColor: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${(i % 6) * 0.15}s`,
              animationDuration: `${2 + (i % 4) * 0.3}s`,
            }}
          />
        ))}
      </div>

      <div className="animate-in relative flex flex-col items-center gap-4 rounded-2xl bg-card px-10 py-8 text-center shadow-[var(--shadow-panel)]">
        <div className="relative grid place-items-center">
          <span className="absolute size-24 animate-ping rounded-full bg-success/25" />
          <span className="animate-pop relative grid size-20 place-items-center rounded-full bg-gradient-to-br from-success to-emerald-600 text-white shadow-[0_10px_30px_-8px_rgba(16,185,129,0.6)]">
            <Check className="size-10" strokeWidth={3} />
          </span>
        </div>
        <div>
          <h3 className="text-lg font-bold">You&apos;re all set! 🎉</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You know your way around — go handle some calls.
          </p>
        </div>
      </div>
    </div>
  );
}
