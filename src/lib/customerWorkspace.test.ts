import { describe, it, expect } from "vitest";
import {
  BRAND_SCOPED_SECTIONS,
  PLATFORM_ONLY_SECTIONS,
  PLATFORM_TEAM_SECTIONS,
  canUseSection,
  hasCustomerWorkspace,
  isAdminRole,
  isSuperAdminRole,
} from "@/lib/roles";
import {
  adminBaseFor,
  adminHref,
  adminLandingPath,
  onboardingRedirectPath,
  sectionForPath,
  sectionsForPath,
  STAFF_NO_ACCESS_PATH,
} from "@/lib/onboardingRoute";
import {
  activeBrandSlug,
  brandBasename,
  setActiveBrandSlug,
  slugFromPath,
} from "@/lib/brandRoute";
import type { AuthUser, UserRole } from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  Who gets a customer workspace, and where the rest are sent.
 *
 *  These two answers drive the sidebar, the bottom bar, the command
 *  palette, RequireCustomer and the post-login redirect. Getting either
 *  wrong is how a super admin ends up staring at an empty Call Inbox —
 *  or, worse, how a real customer loses their own dashboard.
 * ------------------------------------------------------------------ */

function user(role: UserRole, over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1",
    email: "someone@example.com",
    fullName: "Someone",
    role,
    permissions: [],
    plan: "free",
    profile: null,
    ...over,
  };
}

describe("hasCustomerWorkspace", () => {
  it("gives customers and brand admins a workspace", () => {
    // A brand ADMIN keeps theirs on purpose — it's how they place test calls
    // through their own tenant.
    expect(hasCustomerWorkspace("USER")).toBe(true);
    expect(hasCustomerWorkspace("ADMIN")).toBe(true);
  });

  it("gives the super admin and staff none", () => {
    expect(hasCustomerWorkspace("SUPER_ADMIN")).toBe(false);
    expect(hasCustomerWorkspace("STAFF")).toBe(false);
  });

  it("treats an unknown or missing role as a customer", () => {
    // Fail open here: this predicate only decides what to SHOW. The server's
    // guards decide what anyone may actually reach.
    expect(hasCustomerWorkspace(undefined)).toBe(true);
    expect(hasCustomerWorkspace(null)).toBe(true);
  });

  it("does not disturb the admin predicates", () => {
    // The super admin still passes every ADMIN check — losing the customer side
    // must not cost them the admin side.
    expect(isAdminRole("SUPER_ADMIN")).toBe(true);
    expect(isSuperAdminRole("SUPER_ADMIN")).toBe(true);
    expect(isSuperAdminRole("ADMIN")).toBe(false);
  });
});

describe("adminLandingPath", () => {
  it("sends the super admin to the platform overview in their own URL space", () => {
    // Not the brand Overview: that's a brand-scoped section they don't hold. And
    // they carry no permission keys (they bypass the matrix), so running them
    // through the staff logic would strand them on "no access yet".
    expect(adminLandingPath(user("SUPER_ADMIN"))).toBe("/superadmin/platform");
  });

  it("sends a staff member to their first permitted section", () => {
    expect(adminLandingPath(user("STAFF", { permissions: ["coupons.view"] }))).toBe(
      "/dashboard/admin/coupons",
    );
  });

  it("sends a staff member with nothing granted to the no-access screen", () => {
    expect(adminLandingPath(user("STAFF"))).toBe(STAFF_NO_ACCESS_PATH);
  });
});

describe("onboardingRedirectPath", () => {
  it("never lands the super admin on a customer page", () => {
    expect(onboardingRedirectPath(user("SUPER_ADMIN"))).toBe("/superadmin/platform");
  });

  it("still lands a staff member in the admin area", () => {
    expect(onboardingRedirectPath(user("STAFF", { permissions: ["customers.view"] }))).toBe(
      "/dashboard/admin/customers",
    );
  });

  it("leaves an ordinary customer on the dashboard", () => {
    const customer = user("USER", {
      profile: { onboardingCompletedAt: "2026-01-01T00:00:00.000Z" } as AuthUser["profile"],
    });
    expect(onboardingRedirectPath(customer)).toBe("/dashboard");
  });

  it("leaves a brand admin on the dashboard too", () => {
    const admin = user("ADMIN", {
      profile: { onboardingCompletedAt: "2026-01-01T00:00:00.000Z" } as AuthUser["profile"],
    });
    expect(onboardingRedirectPath(admin)).toBe("/dashboard");
  });
});

describe("canUseSection", () => {
  it("refuses the super admin the sections that belong to a brand", () => {
    // A tenant's signup metrics, its customers, their subscriptions, the voices
    // they may pick from and the support requests those customers raise are the
    // brand admin's job — and in a white-label setup one brand's customer list
    // (in a table or in conversation) is that brand's business.
    for (const section of ["overview", "customers", "subscriptions", "voice_bank", "tickets"]) {
      expect({ section, allowed: canUseSection("SUPER_ADMIN", section) }).toEqual({
        section,
        allowed: false,
      });
    }
  });

  it("keeps the platform sections open to the super admin", () => {
    for (const section of ["plans", "coupons", "phone_numbers", "resellers", "emails", "audit"]) {
      expect({ section, allowed: canUseSection("SUPER_ADMIN", section) }).toEqual({
        section,
        allowed: true,
      });
    }
  });

  it("leaves the brand-scoped sections open to every other role", () => {
    // That rule is the super admin's alone: a brand ADMIN still runs their own
    // customer base, and STAFF are gated by their role's grants elsewhere.
    for (const section of BRAND_SCOPED_SECTIONS) {
      expect(canUseSection("ADMIN", section)).toBe(true);
      expect(canUseSection("STAFF", section)).toBe(true);
      expect(canUseSection("USER", section)).toBe(true);
    }
  });

  it("refuses the platform-only sections to everyone but the super admin", () => {
    // The Audit Log is the platform owner's: an audit log a tenant's own admin
    // can read is a weak audit log. Resellers deliberately is NOT here — see
    // the reseller test below.
    expect([...PLATFORM_ONLY_SECTIONS].sort()).toEqual(["audit"]);
    for (const section of PLATFORM_ONLY_SECTIONS) {
      expect({ section, superAdmin: canUseSection("SUPER_ADMIN", section) }).toEqual({
        section,
        superAdmin: true,
      });
      expect({ section, admin: canUseSection("ADMIN", section) }).toEqual({ section, admin: false });
      expect({ section, staff: canUseSection("STAFF", section) }).toEqual({ section, staff: false });
      expect({ section, platformStaff: canUseSection("STAFF", section, null) }).toEqual({
        section,
        platformStaff: false,
      });
    }
  });

  it("gives the platform's team sections to the owner and their own staff only", () => {
    // `brand_tickets` is the inbox of requests brand admins raise WITH the
    // platform — one brand's query is between that brand and the platform, so
    // the owner works it, and so do the staff they employ (no brand). No
    // tenant's admin or staff member can hold it.
    expect([...PLATFORM_TEAM_SECTIONS]).toEqual(["brand_tickets"]);
    expect(canUseSection("SUPER_ADMIN", "brand_tickets", null)).toBe(true);
    expect(canUseSection("STAFF", "brand_tickets", null)).toBe(true);
    expect(canUseSection("STAFF", "brand_tickets", "b_acme")).toBe(false);
    expect(canUseSection("ADMIN", "brand_tickets", "b_acme")).toBe(false);
  });

  it("gives each tier exactly one support inbox, and never the other's", () => {
    // The whole safety property of the two-lane ticket system, stated in terms
    // of the section gates: a brand admin (and their staff) can reach the
    // customer inbox and nothing else; the platform owner (and their staff)
    // the brand inbox and nothing else. No account holds both.
    expect(canUseSection("ADMIN", "tickets", "b_acme")).toBe(true);
    expect(canUseSection("STAFF", "tickets", "b_acme")).toBe(true);
    expect(canUseSection("SUPER_ADMIN", "tickets", null)).toBe(false);
    expect(canUseSection("STAFF", "tickets", null)).toBe(false);

    expect(canUseSection("SUPER_ADMIN", "brand_tickets", null)).toBe(true);
    expect(canUseSection("STAFF", "brand_tickets", null)).toBe(true);
    expect(canUseSection("ADMIN", "brand_tickets", "b_acme")).toBe(false);
    expect(canUseSection("STAFF", "brand_tickets", "b_acme")).toBe(false);

    // A caller that doesn't know the tenant gets the brand-side answer.
    expect(canUseSection("STAFF", "tickets")).toBe(true);
    expect(canUseSection("STAFF", "brand_tickets")).toBe(false);
  });

  it("opens Resellers to brand admins, not just the platform owner", () => {
    // A brand recruits and pays its own resellers, so the section is no longer
    // platform-only. The server narrows every /resellers and /commissions query
    // to the caller's own tenant, so a brand admin still sees only their own.
    expect(PLATFORM_ONLY_SECTIONS.has("resellers")).toBe(false);
    expect(canUseSection("ADMIN", "resellers")).toBe(true);
    expect(canUseSection("SUPER_ADMIN", "resellers")).toBe(true);
    // STAFF clear the scope rule, but "resellers" is absent from the server's
    // SECTIONS matrix, so `resellers.view` is never grantable and hasPermission
    // keeps the nav item hidden for them.
    expect(canUseSection("STAFF", "resellers")).toBe(true);
  });

  it("keeps the scope rules from overlapping", () => {
    // A section in two sets would be reachable by nobody at all.
    for (const section of PLATFORM_ONLY_SECTIONS) {
      expect(BRAND_SCOPED_SECTIONS.has(section)).toBe(false);
      expect(PLATFORM_TEAM_SECTIONS.has(section)).toBe(false);
    }
    for (const section of PLATFORM_TEAM_SECTIONS) {
      expect(BRAND_SCOPED_SECTIONS.has(section)).toBe(false);
    }
  });

  it("allows a path that maps to no section at all", () => {
    expect(canUseSection("SUPER_ADMIN", null)).toBe(true);
  });
});

describe("admin URL spaces", () => {
  it("gives the platform owner /superadmin and everyone else /dashboard/admin", () => {
    expect(adminBaseFor("SUPER_ADMIN")).toBe("/superadmin");
    expect(adminBaseFor("ADMIN")).toBe("/dashboard/admin");
    expect(adminBaseFor("STAFF")).toBe("/dashboard/admin");
  });

  it("rewrites a canonical admin path onto the caller's base", () => {
    // The nav is defined once against /dashboard/admin; this is what lets the
    // same definition serve both prefixes without a second copy.
    expect(adminHref("/dashboard/admin/plans", "SUPER_ADMIN")).toBe("/superadmin/plans");
    expect(adminHref("/dashboard/admin/plans", "ADMIN")).toBe("/dashboard/admin/plans");
    expect(adminHref("/dashboard/admin/api-center", "SUPER_ADMIN")).toBe("/superadmin/api-center");
  });

  it("reads a section from either prefix", () => {
    // Scope rules are written once; both URL spaces have to resolve to the same
    // section or the guard would only protect one of them.
    expect(sectionForPath("/dashboard/admin/customers")).toBe("customers");
    expect(sectionForPath("/superadmin/customers")).toBe("customers");
    expect(sectionForPath("/superadmin/customers/abc123")).toBe("customers");
    expect(sectionForPath("/superadmin/brands")).toBeNull();
  });

  it("reads the handler inbox as whichever section the caller's own tier holds", () => {
    // One page, one path, two sections — the lane comes from the role, so the
    // path alone is ambiguous and the ROLE has to break the tie.
    //
    // This is a regression test with a visible symptom: unresolved, the first
    // matching key won, which is `tickets` — a brand-scoped section the platform
    // owner is refused. RequireAdmin then bounced the super admin off
    // /superadmin/tickets to /superadmin/brands, so their own inbox was
    // UNREACHABLE while its nav link sat right there in the sidebar.
    expect(sectionForPath("/superadmin/tickets", "SUPER_ADMIN")).toBe("brand_tickets");
    expect(sectionForPath("/dashboard/admin/tickets", "ADMIN")).toBe("tickets");
    expect(sectionForPath("/dashboard/admin/tickets", "STAFF")).toBe("tickets");
    // Sub-pages of the inbox resolve the same way.
    expect(sectionForPath("/superadmin/tickets/ratings", "SUPER_ADMIN")).toBe("brand_tickets");
    expect(sectionForPath("/dashboard/admin/tickets/ratings", "ADMIN")).toBe("tickets");
  });

  it("still answers with a section when the role holds neither", () => {
    // A customer never reaches RequireAdmin, but the answer must stay a section
    // rather than null: null means "not a staff-assignable page", which would
    // wave the path through the guard instead of refusing it.
    expect(sectionForPath("/dashboard/admin/tickets", "USER")).not.toBeNull();
    expect(sectionForPath("/dashboard/admin/tickets")).not.toBeNull();
  });

  it("lists both inbox sections for the shared path, and one for every other", () => {
    expect(sectionsForPath("/superadmin/tickets").sort()).toEqual(["brand_tickets", "tickets"]);
    expect(sectionsForPath("/superadmin/customers")).toEqual(["customers"]);
    expect(sectionsForPath("/superadmin/brands")).toEqual([]);
  });
});

describe("brand path routing", () => {
  it("reads the brand slug from the first path segment", () => {
    expect(slugFromPath("/acme")).toBe("acme");
    expect(slugFromPath("/acme/dashboard/calls")).toBe("acme");
    expect(slugFromPath("/Acme-Voice/login")).toBe("acme-voice");
  });

  it("never mistakes a platform route for a brand", () => {
    // A brand called "login" would otherwise swallow the sign-in page.
    for (const path of ["/dashboard", "/superadmin", "/login", "/onboarding", "/subscribe", "/reseller", "/c/abc"]) {
      expect({ path, slug: slugFromPath(path) }).toEqual({ path, slug: null });
    }
  });

  it("rejects segments that could never be a slug, without a round trip", () => {
    for (const path of ["/", "/ab", "/-acme", "/acme_voice", "/favicon.ico", "/" + "a".repeat(41)]) {
      expect({ path, slug: slugFromPath(path) }).toEqual({ path, slug: null });
    }
  });

  it("turns the active slug into a router basename", () => {
    setActiveBrandSlug("acme");
    expect(activeBrandSlug()).toBe("acme");
    expect(brandBasename()).toBe("/acme");
    setActiveBrandSlug(null);
    expect(brandBasename()).toBeUndefined();
  });
});
