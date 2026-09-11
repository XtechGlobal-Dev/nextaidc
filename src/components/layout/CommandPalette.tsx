import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  BrainCircuit,
  Plug,
  CreditCard,
  LayoutGrid,
  Users,
  Package,
  Phone,
  PhoneForwarded,
  PhoneOutgoing,
  CalendarCheck,
  MessageSquareText,
  Handshake,
  ScrollText,
  Settings,
  UserCog,
  Ticket,
  BadgeDollarSign,
  Wallet,
  Mic,
  Radar,
  Building2,
  ShieldCheck,
  Mail,
  Crown,
  Search,
  CornerDownLeft,
  type LucideIcon,
  LifeBuoy,
  MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useAuthStore } from "@/stores/useAuthStore";
import { useBrandingStore } from "@/stores/useBrandingStore";
import type { BrandModuleId } from "@/lib/api";
import { cachedSmsToCallerEntitlement } from "@/lib/planFeatures";
import { canUseSection, hasCustomerWorkspace, isAdminRole, isSuperAdminRole } from "@/lib/roles";
import { adminHref } from "@/lib/onboardingRoute";

interface Destination {
  to: string;
  label: string;
  group: string;
  icon: LucideIcon;
  /** Extra search terms — lets a query match content *inside* a page, not just its title. */
  keywords?: string[];
  /** Shown under the label when it matched (so the user sees why). */
  hint?: string;
  /** Permission key required to reach this page (STAFF only — ADMINs hold all). */
  permission?: string;
  /** Only full ADMINs can reach this page (not STAFF). */
  adminOnly?: boolean;
  /** Only the platform SUPER_ADMIN can reach this page — the areas holding the
   *  platform's own API accounts and every tenant's setup. */
  superAdminOnly?: boolean;
  /** Customer-facing module — hidden from roles with no customer workspace
   *  (STAFF, SUPER_ADMIN). */
  customer?: boolean;
  /** Hidden from ADMINs (they don't own a subscription of their own). */
  hideForAdmin?: boolean;
  /** Show a Crown when the plan doesn't include this module — the row stays
   *  listed on purpose, exactly like the sidebar item, so an upgrade stays
   *  discoverable rather than invisible. */
  premiumWhenLocked?: boolean;
  /** The brand module this page belongs to — hidden when the brand switched it off. */
  module?: BrandModuleId;
}

// Mirrors the sidebar routes so the palette jumps to the same real pages — every
// item the sidebar can show is listed here, gated by the SAME role/permission
// rules (see the filter in `results`), so search can never offer a page the
// person can't open. The `keywords` make in-page content discoverable — e.g.
// "whatsapp" or "smtp" resolves to Platform Settings even though that word isn't
// in the title.
//
// Deliberately absent: the sidebar's `hidden` admin entries (System Health,
// Webhook Logs, Reports) — they stay routable but out of the UI, so surfacing
// them in search would undo that.
const DESTINATIONS: Destination[] = [
  { to: "/dashboard", label: "Dashboard", group: "Workspace", icon: LayoutDashboard, customer: true, keywords: ["home", "analytics", "overview", "calls", "leads", "stats", "metrics"] },
  { to: "/dashboard/calls", label: "Call Inbox", group: "Workspace", icon: Inbox, customer: true, keywords: ["calls", "recordings", "transcripts", "voicemail", "missed", "history", "messages"] },
  { to: "/dashboard/assistant", label: "AI Brain", group: "Workspace", icon: BrainCircuit, customer: true, keywords: ["assistant", "agent", "knowledge", "prompt", "persona", "identity", "rules", "automations", "training", "faqs", "voice"] },
  { to: "/dashboard/crm", label: "Connect CRM", group: "Workspace", icon: Plug, customer: true, module: "crm", keywords: ["integration", "hubspot", "salesforce", "zapier", "leads", "contacts", "sync"] },
  { to: "/dashboard/plans", label: "Plans & Billing", group: "Workspace", icon: CreditCard, customer: true, hideForAdmin: true, keywords: ["billing", "subscription", "upgrade", "invoice", "payment", "pricing", "renew"] },
  { to: "/dashboard/forwarding", label: "Call Forwarding", group: "Workspace", icon: PhoneForwarded, customer: true, keywords: ["forward", "divert", "redirect", "carrier", "activation code", "busy", "unanswered", "receptionist number", "missed calls"] },
  { to: "/dashboard/transfer", label: "Call Transfer", group: "Workspace", icon: PhoneOutgoing, customer: true, module: "transfer", keywords: ["transfer", "human", "handoff", "escalate", "live agent", "team", "ring", "connect to a person"] },
  { to: "/dashboard/booking", label: "Booking", group: "Workspace", icon: CalendarCheck, customer: true, module: "booking", keywords: ["appointments", "calendar", "google calendar", "schedule", "meetings", "slots", "availability", "invite", "reschedule"] },
  { to: "/dashboard/sms-to-caller", label: "SMS to Caller", group: "Workspace", icon: MessageSquareText, customer: true, module: "smsToCaller", premiumWhenLocked: true, keywords: ["sms", "text", "message", "caller", "send details", "link", "address", "quote", "premium"] },
  // Raising a request. Which tier it goes to is the account's own — a customer
  // asks their brand, a brand admin asks the platform — so one entry covers both.
  { to: "/dashboard/support", label: "Support", group: "Workspace", icon: LifeBuoy, keywords: ["help", "ticket", "tickets", "contact", "raise a request", "issue", "problem", "chat with support", "attachment", "platform support"] },
  { to: "/dashboard/settings", label: "Account Settings", group: "Workspace", icon: Settings, keywords: ["profile", "account", "password", "email", "business name", "mobile", "website", "personal"] },
  { to: "/dashboard/admin/overview", label: "Overview", group: "Admin", icon: LayoutGrid, permission: "overview", keywords: ["admin", "metrics", "revenue", "signups", "stats"] },
  { to: "/dashboard/admin/customers", label: "Customers", group: "Admin", icon: Users, permission: "customers", keywords: ["users", "accounts", "clients", "members"] },
  { to: "/dashboard/admin/subscriptions", label: "Subscriptions", group: "Admin", icon: CreditCard, permission: "subscriptions", keywords: ["billing", "mrr", "revenue", "payments", "invoices", "trial", "active", "past due", "canceled", "onboarding", "under onboarding", "leads", "plan history", "renewals", "win-back"] },
  { to: "/dashboard/admin/plans", label: "Plans", group: "Admin", icon: Package, permission: "plans", keywords: ["pricing", "tiers", "packages", "products"] },
  { to: "/dashboard/admin/pricing", label: "Pricing", group: "Admin", icon: BadgeDollarSign, permission: "pricing", keywords: ["addon", "markup", "price", "plans", "brand price", "charges"] },
  { to: "/dashboard/admin/wallet", label: "Wallet", group: "Admin", icon: Wallet, permission: "wallet", keywords: ["balance", "payout", "earnings", "commission", "credits", "money"] },
  // The handler side. Two entries, one path: only one of the permissions is
  // ever reachable for a given account, so exactly one of these shows up.
  { to: "/dashboard/admin/tickets", label: "Support Tickets", group: "Admin", icon: MessagesSquare, permission: "tickets", keywords: ["helpdesk", "support", "queries", "departments", "chat", "requests", "inbox", "escalation", "ratings"] },
  { to: "/dashboard/admin/tickets", label: "Brand Requests", group: "Admin", icon: MessagesSquare, permission: "brand_tickets", keywords: ["helpdesk", "brand support", "tenant requests", "queries", "inbox", "escalation", "ratings"] },
  { to: "/dashboard/admin/coupons", label: "Coupons", group: "Admin", icon: Ticket, permission: "coupons", keywords: ["discount", "promo", "promo code", "voucher", "offer", "percent off"] },
  { to: "/dashboard/admin/voice-bank", label: "Voice Library", group: "Admin", icon: Mic, permission: "voice_bank", keywords: ["voices", "voice bank", "tts", "accents", "samples", "voice category", "deepgram"] },
  { to: "/dashboard/admin/phone-numbers", label: "Phone Numbers", group: "Admin", icon: Phone, permission: "phone_numbers", keywords: ["numbers", "did", "twilio", "caller id", "provisioning"] },
  { to: "/dashboard/admin/resellers", label: "Resellers", group: "Admin", icon: Handshake, permission: "resellers", keywords: ["partners", "commission", "affiliates", "agency"] },
  { to: "/dashboard/admin/emails", label: "System Emails", group: "Admin", icon: Mail, permission: "emails", keywords: ["templates", "transactional", "notifications", "welcome email", "reminder", "receipt"] },
  { to: "/dashboard/admin/audit", label: "Audit Log", group: "Admin", icon: ScrollText, permission: "audit", keywords: ["logs", "activity", "history", "events", "security"] },
  { to: "/dashboard/admin/api-center", label: "API Center", group: "Admin", icon: Radar, superAdminOnly: true, keywords: ["providers", "api usage", "costs", "spend", "latency", "errors", "quotas", "rate limits", "alerts", "vapi", "openai", "deepgram", "twilio", "logs"] },
  { to: "/dashboard/admin/roles", label: "Roles", group: "Admin", icon: ShieldCheck, adminOnly: true, keywords: ["permissions", "access", "access control", "staff roles", "capabilities", "matrix"] },
  { to: "/dashboard/admin/staff", label: "Staff", group: "Admin", icon: UserCog, adminOnly: true, keywords: ["team", "permissions", "roles", "members", "access"] },
  {
    to: "/dashboard/admin/settings",
    label: "Platform Settings",
    group: "Admin",
    icon: Settings,
    // Admins reach this page, but not its Integrations tab — that one holds the
    // platform's provider credentials and stays super-admin-only, on the page
    // and on the API. Not staff-assignable either, hence adminOnly.
    adminOnly: true,
    keywords: [
      "integrations", "api keys", "api key", "secrets", "keys",
      "whatsapp", "meta", "webhook", "verify token", "app secret", "phone number id",
      "vapi", "voice calling", "voice ai",
      "deepgram", "text to speech", "tts",
      "openai", "llm", "gpt", "model",
      "stripe", "billing", "webhook secret",
      "email", "smtp", "sendgrid", "mail", "from address",
      "google calendar", "oauth", "client id", "client secret", "redirect uri",
      "twilio", "perfex",
      "branding", "logo", "favicon", "dark mode logo", "light mode logo", "theme",
    ],
  },
  {
    to: "/dashboard/admin/brands",
    label: "Brands",
    group: "Admin",
    icon: Building2,
    // The tenant panel — creating a brand hands someone a slice of the platform,
    // so it lives with the other SUPER_ADMIN-only areas.
    superAdminOnly: true,
    keywords: [
      "brand", "brands", "tenant", "tenants", "white label", "whitelabel", "multi tenant",
      "subdomain", "custom domain", "dns", "reseller brand",
      "theme", "palette", "colour", "color", "font", "typeface", "logo",
      "brand admin", "new brand", "brand email", "brand sms", "brand whatsapp",
    ],
  },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBodyScrollLock(open);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const role = user?.role;
  const isAdmin = isAdminRole(role);
  const isSuperAdmin = isSuperAdminRole(role);
  const platformOnly = !hasCustomerWorkspace(user?.role);
  const brandModules = useBrandingStore((s) => s.brand?.modules ?? null);

  const email = user?.email?.toLowerCase();
  // Read-only, same as the sidebar badge: whichever screen last fetched
  // entitlements cached them. A stale read only affects the Crown decoration —
  // the module's own page re-checks before unlocking anything.
  const smsToCallerIncluded = cachedSmsToCallerEntitlement();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = DESTINATIONS.filter((d) => {
      if (d.superAdminOnly && !isSuperAdmin) return false;
      if (d.adminOnly && !isAdmin) return false;
      // Brand-scoped sections (Overview, Customers, Subscriptions, Voice
      // Library) are refused to the super admin — don't offer a dead end.
      if (!canUseSection(role, d.permission, user?.brandId)) return false;
      // hasPermission is true for every key when the user is an ADMIN and false
      // for USER/RESELLER — so this one line gates staff by their role's grants
      // *and* keeps the whole admin section out of a customer's results.
      if (d.permission && !hasPermission(d.permission)) return false;
      // RequireCustomer bounces STAFF and the SUPER_ADMIN off these routes, so
      // offering them here would only ever produce a redirect.
      if (d.customer && platformOnly) return false;
      // A module the brand switched off is not a page anyone here can open.
      if (d.module && brandModules && brandModules[d.module] === false) return false;
      // Admins hold no subscription of their own (the sidebar hides this too).
      if (d.hideForAdmin && isAdmin) return false;
      return true;
    });
    if (!q) return visible.map((d) => ({ d, hint: undefined as string | undefined }));

    return visible
      .map((d) => {
        if (d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q)) {
          return { d, hint: undefined as string | undefined };
        }
        // Account Settings also matches the signed-in user's own email.
        if (d.to === "/dashboard/settings" && email?.includes(q)) {
          return { d, hint: email };
        }
        const kw = d.keywords?.find((k) => k.includes(q));
        if (kw) return { d, hint: kw };
        return null;
      })
      .filter((r): r is { d: Destination; hint: string | undefined } => r !== null);
  }, [query, email, role, isAdmin, isSuperAdmin, platformOnly, hasPermission]);

  // Reset state each time the palette opens, and focus the field.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function go(to: string) {
    // Admin destinations are written once against /dashboard/admin; the super
    // admin's panel is served at /superadmin, so rewrite on the way out.
    navigate(adminHref(to, role));
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit.d.to);
    }
  }

  // Keep the active row scrolled into view.
  const setRowRef = (i: number) => (el: HTMLButtonElement | null) => {
    if (el && i === active) el.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* panel */}
      <div
        className="animate-in relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]"
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, jump to…"
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              No matches for “{query}”
            </p>
          ) : (
            results.map(({ d, hint }, i) => {
              const Icon = d.icon;
              const isActive = i === active;
              return (
                <button
                  key={d.to}
                  ref={setRowRef(i)}
                  type="button"
                  onClick={() => go(d.to)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                    isActive ? "bg-primary-tint text-primary" : "text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg",
                      isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{d.label}</span>
                    {hint && (
                      <span className="truncate text-[11px] font-normal capitalize text-muted-foreground">
                        matches “{hint}”
                      </span>
                    )}
                  </span>
                  {d.premiumWhenLocked && !smsToCallerIncluded && (
                    <Crown className="size-4 shrink-0 text-premium" aria-label="Premium feature" />
                  )}
                  <span className="shrink-0 text-[11px] text-muted-foreground">{d.group}</span>
                  {isActive && <CornerDownLeft className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border bg-warm/60 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1">↑</kbd>
            <kbd className="rounded border border-border bg-card px-1">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1">↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
