import { lazy, Suspense, useEffect, useState } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { RequireAdmin } from "@/components/auth/RequireAdmin";
import { RequireSuperAdmin } from "@/components/auth/RequireSuperAdmin";
import { RequireBrandFrontDoor } from "@/components/auth/RequireBrandFrontDoor";
import { RequireCustomer } from "@/components/auth/RequireCustomer";
import { RedirectIfAuthed } from "@/components/auth/RedirectIfAuthed";
import { Loader2 } from "lucide-react";
import { captureReferralFromUrl } from "@/lib/referral";
import { clearChunkReloadGuard, clearBootReloadGuard } from "@/lib/chunkReload";
import { RouteError } from "@/components/RouteError";
import { ScrollToTop } from "@/components/ScrollToTop";
import { SeoManager } from "@/components/SeoManager";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { OnboardingGate } from "@/components/auth/OnboardingGate";
import { brandBasename, setActiveBrandSlug, setHostBrand, slugFromPath } from "@/lib/brandRoute";

const LandingPage = lazy(() => import("@/pages/marketing/LandingPage"));
const OnboardingPage = lazy(() => import("@/pages/onboarding/OnboardingPage"));
const LoginPage = lazy(() => import("@/pages/auth/LoginPage"));
const SubscribePage = lazy(() => import("@/pages/subscribe/SubscribePage"));
const ResellerPortalPage = lazy(() => import("@/pages/reseller/ResellerPortalPage"));
const DashboardPage = lazy(() => import("@/pages/dashboard/DashboardPage"));
const CallInboxPage = lazy(() => import("@/pages/calls/CallInboxPage"));
const AiBrainPage = lazy(() => import("@/pages/assistant/AiBrainPage"));
const ConnectCrmPage = lazy(() => import("@/pages/crm/ConnectCrmPage"));
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage"));
const NotificationsPage = lazy(() => import("@/pages/notifications/NotificationsPage"));
const SupportPage = lazy(() => import("@/pages/support/SupportPage"));
const PlansPage = lazy(() => import("@/pages/billing/PlansPage"));
const CallForwardingPage = lazy(() => import("@/pages/forwarding/CallForwardingPage"));
const HumanTransferPage = lazy(() => import("@/pages/transfer/HumanTransferPage"));
const BookingPage = lazy(() => import("@/pages/booking/BookingPage"));
const SmsToCallerPage = lazy(() => import("@/pages/smsToCaller/SmsToCallerPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));
const StaffNoAccessPage = lazy(() => import("@/pages/StaffNoAccessPage"));

const AdminOverviewPage = lazy(() => import("@/pages/admin/AdminOverviewPage"));
const AdminPlatformOverviewPage = lazy(() => import("@/pages/admin/AdminPlatformOverviewPage"));
const AdminCustomersPage = lazy(() => import("@/pages/admin/AdminCustomersPage"));
const AdminSubscriptionsPage = lazy(() => import("@/pages/admin/AdminSubscriptionsPage"));
const AdminPlansPage = lazy(() => import("@/pages/admin/AdminPlansPage"));
const AdminCouponsPage = lazy(() => import("@/pages/admin/AdminCouponsPage"));
const AdminResellersPage = lazy(() => import("@/pages/admin/AdminResellersPage"));
const AdminBrandPricingPage = lazy(() => import("@/pages/admin/AdminBrandPricingPage"));
const AdminBrandWalletPage = lazy(() => import("@/pages/admin/AdminBrandWalletPage"));
const AdminSettingsPage = lazy(() => import("@/pages/admin/AdminSettingsPage"));
const AdminVoiceBankPage = lazy(() => import("@/pages/admin/AdminVoiceBankPage"));
const AdminAuditLogPage = lazy(() => import("@/pages/admin/AdminAuditLogPage"));
const AdminWebhookLogsPage = lazy(() => import("@/pages/admin/AdminWebhookLogsPage"));
const AdminSystemHealthPage = lazy(() => import("@/pages/admin/AdminSystemHealthPage"));
const AdminSystemEmailsPage = lazy(() => import("@/pages/admin/AdminSystemEmailsPage"));
const AdminCustomerDetailPage = lazy(() => import("@/pages/admin/AdminCustomerDetailPage"));
const AdminReportsPage = lazy(() => import("@/pages/admin/AdminReportsPage"));
const AdminPhoneNumbersPage = lazy(() => import("@/pages/admin/phone-numbers/AdminPhoneNumbersPage"));
const AdminStaffPage = lazy(() => import("@/pages/admin/AdminStaffPage"));
const AdminStaffDetailPage = lazy(() => import("@/pages/admin/AdminStaffDetailPage"));
const AdminRolesPage = lazy(() => import("@/pages/admin/AdminRolesPage"));
const AdminRoleDetailPage = lazy(() => import("@/pages/admin/AdminRoleDetailPage"));

// Support inbox — one page under both prefixes; the API picks the lane from the caller's role,
// so a brand admin sees their customers' requests and the platform owner sees their brands'.
const AdminTicketsPage = lazy(() => import("@/pages/admin/tickets/AdminTicketsPage"));
const AdminTicketRatingsPage = lazy(
  () => import("@/pages/admin/tickets/AdminTicketRatingsPage"),
);

// Super-admin only: the white-label brand (tenant) panel.
const AdminBrandsPage = lazy(() => import("@/pages/admin/brands/AdminBrandsPage"));
const AdminBrandDetailPage = lazy(() => import("@/pages/admin/brands/AdminBrandDetailPage"));
const AdminBrandCreatePage = lazy(() => import("@/pages/admin/brands/AdminBrandCreatePage"));

// API Center. Each section is its own chunk so opening the admin area doesn't
// pull every screen's charts and tables the operator may never visit.
const ApiCenterLayout = lazy(() => import("@/pages/admin/api-center/ApiCenterLayout"));
const ApiCenterOverviewPage = lazy(() => import("@/pages/admin/api-center/OverviewPage"));
const ApiCenterProvidersPage = lazy(() => import("@/pages/admin/api-center/ProvidersPage"));
const ApiCenterActivityPage = lazy(() => import("@/pages/admin/api-center/ActivityPage"));
const ApiCenterCostsPage = lazy(() => import("@/pages/admin/api-center/CostsPage"));
const ApiCenterSettingsPage = lazy(() => import("@/pages/admin/api-center/SettingsPage"));

function PageFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}

// Data router (createBrowserRouter), not <BrowserRouter>, so pages can guard navigation
// with useBlocker (AI Brain unsaved-changes prompt).
function RootLayout() {
  return (
    <>
      <ScrollToTop />
      <SeoManager />
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </>
  );
}

// Admin routes, mounted under both `/dashboard/admin` and `/superadmin` so the two trees can
// never drift; the per-page guards decide who gets in.
function adminRoutes(base: string) {
  return (
    <>
        {/* The platform as a whole — the super admin's overview, from the
            nightly rollup. A brand admin's overview is /overview below. */}
        <Route
          path={`${base}/platform`}
          element={<RequireSuperAdmin><AdminPlatformOverviewPage /></RequireSuperAdmin>}
        />
        {/* Admin-only */}
        <Route
          path={`${base}/overview`}
          element={<RequireAdmin><AdminOverviewPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/customers`}
          element={<RequireAdmin><AdminCustomersPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/customers/:id`}
          element={<RequireAdmin><AdminCustomerDetailPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/subscriptions`}
          element={<RequireAdmin><AdminSubscriptionsPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/plans`}
          element={<RequireAdmin><AdminPlansPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/coupons`}
          element={<RequireAdmin><AdminCouponsPage /></RequireAdmin>}
        />
        {/* A brand admin's own pricing addons and wallet (brand-scoped). */}
        <Route
          path={`${base}/pricing`}
          element={<RequireAdmin><AdminBrandPricingPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/wallet`}
          element={<RequireAdmin><AdminBrandWalletPage /></RequireAdmin>}
        />
        {/* Support requests. RequireAdmin lets STAFF in as well; which lane
            they get, and what they may do in it, is decided server-side. */}
        <Route
          path={`${base}/tickets`}
          element={<RequireAdmin><AdminTicketsPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/tickets/ratings`}
          element={<RequireAdmin><AdminTicketRatingsPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/voice-bank`}
          element={<RequireAdmin><AdminVoiceBankPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/phone-numbers`}
          element={<RequireAdmin><AdminPhoneNumbersPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/resellers`}
          element={<RequireAdmin><AdminResellersPage /></RequireAdmin>}
        />
        {/* Open to admins minus the Integrations tab — the page hides it and `/admin/integrations*`
            stays on requireSuperAdmin, so credentials are refused either way. */}
        <Route
          path={`${base}/settings`}
          element={<RequireAdmin><AdminSettingsPage /></RequireAdmin>}
        />

        {/* White-label brands (tenants) — create a brand, its subdomain, its
            look and its own mail/SMS/WhatsApp senders. */}
        <Route
          path={`${base}/brands`}
          element={<RequireSuperAdmin><AdminBrandsPage /></RequireSuperAdmin>}
        />
        <Route
          path={`${base}/brands/new`}
          element={<RequireSuperAdmin><AdminBrandCreatePage /></RequireSuperAdmin>}
        />
        <Route
          path={`${base}/brands/:id`}
          element={<RequireSuperAdmin><AdminBrandDetailPage /></RequireSuperAdmin>}
        />
        <Route
          path={`${base}/emails`}
          element={<RequireAdmin><AdminSystemEmailsPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/health`}
          element={<RequireAdmin><AdminSystemHealthPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/webhooks`}
          element={<RequireAdmin><AdminWebhookLogsPage /></RequireAdmin>}
        />
        {/* The layout owns the shared snapshot/filters/drawer; sections render into its outlet so
            every tab describes the same moment. */}
        <Route
          path={`${base}/api-center`}
          element={<RequireSuperAdmin><ApiCenterLayout /></RequireSuperAdmin>}
        >
          <Route index element={<ApiCenterOverviewPage />} />
          <Route path="providers" element={<ApiCenterProvidersPage />} />
          <Route path="activity" element={<ApiCenterActivityPage />} />
          <Route path="costs" element={<ApiCenterCostsPage />} />
          <Route path="settings" element={<ApiCenterSettingsPage />} />
          {/* Redirects for the old twelve-section URLs. Absolute targets on purpose: a relative `to`
              resolves against the redirecting route, sending /…/connections to /…/connections/providers. */}
          <Route path="connections" element={<Navigate to={`${base}/api-center/providers`} replace />} />
          <Route path="health" element={<Navigate to={`${base}/api-center/providers`} replace />} />
          <Route path="quotas" element={<Navigate to={`${base}/api-center/providers`} replace />} />
          <Route path="keys" element={<Navigate to={`${base}/api-center/providers`} replace />} />
          <Route path="usage" element={<Navigate to={`${base}/api-center/activity`} replace />} />
          <Route path="latency" element={<Navigate to={`${base}/api-center/activity`} replace />} />
          <Route path="errors" element={<Navigate to={`${base}/api-center/activity`} replace />} />
          <Route path="logs" element={<Navigate to={`${base}/api-center/activity`} replace />} />
          <Route path="alerts" element={<Navigate to={`${base}/api-center/settings`} replace />} />
        </Route>
        <Route
          path={`${base}/reports`}
          element={<RequireAdmin><AdminReportsPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/audit`}
          element={<RequireAdmin><AdminAuditLogPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/staff`}
          element={<RequireAdmin><AdminStaffPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/staff/new`}
          element={<RequireAdmin><AdminStaffDetailPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/staff/:id`}
          element={<RequireAdmin><AdminStaffDetailPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/roles`}
          element={<RequireAdmin><AdminRolesPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/roles/new`}
          element={<RequireAdmin><AdminRoleDetailPage /></RequireAdmin>}
        />
        <Route
          path={`${base}/roles/:id`}
          element={<RequireAdmin><AdminRoleDetailPage /></RequireAdmin>}
        />
    </>
  );
}

function buildRouter(basename?: string) {
  return createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />} errorElement={<RouteError />}>
      <Route path="/" element={<RedirectIfAuthed><LandingPage /></RedirectIfAuthed>} />
      <Route
        path="/onboarding"
        element={
          <OnboardingGate>
            <OnboardingPage />
          </OnboardingGate>
        }
      />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/subscribe"
        element={
          <RequireAuth>
            <RequireBrandFrontDoor>
              <SubscribePage />
            </RequireBrandFrontDoor>
          </RequireAuth>
        }
      />
      <Route
        path="/reseller"
        element={
          <RequireAuth>
            <RequireBrandFrontDoor>
              <ResellerPortalPage />
            </RequireBrandFrontDoor>
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            {/* Brand users belong under /{slug}, platform accounts on the bare path — see
                RequireBrandFrontDoor for why this is a full page load. */}
            <RequireBrandFrontDoor>
              <AppLayout />
            </RequireBrandFrontDoor>
          </RequireAuth>
        }
      >
        {/* Customer-facing — STAFF (no customer profile) are redirected to their
            admin landing so these never hang on a perpetual loading skeleton. */}
        <Route path="/dashboard" element={<RequireCustomer><DashboardPage /></RequireCustomer>} />
        <Route path="/dashboard/calls" element={<RequireCustomer><CallInboxPage /></RequireCustomer>} />
        <Route path="/dashboard/assistant" element={<RequireCustomer><AiBrainPage /></RequireCustomer>} />
        <Route path="/dashboard/crm" element={<RequireCustomer><ConnectCrmPage /></RequireCustomer>} />
        <Route path="/dashboard/plans" element={<RequireCustomer><PlansPage /></RequireCustomer>} />
        <Route path="/dashboard/forwarding" element={<RequireCustomer><CallForwardingPage /></RequireCustomer>} />
        <Route path="/dashboard/transfer" element={<RequireCustomer><HumanTransferPage /></RequireCustomer>} />
        <Route path="/dashboard/booking" element={<RequireCustomer><BookingPage /></RequireCustomer>} />
        <Route path="/dashboard/sms-to-caller" element={<RequireCustomer><SmsToCallerPage /></RequireCustomer>} />
        <Route path="/dashboard/settings" element={<SettingsPage />} />
        {/* No customer guard — every role gets its own requests (customer → brand, brand admin →
            platform); staff and the owner raise none and the page says so. */}
        <Route path="/dashboard/support" element={<SupportPage />} />
        <Route path="/dashboard/notifications" element={<NotificationsPage />} />

        {/* Staff with no permitted section land here (see StaffNoAccessPage). */}
        <Route
          path="/dashboard/no-access"
          element={<RequireAdmin><StaffNoAccessPage /></RequireAdmin>}
        />

        {/* Brand admins. */}
        {adminRoutes("/dashboard/admin")}

        {/* Same pages behind one more guard, so nothing here is reachable without being the
            super admin — and /superadmin can never be a brand. */}
        <Route element={<RequireSuperAdmin><Outlet /></RequireSuperAdmin>}>
          <Route path="/superadmin" element={<Navigate to="/superadmin/platform" replace />} />
          {adminRoutes("/superadmin")}
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Route>,
  ),
  // On example.com/acme the basename is "/acme", so every Link/redirect/navigate() keeps
  // the brand prefix without knowing it exists.
  { basename },
  );
}

export function App() {
  // Can't build the router until we know whether the first path segment is a brand (it becomes
  // the basename). Set the slug provisionally, let /api/config confirm or drop it.
  const [router, setRouter] = useState<ReturnType<typeof buildRouter> | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      captureReferralFromUrl();
      const slug = slugFromPath(window.location.pathname);
      setActiveBrandSlug(slug);
      await useBrandingStore.getState().refresh();
      const brand = useBrandingStore.getState().brand;
      if (brand && brand.slug !== slug) {
        // The HOST (subdomain / verified domain) named the brand, resolved from Origin. No basename
        // then — the app lives at plain /dashboard and any path segment stays part of the route.
        setHostBrand(brand.slug);
      } else if (slug && !brand) {
        // Not a live brand (typo, suspended tenant) — keep the segment in the route so it hits
        // not-found instead of being swallowed by the basename.
        setActiveBrandSlug(null);
      }
      if (!active) return;
      setRouter(buildRouter(brandBasename()));
      // App mounted cleanly → reset the one-reload budgets so a future deploy's
      // stale-chunk or failed boot can self-heal again.
      clearChunkReloadGuard();
      clearBootReloadGuard();
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!router) return <PageFallback />;
  return <RouterProvider router={router} />;
}
