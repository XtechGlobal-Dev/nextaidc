import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, useNavigate } from "react-router-dom";
import {
  Clock,
  AlertTriangle,
  Eye,
  LogOut,
  PhoneCall,
  ArrowRight,
  Search,
  X,
} from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { AssistantTesterDialog } from "@/components/assistant/AssistantTesterDialog";
import { QuickSetupModal } from "@/components/quicksetup/QuickSetupModal";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { NotificationPanel } from "@/components/notifications/NotificationPanel";
import { IncomingCallToast } from "@/components/tickets/IncomingCallToast";
import { CallWindow } from "@/components/tickets/CallWindow";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { OnboardingTour } from "@/components/tour/OnboardingTour";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { cardWallActive } from "@/lib/cardWall";
import { useHydrateData } from "@/hooks/useHydrateData";
import { useLiveData } from "@/hooks/useLiveData";
import { useNotificationsPoll } from "@/hooks/useNotificationsPoll";
import { useBrowserAlerts } from "@/hooks/useBrowserAlerts";
import { usePermissionsSync } from "@/hooks/usePermissionsSync";
import { useAuthStore } from "@/stores/useAuthStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { blockedCopy } from "@/lib/trial";
import { useUiStore } from "@/stores/useUiStore";
import { hasCustomerWorkspace } from "@/lib/roles";
import { adminLandingPath } from "@/lib/onboardingRoute";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { cn } from "@/lib/utils";

export function AppLayout() {
  useHydrateData();
  useLiveData();
  useNotificationsPoll();
  useBrowserAlerts();
  usePermissionsSync();
  const user = useAuthStore((s) => s.user);
  const forceSuspendLogout = useAuthStore((s) => s.forceSuspendLogout);
  const impersonator = useAuthStore((s) => s.impersonator);
  const stopImpersonation = useAuthStore((s) => s.stopImpersonation);

  // Expose the sticky impersonation banner's measured height as --chrome-top so the header's sticky top
  // sits below it, not under it. Measured because the banner is responsive.
  const mainRef = useRef<HTMLElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const banner = bannerRef.current;
    if (!banner) {
      main.style.setProperty("--chrome-top", "0px");
      return;
    }
    const sync = () => main.style.setProperty("--chrome-top", `${banner.offsetHeight}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(banner);
    return () => ro.disconnect();
  }, [impersonator]);
  // STAFF and SUPER_ADMIN have no customer workspace, so the customer chrome below doesn't apply (lib/roles.ts).
  const platformOnly = !hasCustomerWorkspace(user?.role);
  const agentStatus = useAgentStore((s) => s.status);
  const trial = useTrialStore((s) => s.trial);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const toggleNotifications = useNotificationStore((s) => s.setPanelOpen);
  const navigate = useNavigate();
  // Lets the user dismiss the "activate your number" card for this session.
  const [setupBannerDismissed, setSetupBannerDismissed] = useState(false);

  // Global shortcuts: Ctrl/⌘+B toggles the sidebar, Alt+N the notifications panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Alt+N — toggle notifications. Ignore if Ctrl/⌘ is also held. Match on
      // e.code so it works despite Mac's Option+N dead key (˜) and other layouts.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyN") {
        e.preventDefault();
        toggleNotifications(!useNotificationStore.getState().panelOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, toggleNotifications]);

  // Admin suspension is a hard lock: log out to /login, never /subscribe (they can't self-reactivate).
  // Skipped while impersonating so viewing a suspended customer doesn't kick the admin out.
  const adminSuspended =
    !impersonator &&
    user?.role === "USER" &&
    (!!user?.profile?.suspendedAt || !!trial?.adminSuspended);
  useEffect(() => {
    if (adminSuspended) forceSuspendLogout();
  }, [adminSuspended, forceSuspendLogout]);

  if (user?.role === "RESELLER") return <Navigate to="/reseller" replace />;
  if (adminSuspended) return <Navigate to="/login" replace />;

  function exitImpersonation() {
    stopImpersonation();
    navigate("/dashboard/admin/customers");
  }

  const status = user?.profile?.subscriptionStatus;
  // Gate on the polled entitlement flag too, so suspension kicks in before the cached profile refreshes.
  const suspended = status === "suspended" || !!trial?.suspended;
  // Card-less "none" accounts stay in (plan + card come later in the number wizard). cardWallActive reads
  // the account's own signup snapshot, so flipping the admin toggle never affects existing users.
  const needsSubscription =
    !impersonator &&
    user?.role === "USER" &&
    (suspended || status === "canceled" || cardWallActive(user));
  if (needsSubscription) return <Navigate to="/subscribe" replace />;

  // Agent provisions automatically once the trial starts; show a notice while
  // that's still in flight (or if it hasn't completed yet).
  const awaitingApproval = user?.role === "USER" && agentStatus === "pending";
  // Whether they've already claimed their dedicated AI number.
  const hasNumber = Boolean(user?.profile?.receptionistNumber?.trim());
  function openNumberSetup() {
    useQuickSetupStore.getState().openSetup(); // opens at the Plan step (step 1)
  }

  // Only nag once they've started; a "none" account has nothing to nag about yet (or was walled above).
  const blocked = trial && trial.phase !== "none" ? blockedCopy(trial) : null;

  // Initials for the profile button in the mobile top header.
  const staffInitials = (() => {
    const name = user?.fullName || user?.email || "User";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "U";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main ref={mainRef} className="min-w-0 flex-1">
        {impersonator && (
          <div
            ref={bannerRef}
            className="sticky top-0 z-50 flex items-center gap-3 border-b border-primary/40 bg-primary px-4 py-2.5 text-white md:px-8"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/20 text-white">
              <Eye className="size-4" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-sm font-semibold text-white">
                Viewing {user?.fullName || user?.email || "this customer"}'s
                account
              </p>
              <p className="hidden truncate text-xs text-white/85 sm:block">
                Admin mode — anything you change is saved to their account.
              </p>
            </div>
            <button
              onClick={exitImpersonation}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-semibold text-primary shadow-sm transition hover:opacity-90"
            >
              <LogOut className="size-3.5" /> Exit to admin
            </button>
          </div>
        )}
        {blocked && (
          <div className="flex flex-wrap items-center gap-2 border-b border-danger/30 bg-danger-tint px-8 py-2.5 text-sm text-danger">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              <strong>{blocked.title}</strong> — {blocked.reason}. AI calling is
              paused.
            </span>
            <Link
              to={trial?.canRenew ? "/dashboard/plans?renew=1" : "/subscribe"}
              className="ml-auto rounded-md bg-danger px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              {trial?.canRenew ? "Renew plan" : blocked.cta}
            </Link>
          </div>
        )}
        {/* Mobile top bar — sticky for accounts with no bottom app bar (STAFF,
            SUPER_ADMIN), who open their menu from the profile button here. */}
        <div
          className={cn(
            "flex items-center justify-between border-b border-border bg-warm px-4 py-3 nav:hidden",
            platformOnly && "sticky top-0 z-30",
          )}
        >
          <Link
            to={platformOnly ? adminLandingPath(user) : "/dashboard"}
            aria-label="Go to home"
            className="rounded-lg"
          >
            <BrandLogo imgClassName="h-7 w-auto max-w-[140px] object-contain">
              <span className="text-sm font-semibold">
                <Wordmark />
              </span>
            </BrandLogo>
          </Link>
          <div className="flex items-center gap-0.5">
            {/* Only way into the command palette on mobile: the desktop header is hidden and there's no ⌘K. */}
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
              aria-label="Search pages"
              aria-haspopup="dialog"
              className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Search className="size-[18px]" />
            </button>
            <NotificationBell />
            {/* No bottom app bar for these accounts, so the drawer opens here. */}
            {platformOnly && (
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(true)}
                aria-label="Open menu"
                aria-haspopup="dialog"
                className="ml-1 grid size-8 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
              >
                {staffInitials}
              </button>
            )}
          </div>
        </div>

        {awaitingApproval &&
          (hasNumber ? (
            // Rare: number claimed but provisioning still finishing.
            <div className="flex items-center gap-3 border-b border-warning/25 bg-warning-tint px-4 py-3 text-warning md:px-8">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-warning/15">
                <Clock className="size-5" />
              </span>
              <p className="text-sm font-medium">
                Your AI receptionist is going live — this only takes a moment.
              </p>
            </div>
          ) : setupBannerDismissed ? null : (
            // Not set up yet — nudge them to claim a number (self-serve, no auto-assign).
            <div className="flex flex-wrap items-center gap-3 border-b border-warning/25 bg-warning-tint px-4 py-3 sm:gap-4 md:px-8">
              {/* Phone badge with a soft incoming-call pulse so the eye catches it. */}
              <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-danger shadow-lg shadow-danger/40">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:hidden" />
                <PhoneCall className="relative size-5 text-white" />
              </span>
              {/* Copy — same wording, split into a title + supporting line. */}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-foreground">
                  Your AI receptionist isn't live yet
                </p>
                <p className="text-xs text-muted-foreground sm:text-sm">
                  Set up your number to start taking real calls.
                </p>
              </div>
              {/* Primary action */}
              <button
                type="button"
                onClick={openNumberSetup}
                className="inline-flex shrink-0 animate-attention items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 motion-reduce:animate-none"
              >
                <PhoneCall className="size-4" />
                Set it up
                <ArrowRight className="size-4" />
              </button>
              {/* Dismiss for this session */}
              <button
                type="button"
                onClick={() => setSetupBannerDismissed(true)}
                aria-label="Dismiss"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}

        {/* Desktop header bar */}
        <AppHeader />

        <div className="mx-auto max-w-[1600px] px-4 py-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 nav:py-8">
          <Outlet />
        </div>
      </main>
      <BottomNav />
      {/* Notifications slide-over — one instance serves both the desktop and
          mobile bells (see NotificationPanel for why it is not inside the bell). */}
      <NotificationPanel />
      <IncomingCallToast />
      <CallWindow />
      {/* Customer chrome; nothing here applies to STAFF or the SUPER_ADMIN. */}
      {!platformOnly && (
        <>
          <ChatWidget />
          <AssistantTesterDialog />
          <QuickSetupModal />
          <OnboardingTour />
        </>
      )}
    </div>
  );
}
