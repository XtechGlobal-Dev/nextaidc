import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { NavLink, matchPath, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronRight,
  LayoutDashboard,
  Inbox,
  BrainCircuit,
  Plug,
  Settings,
  PhoneCall,
  Phone,
  PhoneForwarded,
  PhoneOutgoing,
  CalendarCheck,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutGrid,
  Users,
  UserCog,
  CreditCard,
  Package,
  Ticket,
  BadgeDollarSign,
  Wallet,
  ShieldCheck,
  Handshake,
  Activity,
  Webhook,
  FileBarChart,
  ScrollText,
  Mic,
  Mail,
  X,
  LogOut,
  Sun,
  Moon,
  Monitor,
  BellRing,
  LifeBuoy,
  MessagesSquare,
  ArrowRight,
  Crown,
  Radar,
  Building2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn, titleCaseName } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/misc";
import { useAuthStore } from "@/stores/useAuthStore";
import { canUseSection, hasCustomerWorkspace, isAdminRole, isSuperAdminRole } from "@/lib/roles";
import { adminHref, adminLandingPath } from "@/lib/onboardingRoute";
import { useUiStore } from "@/stores/useUiStore";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { FREE_PLAN_MINUTES, useProfileStore } from "@/stores/useProfileStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { blockedCopy } from "@/lib/trial";
import { cachedSmsToCallerEntitlement } from "@/lib/planFeatures";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { useNotificationStore, unreadTicketCounts } from "@/stores/useNotificationStore";
import type { BrandModuleId } from "@/lib/api";
import { TrialMinutesMeter } from "@/components/trial/TrialIndicators";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ⌘B on macOS, Ctrl+B elsewhere — matches the global sidebar-toggle handler.
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const SIDEBAR_SHORTCUT = isMac ? "⌘B" : "Ctrl+B";

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_CYCLE = ["light", "dark", "system"] as const;
const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  STAFF: "Staff",
  USER: "Member",
  RESELLER: "Reseller",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Ringing bell for unread support activity. Nothing rendered at zero; the collapsed rail perches it on the icon corner. */
function TicketBell({ count, collapsed }: { count: number; collapsed: boolean }) {
  if (count <= 0) return null;
  const label = `${count} unread support update${count === 1 ? "" : "s"}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "pointer-events-none shrink-0 text-danger",
        collapsed ? "absolute right-1.5 top-1" : "ml-auto",
      )}
    >
      <BellRing className={cn("animate-bell-ring", collapsed ? "size-3" : "size-4")} />
    </span>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  tourKey?: string;
  /** Crown when the plan lacks this module. Item stays visible on purpose so people can see what an upgrade buys. */
  premiumWhenLocked?: boolean;
  /** Temporarily hidden from the UI via CSS (kept routable). */
  hidden?: boolean;
  /** Permission key required to see this item (STAFF only — ADMINs see all). */
  permission?: string;
  /** Only full ADMINs see this item (not STAFF). */
  adminOnly?: boolean;
  /** SUPER_ADMIN only: platform API accounts and tenant setup. A brand ADMIN never sees these. */
  superAdminOnly?: boolean;
  /** What a brand's people see instead of `label` — the same page reads differently from inside a tenant
   *  (the platform's "Plans" are a brand's read-only "Default plans"). */
  brandLabel?: string;
  /** Brand module. Switched off = hidden outright; unlike a plan lock there's nothing to upsell. */
  module?: BrandModuleId;
}

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true, tourKey: "dashboard" },
  { to: "/dashboard/calls", label: "Call Inbox", icon: Inbox, tourKey: "calls" },
  { to: "/dashboard/assistant", label: "AI Brain", icon: BrainCircuit, tourKey: "assistant" },
  { to: "/dashboard/crm", label: "Connect CRM", icon: Plug, tourKey: "crm", module: "crm" },
  { to: "/dashboard/plans", label: "Plans & Billing", icon: CreditCard, tourKey: "plans" },
  { to: "/dashboard/forwarding", label: "Call Forwarding", icon: PhoneForwarded, tourKey: "forwarding" },
  { to: "/dashboard/transfer", label: "Call Transfer", icon: PhoneOutgoing, tourKey: "transfer", module: "transfer" },
  { to: "/dashboard/booking", label: "Booking", icon: CalendarCheck, tourKey: "booking", module: "booking" },
  { to: "/dashboard/sms-to-caller", label: "SMS to Caller", icon: MessageSquareText, tourKey: "smsToCaller", premiumWhenLocked: true, module: "smsToCaller" },
  // Support goes to the tier above (brand for a customer, platform for a brand admin). One route, one page.
  { to: "/dashboard/support", label: "Support", icon: LifeBuoy },
];

// Routes already reachable from the mobile bottom app bar (see BottomNav.tsx).
// The mobile sidebar drawer hides these to avoid duplicating them.
const BOTTOM_NAV_ROUTES = new Set([
  "/dashboard",
  "/dashboard/calls",
  "/dashboard/assistant",
  "/dashboard/crm",
]);

const ADMIN_NAV: NavItem[] = [
  // The platform as a whole: every brand's numbers from the nightly rollup.
  // Only the super admin has a "whole platform" to look at.
  { to: "/dashboard/admin/platform", label: "Platform", icon: LayoutGrid, superAdminOnly: true },
  { to: "/dashboard/admin/overview", label: "Overview", icon: LayoutGrid, permission: "overview" },
  { to: "/dashboard/admin/customers", label: "Customers", icon: Users, permission: "customers" },
  { to: "/dashboard/admin/subscriptions", label: "Subscriptions", icon: CreditCard, permission: "subscriptions" },
  // The platform owns the plans; a brand only reads them and sets its addon under Price addon.
  { to: "/dashboard/admin/plans", label: "Plans", brandLabel: "Default plans", icon: Package, permission: "plans" },
  { to: "/dashboard/admin/coupons", label: "Coupons", icon: Ticket, permission: "coupons" },
  // `tickets` is brand-scoped, `brand_tickets` platform-only, so exactly one of these two shows.
  { to: "/dashboard/admin/tickets", label: "Support Tickets", icon: MessagesSquare, permission: "tickets" },
  { to: "/dashboard/admin/tickets", label: "Brand Requests", icon: MessagesSquare, permission: "brand_tickets" },
  // A brand's own money: brand-scoped sections, so the super admin never sees
  // them here (they live on the brand's page under Brands instead).
  { to: "/dashboard/admin/pricing", label: "Price addon", icon: BadgeDollarSign, permission: "pricing" },
  { to: "/dashboard/admin/wallet", label: "Wallet", icon: Wallet, permission: "wallet" },
  { to: "/dashboard/admin/voice-bank", label: "Voice Library", icon: Mic, permission: "voice_bank" },
  { to: "/dashboard/admin/phone-numbers", label: "Phone Numbers", icon: Phone, permission: "phone_numbers" },
  { to: "/dashboard/admin/resellers", label: "Resellers", icon: Handshake, permission: "resellers" },
  // One API Center entry (its sections are tabs on the page). Holds provider credentials and spend,
  // so SUPER_ADMIN only; the routes enforce the same via requireSuperAdmin.
  { to: "/dashboard/admin/api-center", label: "API Center", icon: Radar, superAdminOnly: true },
  // Reports, Webhook Logs, System Health and Settings are ADMIN-only areas —
  // not staff-assignable (removed from the role permission matrix).
  { to: "/dashboard/admin/health", label: "System Health", icon: Activity, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/webhooks", label: "Webhook Logs", icon: Webhook, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/reports", label: "Reports", icon: FileBarChart, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/audit", label: "Audit Log", icon: ScrollText, permission: "audit" },
  { to: "/dashboard/admin/roles", label: "Roles", icon: ShieldCheck, adminOnly: true },
  { to: "/dashboard/admin/staff", label: "Staff", icon: UserCog, adminOnly: true },
  { to: "/dashboard/admin/emails", label: "System Emails", icon: Mail, permission: "emails" },
  // Open to admins; the page itself drops the Integrations tab for anyone but
  // the super admin (the credentials behind it are refused server-side too).
  { to: "/dashboard/admin/settings", label: "Platform Settings", icon: Settings, adminOnly: true },
  // The tenant panel: create a brand, give it a subdomain, a look and its own
  // mail/SMS/WhatsApp senders.
  { to: "/dashboard/admin/brands", label: "Brands", icon: Building2, superAdminOnly: true },
];

// Admin-only "User Dashboard" panel: folds the customer modules so the sidebar isn't doubled. Always mounted
// and toggled with CSS so close slides as smoothly as open; `visibility` is in the transition list and `inert`
// covers the in-between so nothing in a closing panel can be clicked or tabbed into.
interface UserNavPanelProps {
  open: boolean;
  onClose: (opts?: { returnFocus?: boolean }) => void;
  /** Edge it slides in from — the desktop sidebar sits on the left, the
   *  mobile drawer on the right. */
  side: "left" | "right";
  className?: string;
  children: ReactNode;
}

function UserNavPanel({ open, onClose, side, className, children }: UserNavPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus a frame late: on the first tick `visibility` is still hidden and refuses focus. Of the two
    // instances (desktop + mobile) only the one with a layout box takes it.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const btn = closeRef.current;
        if (btn && btn.offsetParent !== null) btn.focus({ preventScroll: true });
      });
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose({ returnFocus: true });
    };
    // A press anywhere outside dismisses the panel — and still lands where it
    // was aimed (no invisible backdrop swallowing the first click).
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && !target.closest("[data-user-nav-panel]")) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onClose]);

  return (
    <div
      data-user-nav-panel=""
      role="dialog"
      aria-label="User Dashboard"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "flex flex-col bg-warm shadow-[var(--shadow-panel)]",
        // Transition `translate`, not `transform`: Tailwind v4 translate-x sets the `translate` property, or the slide snaps.
        "transition-[translate,opacity,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        open
          ? "visible translate-x-0 opacity-100"
          : cn("invisible opacity-0", side === "left" ? "-translate-x-full" : "translate-x-full"),
        className,
      )}
    >
      {/* Same height as the sidebar's logo row, so the two headers line up. */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-tint text-primary">
            <LayoutDashboard className="size-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">User Dashboard</p>
            <p className="truncate text-[11px] text-muted-foreground">Your customer workspace</p>
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={() => onClose({ returnFocus: true })}
          aria-label="Close User Dashboard"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">{children}</nav>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setTester = useUiStore((s) => s.setAssistantTester);
  const mobileSidebarOpen = useUiStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const profile = useProfileStore((s) => s.profile);
  const trial = useTrialStore((s) => s.trial);
  const user = useAuthStore((s) => s.user);
  const isAdmin = isAdminRole(user?.role);
  const isSuperAdmin = isSuperAdminRole(user?.role);
  const isStaff = user?.role === "STAFF";
  const isAdminOrStaff = isAdmin || isStaff;
  // STAFF and SUPER_ADMIN have no customer workspace: admin nav only (lib/roles.ts).
  const platformOnly = !hasCustomerWorkspace(user?.role);
  // Which optional modules this brand's door offers (null = the platform: all).
  const brandModules = useBrandingStore((s) => s.brand?.modules ?? null);
  const homePath = platformOnly ? adminLandingPath(user) : "/dashboard";
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The admin's "User Dashboard" panel (see UserNavPanel). One piece of state
  // serves both the desktop aside and the mobile drawer — never both on screen.
  const [userPanelOpen, setUserPanelOpen] = useState(false);
  // Opener, so keyboard/close-button dismiss returns focus. Outside clicks don't; focus belongs where they clicked.
  const userPanelTrigger = useRef<HTMLElement | null>(null);
  const openUserPanel = (e: MouseEvent<HTMLElement>) => {
    userPanelTrigger.current = e.currentTarget;
    setUserPanelOpen(true);
  };
  const closeUserPanel = useCallback((opts?: { returnFocus?: boolean }) => {
    setUserPanelOpen(false);
    if (opts?.returnFocus) userPanelTrigger.current?.focus({ preventScroll: true });
  }, []);
  // Navigating anywhere (a panel link, the palette, the back button) or
  // opening / closing the mobile drawer starts over with the panel closed.
  useEffect(() => {
    setUserPanelOpen(false);
  }, [pathname, mobileSidebarOpen]);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  // Freeze the page behind the mobile drawer while it's open.
  useBodyScrollLock(mobileSidebarOpen);
  // Header over the admin nav group. A brand admin sees their brand's name, so
  // it's always obvious WHICH tenant the panel below is acting on.
  const adminSectionLabel = isSuperAdmin
    ? "Super Admin"
    : isAdmin
      ? user?.brandName || "Admin"
      : user?.staffRoleName || "Staff";
  // Read-only: whichever screen last fetched entitlements cached them. The badge
  // is decoration, so a stale read costs nothing — the page itself re-checks.
  const smsToCallerIncluded = cachedSmsToCallerEntitlement();
  // Three unread counts, not one: a brand admin both answers customers (`supportInbox`) and asks the platform (`requester`).
  const notifications = useNotificationStore((s) => s.notifications);
  const ticketUnread = useMemo(() => unreadTicketCounts(notifications), [notifications]);

  const displayName = user?.fullName || user?.email || "User";
  const roleLabel = isStaff ? user?.staffRoleName || "Staff" : ROLE_LABEL[user?.role ?? "USER"];
  const ThemeIcon = THEME_ICONS[themeMode];
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themeMode);
    setThemeMode(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };
  const handleLogout = () => {
    setMobileSidebarOpen(false);
    logout();
    navigate("/login");
  };

  const navItemClass = (collapsed: boolean) => ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      isActive
        ? "bg-primary-tint text-primary"
        : "text-foreground/70 hover:bg-muted hover:text-foreground",
      collapsed && "justify-center px-0",
    );

  // Customer modules: none for STAFF/SUPER_ADMIN, all for USER, all minus Plans & Billing for ADMIN.
  const visibleUserItems = (isMobile: boolean) =>
    platformOnly
      ? []
      : NAV.filter(
          (item) =>
            // Admins keep Call Forwarding + Call Transfer in their user nav
            // (they have a real profile); Plans & Billing is hidden, and so is
            // Support: a brand admin's requests to the platform live in their
            // Support Tickets inbox, next to their customers' tickets.
            !(isAdmin && (item.to === "/dashboard/plans" || item.to === "/dashboard/support")) &&
            // A module the brand switched off is simply not on offer.
            !(item.module && brandModules && brandModules[item.module] === false) &&
            // On mobile these live in the bottom app bar, so drop them here.
            !(isMobile && BOTTOM_NAV_ROUTES.has(item.to)),
        );

  const renderUserNavLinks = (items: NavItem[], isMobile: boolean, isCollapsed: boolean) =>
    items.map(({ to, label, icon: Icon, end, tourKey, premiumWhenLocked }) => (
      <NavLink
        key={to}
        to={to}
        end={end}
        className={navItemClass(isCollapsed)}
        title={isCollapsed ? label : undefined}
        onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
        {...(tourKey ? { "data-tour": tourKey } : {})}
      >
        <Icon className="size-[18px] shrink-0" />
        {!isCollapsed && <span>{label}</span>}
        {premiumWhenLocked && !smsToCallerIncluded && !isCollapsed && (
          <Crown className="ml-auto size-4 shrink-0 text-premium" aria-label="Premium feature" />
        )}
        {to === "/dashboard/support" && (
          <TicketBell count={ticketUnread.requester} collapsed={isCollapsed} />
        )}
      </NavLink>
    ));

  // ADMIN folds customer modules into the User Dashboard panel; SUPER_ADMIN has no workspace to fold.
  const userNavAsPanel = isAdmin && !platformOnly;
  // Light the entry up while on any of the pages it holds, so an admin can
  // still tell which side of the app they're on with the panel closed.
  const onUserPage =
    userNavAsPanel &&
    visibleUserItems(false).some(({ to, end }) => matchPath({ path: to, end: !!end }, pathname) !== null);

  const minutesUsed = profile.webTestMinutesUsed;
  const hasEntitlement = trial?.phase === "trial" || trial?.phase === "active";

  const sidebarContent = (isMobile: boolean) => {
    const isCollapsed = isMobile ? false : collapsed;
    const userItems = visibleUserItems(isMobile);
    return (
      <>
        {/* Logo + collapse toggle */}
        <div className={cn("flex h-16 shrink-0 items-center px-4", isCollapsed ? "justify-center" : "justify-between")}>
          {!isCollapsed && (
            <NavLink
              // Role-aware home; /dashboard would bounce a super admin through RequireCustomer with a visible flicker.
              to={homePath}
              end
              onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
              className="flex items-center gap-2 overflow-hidden rounded-lg"
              aria-label="Go to home"
            >
              <BrandLogo imgClassName="h-10 w-auto max-w-[170px] object-contain">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <PhoneCall className="size-5" />
                </div>
                <span className="truncate text-[15px] font-semibold leading-tight">
                  <Wordmark />
                </span>
              </BrandLogo>
            </NavLink>
          )}
          {isMobile ? (
            <button onClick={() => setMobileSidebarOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close menu">
              <X className="size-4" />
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={toggleSidebar} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Toggle sidebar">
                  {isCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex items-center gap-1.5">
                {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                <kbd className="rounded border border-background/30 px-1 py-px text-[10px] font-medium">
                  {SIDEBAR_SHORTCUT}
                </kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Profile + Appearance — pinned to the top of the mobile drawer. */}
        {isMobile && (
          <div className="border-b border-border px-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {initials(titleCaseName(displayName))}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold leading-tight">
                  {titleCaseName(displayName)}
                </p>
                <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setMobileSidebarOpen(false);
                  navigate("/dashboard/settings");
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                <Settings className="size-4" /> Profile
              </button>
              <button
                type="button"
                onClick={cycleTheme}
                aria-label={`Appearance: ${THEME_LABEL[themeMode]} (tap to change)`}
                className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                <ThemeIcon className="size-4" /> {THEME_LABEL[themeMode]}
              </button>
            </div>
          </div>
        )}

        {/* Scrollable region: nav + Call Assistant flow together (top-aligned, no floating gap) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
          <nav className="flex flex-col gap-1 px-3">
            {/* Customer modules: inline for USER, one "User Dashboard" button for ADMIN (list lives in UserNavPanel). */}
            {userNavAsPanel
              ? userItems.length > 0 && (
                  <button
                    type="button"
                    onClick={openUserPanel}
                    aria-haspopup="dialog"
                    aria-expanded={userPanelOpen}
                    title={isCollapsed ? "User Dashboard" : undefined}
                    className={cn(navItemClass(isCollapsed)({ isActive: onUserPage }), "w-full")}
                  >
                    <LayoutDashboard className="size-[18px] shrink-0" />
                    {!isCollapsed && (
                      <>
                        <span>User Dashboard</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          <ChevronRight className="size-4 shrink-0 opacity-60" />
                        </span>
                      </>
                    )}
                  </button>
                )
              : renderUserNavLinks(userItems, isMobile, isCollapsed)}
          </nav>

          {isAdminOrStaff && (() => {
            const visibleAdminItems = ADMIN_NAV.filter((item) => {
              if (item.superAdminOnly && !isSuperAdmin) return false;
              if (item.adminOnly && !isAdmin) return false;
              // Brand-scoped sections are refused to the super admin; keyed off the permission so nav and API can't drift.
              if (!canUseSection(user?.role, item.permission, user?.brandId)) return false;
              if (item.permission && !hasPermission(item.permission)) return false;
              return true;
            }).map((item) => (item.brandLabel && !isSuperAdmin ? { ...item, label: item.brandLabel } : item));
            if (visibleAdminItems.length === 0) return null;
            return (
            <nav className="mt-2 flex flex-col gap-1 px-3">
              {!isCollapsed ? (
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="size-3.5 text-primary" /> {adminSectionLabel}
                </div>
              ) : (
                <div className="mx-auto my-1 h-px w-6 bg-border" />
              )}
              {visibleAdminItems.map(({ to, label, icon: Icon, hidden, permission }) => (
                <NavLink
                  key={to}
                  // One nav definition, two prefixes: the super admin's panel
                  // lives at /superadmin, everyone else's at /dashboard/admin.
                  to={adminHref(to, user?.role)}
                  className={(state) => cn(navItemClass(isCollapsed)(state), hidden && "hidden")}
                  title={isCollapsed ? label : undefined}
                  onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
                >
                  <Icon className="size-[18px] shrink-0" />
                  {!isCollapsed && <span>{label}</span>}
                  {/* Same path for both inboxes, so the permission decides which count rings. */}
                  {permission === "tickets" && (
                    <TicketBell count={ticketUnread.supportInbox} collapsed={isCollapsed} />
                  )}
                  {permission === "brand_tickets" && (
                    <TicketBell count={ticketUnread.brandInbox} collapsed={isCollapsed} />
                  )}
                </NavLink>
              ))}
            </nav>
            );
          })()}

          <div className="mt-auto pt-3">
          {!isCollapsed &&
            (profile.receptionistNumber ? (
              <div className="mx-3 mt-3 rounded-xl border border-border bg-card p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Phone className="size-3.5 text-primary" />
                  AI Receptionist Number
                </div>
                <p className="mt-1.5 text-sm font-semibold tracking-tight tabular-nums text-foreground">
                  {profile.receptionistNumber}
                </p>
                {!isAdminOrStaff && (
                  <NavLink
                    to="/dashboard/forwarding"
                    onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
                    className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                  >
                    Need help forwarding calls?
                  </NavLink>
                )}
              </div>
            ) : (
              !isAdminOrStaff && (
                <button
                  type="button"
                  onClick={() => {
                    const qs = useQuickSetupStore.getState();
                    qs.openSetup(); // opens at the Plan step (step 1)
                  }}
                  className="mx-3 mt-3 block w-[calc(100%-1.5rem)] animate-card-beacon overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-[#1d4ed8] p-3.5 text-left text-white shadow-[var(--shadow-panel)] transition-transform hover:scale-[1.02] motion-reduce:animate-none"
                >
                  <div className="flex items-center gap-2">
                    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-danger shadow-lg shadow-danger/40">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:hidden" />
                      <BellRing className="relative size-4 text-white" />
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/90">
                      Action needed
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-bold leading-snug">Activate your AI number</p>
                  <p className="mt-0.5 text-xs leading-snug text-white/85">
                    Set it up to start taking real calls.
                  </p>
                  <span className="mt-2.5 inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold text-primary shadow-sm">
                    Set it up <ArrowRight className="size-3.5" />
                  </span>
                </button>
              )
            ))}

          <div className="mx-3 mt-3 space-y-3">
            {!isCollapsed && !isAdmin && hasEntitlement && (
              <div className="space-y-2">
                <TrialMinutesMeter />
                {trial?.blocked && (
                  <NavLink
                    to={trial.canRenew ? "/dashboard/plans?renew=1" : "/subscribe"}
                    className="block rounded-md bg-primary px-2.5 py-1.5 text-center text-xs font-semibold text-primary-foreground hover:opacity-90"
                  >
                    {trial.canRenew ? "Renew plan" : blockedCopy(trial)?.cta ?? "Upgrade"}
                  </NavLink>
                )}
              </div>
            )}
            {!isCollapsed && !isAdminOrStaff && trial && !hasEntitlement && (
              <div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Test minutes</span>
                  <span>
                    {minutesUsed}/{FREE_PLAN_MINUTES}
                  </span>
                </div>
                <ProgressBar className="mt-1" value={(minutesUsed / FREE_PLAN_MINUTES) * 100} />
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Sticky footer so it stays visible while the nav scrolls. Hidden without a customer workspace (no agent to dial). */}
        {!platformOnly && (
          <div className="shrink-0 border-t border-border p-3">
            <Button
              variant="outline"
              className={cn(
                "w-full justify-center gap-2 border-primary/40 bg-primary-tint font-semibold text-primary shadow-(--shadow-soft) hover:bg-primary hover:text-primary-foreground",
                isCollapsed && "px-0",
              )}
              onClick={() => setTester(true)}
              title="Call Assistant"
            >
              <PhoneCall className="size-4" />
              {!isCollapsed && "Call Assistant"}
            </Button>
          </div>
        )}

        {/* Logout — pinned to the bottom of the mobile drawer (both roles). */}
        {isMobile && (
          <div className="shrink-0 border-t border-border p-3">
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-tint"
            >
              <LogOut className="size-4" /> Log out
            </button>
          </div>
        )}

        {/* Desktop pins the panel to the viewport at full width so it works over the collapsed rail; mobile fills the drawer. */}
        {userNavAsPanel && userItems.length > 0 && (
          <UserNavPanel
            open={userPanelOpen}
            onClose={closeUserPanel}
            side={isMobile ? "right" : "left"}
            className={
              isMobile ? "absolute inset-0 z-10" : "fixed inset-y-0 left-0 z-45 w-64 border-r border-border"
            }
          >
            {renderUserNavLinks(userItems, isMobile, false)}
          </UserNavPanel>
        )}
      </>
    );
  };

  return (
    <>
      {/* z-45: sticky makes the aside a stacking context, so the panel inside can't out-rank the header (z-40)
          on its own. Above the header, below dialogs/sheets (z-50+). */}
      <aside
        className={cn(
          "sticky top-0 z-45 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-border bg-warm transition-[width] duration-200 nav:flex",
          collapsed ? "w-[72px]" : "w-64",
        )}
      >
        {sidebarContent(false)}
      </aside>

      {/* Mobile sidebar overlay — slides in from the right */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 nav:hidden">
          <div
            className="animate-in absolute inset-0 bg-black/50"
            onClick={() => setMobileSidebarOpen(false)}
          />
          {/* overflow-hidden: the User Dashboard panel parks off the drawer's
              right edge while closed, and must not leak past it. */}
          <aside className="animate-sheet-in absolute right-0 top-0 flex h-full w-72 max-w-[85%] flex-col overflow-hidden border-l border-border bg-warm shadow-[var(--shadow-panel)]">
            {sidebarContent(true)}
          </aside>
        </div>
      )}
    </>
  );
}
