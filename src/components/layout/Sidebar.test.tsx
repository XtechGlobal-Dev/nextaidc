// Named .tsx so it runs under the jsdom project — see vitest.config.ts.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// useUiStore applies the theme at import time via matchMedia, which jsdom
// doesn't implement. Stub it before any module is evaluated (vi.hoisted runs first).
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/useAuthStore";
import type { AuthUser } from "@/lib/api";

// For ADMINs the customer modules fold into one "User Dashboard" panel (listing both navs doubled the
// sidebar). USER keeps them inline; STAFF/SUPER_ADMIN get neither.

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

const user = (role: AuthUser["role"]): AuthUser =>
  ({
    id: "u1",
    email: "a@b.com",
    fullName: "A B",
    role,
    permissions: [],
    plan: "free",
    profile: null,
  }) as AuthUser;

function setup(signedInAs: AuthUser, at = "/dashboard/admin/overview") {
  useAuthStore.setState({ user: signedInAs, status: "authed" });
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[at]}>
        <Sidebar />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

// The panel is `aria-hidden` while closed, so role queries only see it open.
const panel = () => screen.queryByRole("dialog", { name: "User Dashboard" });
const trigger = () => screen.queryByRole("button", { name: "User Dashboard" });
const link = (label: string) => screen.queryByRole("link", { name: label });

describe("Sidebar — the admin's User Dashboard panel", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: null });
  });

  it("folds an ADMIN's customer modules into one button, closed by default", () => {
    setup(user("ADMIN"));

    const btn = trigger();
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(panel()).not.toBeInTheDocument();
    for (const label of CUSTOMER_MODULES) expect(link(label), label).not.toBeInTheDocument();

    // The admin areas are untouched.
    expect(link("Customers")).toBeInTheDocument();
  });

  it("opens the panel with every module (minus Plans & Billing) and closes it from its close button", () => {
    setup(user("ADMIN"));

    fireEvent.click(trigger()!);

    const dialog = panel();
    expect(dialog).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    for (const label of CUSTOMER_MODULES) {
      expect(within(dialog!).getByRole("link", { name: label }), label).toBeInTheDocument();
    }
    // An admin owns no subscription — hidden here exactly as it was inline.
    expect(within(dialog!).queryByRole("link", { name: "Plans & Billing" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog!).getByRole("button", { name: "Close User Dashboard" }));

    expect(panel()).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(link("Call Inbox")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    setup(user("ADMIN"));
    fireEvent.click(trigger()!);
    expect(panel()).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(panel()).not.toBeInTheDocument();
  });

  it("closes on a press outside the panel", () => {
    setup(user("ADMIN"));
    fireEvent.click(trigger()!);
    expect(panel()).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(panel()).not.toBeInTheDocument();
  });

  it("closes once a module inside it is opened", () => {
    setup(user("ADMIN"));
    fireEvent.click(trigger()!);

    fireEvent.click(within(panel()!).getByRole("link", { name: "Call Inbox" }));

    expect(panel()).not.toBeInTheDocument();
  });

  it("lights the button up while on one of the pages it holds", () => {
    setup(user("ADMIN"), "/dashboard/calls");
    expect(trigger()).toHaveClass("text-primary");
  });

  it("keeps a USER's modules inline — no folding", () => {
    setup(user("USER"), "/dashboard");

    expect(trigger()).not.toBeInTheDocument();
    for (const label of CUSTOMER_MODULES) expect(link(label), label).toBeInTheDocument();
    expect(link("Plans & Billing")).toBeInTheDocument();
  });

  it.each(["STAFF", "SUPER_ADMIN"] as const)(
    "shows %s neither the button nor the modules — they have no customer workspace",
    (role) => {
      setup(user(role));

      expect(trigger()).not.toBeInTheDocument();
      expect(panel()).not.toBeInTheDocument();
      for (const label of CUSTOMER_MODULES) expect(link(label), label).not.toBeInTheDocument();
    },
  );
});
