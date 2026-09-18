import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { useAuthStore } from "@/stores/useAuthStore";
import { ENTITLEMENTS_CACHE_KEY } from "@/lib/planFeatures";
import type { AuthUser } from "@/lib/api";

// The palette duplicates the nav and can drift from the sidebar and route guards. These pin the rule:
// a row is offered only when that role could actually open the page.

// jsdom has no layout engine, so the 'scroll the active row into view' ref
// call has nothing to implement. Stub it — it is decoration, not behaviour.
Element.prototype.scrollIntoView = vi.fn();

const CUSTOMER_MODULES = [
  "Dashboard",
  "Call Inbox",
  "AI Brain",
  "Connect CRM",
  "Call Forwarding",
  "Call Transfer",
  "Booking",
  "SMS to Caller",
];

const user = (role: AuthUser["role"], permissions: string[] = []): AuthUser =>
  ({
    id: "u1",
    email: "a@b.com",
    fullName: "A B",
    role,
    permissions,
    plan: "free",
    profile: null,
  }) as AuthUser;

function setup(signedInAs: AuthUser) {
  useAuthStore.setState({ user: signedInAs, status: "authed" });
  render(
    <MemoryRouter>
      <CommandPalette open onClose={vi.fn()} />
    </MemoryRouter>,
  );
  const list = screen.getByRole("dialog");
  const rows = () =>
    within(list)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
  const has = (label: string) => rows().some((t) => t.startsWith(label));
  return { has, rows };
}

describe("CommandPalette — what each role is offered", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: null });
  });

  it("offers a customer every module in the sidebar, and nothing from Admin", () => {
    const { has, rows } = setup(user("USER"));

    for (const label of CUSTOMER_MODULES) expect(has(label), label).toBe(true);
    expect(has("Plans & Billing")).toBe(true);
    expect(has("Account Settings")).toBe(true);

    // No admin section leaks into a customer's search.
    expect(rows().some((t) => t.includes("Admin"))).toBe(false);
  });

  it("hides Plans & Billing from an ADMIN but keeps the admin areas", () => {
    const { has } = setup(user("ADMIN"));

    expect(has("Plans & Billing")).toBe(false);
    expect(has("Dashboard")).toBe(true); // admins do hold a real profile
    for (const label of [
      "Coupons",
      "System Emails",
      "Roles",
      "Staff",
      "Platform Settings",
    ]) {
      expect(has(label), label).toBe(true);
    }

    // Platform-owner areas refused to a brand admin (see PLATFORM_ONLY_SECTIONS / superAdminOnly).
    for (const label of ["API Center", "Audit Log", "Voice Library", "Brands"]) {
      expect(has(label), label).toBe(false);
    }
  });

  it("offers STAFF only their granted sections — no customer modules, no admin-only areas", () => {
    const { has } = setup(user("STAFF", ["customers.view", "audit.view"]));

    for (const label of CUSTOMER_MODULES) expect(has(label), label).toBe(false);
    expect(has("Plans & Billing")).toBe(false);
    // Reachable: settings is not a customer route.
    expect(has("Account Settings")).toBe(true);

    expect(has("Customers")).toBe(true);
    // Audit is platform-only now, so the grant is a no-op: `audit.view` is not
    // in the staff matrix any more and the scope rule hides it regardless.
    expect(has("Audit Log")).toBe(false);
    // Not granted / not staff-assignable at all.
    expect(has("Subscriptions")).toBe(false);
    expect(has("Roles")).toBe(false);
    expect(has("Staff")).toBe(false);
    expect(has("Platform Settings")).toBe(false);
  });

  it("keeps the sidebar's hidden admin pages out of search", () => {
    const { has } = setup(user("ADMIN"));

    expect(has("System Health")).toBe(false);
    expect(has("Webhook Logs")).toBe(false);
    expect(has("Reports")).toBe(false);
  });
});

describe("CommandPalette — plan gating", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: null });
  });

  it("marks SMS to Caller premium when the plan doesn't include it — but still lists it", () => {
    localStorage.setItem(ENTITLEMENTS_CACHE_KEY, JSON.stringify({ smsToCaller: false }));
    const { has } = setup(user("USER"));

    expect(has("SMS to Caller")).toBe(true); // discoverable, like the sidebar item
    expect(screen.getByLabelText("Premium feature")).toBeInTheDocument();
  });

  it("shows no crown when the plan includes it", () => {
    localStorage.setItem(ENTITLEMENTS_CACHE_KEY, JSON.stringify({ smsToCaller: true }));
    setup(user("USER"));

    expect(screen.queryByLabelText("Premium feature")).not.toBeInTheDocument();
  });
});
