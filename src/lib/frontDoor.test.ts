import { describe, it, expect } from "vitest";

// The RequireBrandFrontDoor rule: an account on the wrong door sees the wrong brand's name, logo and colours.

import { frontDoorTarget } from "./frontDoor";

describe("frontDoorTarget", () => {
  it("sends a brand's user from the bare path into their brand", () => {
    // The case that matters: an Acme customer signs in at the platform URL and
    // would otherwise see their own data wearing the platform's branding.
    expect(
      frontDoorTarget({ accountSlug: "acme", pageSlug: null, pathname: "/dashboard" }),
    ).toBe("/acme/dashboard");
  });

  it("carries the path, query and hash across", () => {
    expect(
      frontDoorTarget({
        accountSlug: "acme",
        pageSlug: null,
        pathname: "/dashboard/calls",
        search: "?filter=missed",
        hash: "#call_9",
      }),
    ).toBe("/acme/dashboard/calls?filter=missed#call_9");
  });

  it("moves a user between brands rather than nesting the prefixes", () => {
    expect(
      frontDoorTarget({ accountSlug: "acme", pageSlug: "northwind", pathname: "/northwind/dashboard" }),
    ).toBe("/acme/dashboard");
  });

  it("sends a platform account back out of a brand's prefix", () => {
    // A super admin (no brand) has no business under a tenant's front door.
    expect(
      frontDoorTarget({ accountSlug: null, pageSlug: "acme", pathname: "/acme/superadmin/brands" }),
    ).toBe("/superadmin/brands");
  });

  it("leaves a matching pair alone", () => {
    expect(frontDoorTarget({ accountSlug: "acme", pageSlug: "acme", pathname: "/acme/dashboard" })).toBeNull();
    expect(frontDoorTarget({ accountSlug: null, pageSlug: null, pathname: "/dashboard" })).toBeNull();
  });

  it("handles the brand root without producing a doubled slash", () => {
    expect(frontDoorTarget({ accountSlug: null, pageSlug: "acme", pathname: "/acme" })).toBe("/");
    expect(frontDoorTarget({ accountSlug: "acme", pageSlug: null, pathname: "/" })).toBe("/acme/");
  });

  it("does not mistake a lookalike path for the brand prefix", () => {
    // Slicing "/acmecorp" blindly produced "corp/dashboard"; the right answer is no redirect.
    expect(
      frontDoorTarget({ accountSlug: null, pageSlug: "acme", pathname: "/acmecorp/dashboard" }),
    ).toBeNull();
  });
});

describe("frontDoorTarget on a brand host", () => {
  // acme.hello22.ai, or the brand's own verified domain: the host is the door,
  // so the path carries no prefix and no prefix is ever added.
  it("leaves a brand's own user where they are", () => {
    expect(
      frontDoorTarget({ accountSlug: "acme", pageSlug: "acme", pageMode: "host", pathname: "/dashboard" }),
    ).toBeNull();
  });

  it("lets a platform-level account work inside a brand's host", () => {
    // The super admin helping inside Acme: the brand's look is what they came
    // for, and there is no "bare" version of a host to send them to anyway.
    expect(
      frontDoorTarget({ accountSlug: null, pageSlug: "acme", pageMode: "host", pathname: "/superadmin/brands" }),
    ).toBeNull();
  });

  it("sends another brand's user to their own origin — the path can't fix a host", () => {
    expect(
      frontDoorTarget({
        accountSlug: "northwind",
        accountOrigin: "https://app.northwind.example/",
        pageSlug: "acme",
        pageMode: "host",
        pathname: "/dashboard/calls",
        search: "?filter=missed",
      }),
    ).toBe("https://app.northwind.example/dashboard/calls?filter=missed");
  });

  it("stays put rather than guess when the account's origin is unknown", () => {
    expect(
      frontDoorTarget({ accountSlug: "northwind", pageSlug: "acme", pageMode: "host", pathname: "/dashboard" }),
    ).toBeNull();
  });
});

describe("frontDoorTarget on a developer's machine", () => {
  // A brand origin is always a real https host, so acting on it locally would jump to production.
  it("stays put rather than jump from a local host to a production origin", () => {
    for (const origin of [
      "http://acme.localhost:5174",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
    ]) {
      expect(
        frontDoorTarget({
          accountSlug: "northwind",
          accountOrigin: "https://northwind.hello22.ai",
          pageSlug: "acme",
          pageMode: "host",
          pageOrigin: origin,
          pathname: "/dashboard",
        }),
      ).toBeNull();
    }
  });

  it("still moves them between real hosts", () => {
    expect(
      frontDoorTarget({
        accountSlug: "northwind",
        accountOrigin: "https://northwind.hello22.ai",
        pageSlug: "acme",
        pageMode: "host",
        pageOrigin: "https://acme.hello22.ai",
        pathname: "/dashboard",
      }),
    ).toBe("https://northwind.hello22.ai/dashboard");
  });

  it("leaves path routing alone — rewriting a path never changes origin", () => {
    expect(
      frontDoorTarget({
        accountSlug: "acme",
        pageSlug: null,
        pageOrigin: "http://localhost:5174",
        pathname: "/dashboard",
      }),
    ).toBe("/acme/dashboard");
  });
});
