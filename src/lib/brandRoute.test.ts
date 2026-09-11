import { describe, it, expect, beforeEach } from "vitest";
import {
  RESERVED_PATH_SEGMENTS,
  activeBrandSlug,
  brandBasename,
  brandDoor,
  brandPath,
  setActiveBrandSlug,
  setHostBrand,
  slugFromPath,
} from "./brandRoute";

/* ------------------------------------------------------------------ *
 *  Which door this page load came through, and what that means for a
 *  URL built by hand.
 *
 *  The distinction earns its keep in one place: a full page navigation
 *  (window.location) bypasses the router, so the brand prefix a path
 *  door relies on has to be applied deliberately — see brandPath.
 * ------------------------------------------------------------------ */

beforeEach(() => setActiveBrandSlug(null));

describe("slugFromPath", () => {
  it("reads a brand slug from the first segment", () => {
    expect(slugFromPath("/acme")).toBe("acme");
    expect(slugFromPath("/acme/dashboard/calls")).toBe("acme");
    expect(slugFromPath("/ACME")).toBe("acme");
  });

  it("never mistakes the platform's own routes for a brand", () => {
    for (const segment of RESERVED_PATH_SEGMENTS) {
      expect(slugFromPath(`/${segment}`)).toBeNull();
    }
    // A brand could never take over /login even if the slug check were bypassed
    // at creation time, which is the point of checking before the network.
    expect(slugFromPath("/login")).toBeNull();
    expect(slugFromPath("/superadmin/brands")).toBeNull();
  });

  it("rejects anything that isn't slug-shaped, without a round trip", () => {
    expect(slugFromPath("/")).toBeNull();
    expect(slugFromPath("/ab")).toBeNull(); // too short
    expect(slugFromPath(`/${"a".repeat(41)}`)).toBeNull(); // too long
    expect(slugFromPath("/-acme")).toBeNull();
    expect(slugFromPath("/acme-")).toBeNull();
    expect(slugFromPath("/acme_voice")).toBeNull();
    expect(slugFromPath("/logo.png")).toBeNull();
  });
});

describe("the two doors", () => {
  it("a path door names the brand AND becomes the router's basename", () => {
    setActiveBrandSlug("acme");
    expect(brandDoor()).toEqual({ slug: "acme", mode: "path" });
    expect(activeBrandSlug()).toBe("acme");
    expect(brandBasename()).toBe("/acme");
  });

  it("a host door names the brand but adds no prefix — the host IS the door", () => {
    setHostBrand("acme");
    expect(brandDoor()).toEqual({ slug: "acme", mode: "host" });
    expect(activeBrandSlug()).toBe("acme");
    expect(brandBasename()).toBeUndefined();
  });

  it("clears back to the platform", () => {
    setHostBrand("acme");
    setActiveBrandSlug(null);
    expect(brandDoor()).toBeNull();
    expect(activeBrandSlug()).toBeNull();
    expect(brandBasename()).toBeUndefined();
  });
});

describe("brandPath", () => {
  it("keeps a path-door customer on their own front door", () => {
    // The bug this exists for: a bare "/login" in window.location.assign drops
    // an Acme customer onto the PLATFORM's sign-in page, wearing the platform's
    // name and colours.
    setActiveBrandSlug("acme");
    expect(brandPath("/login")).toBe("/acme/login");
    expect(brandPath("/dashboard/assistant")).toBe("/acme/dashboard/assistant");
  });

  it("adds nothing on a host door or on the platform", () => {
    setHostBrand("acme");
    expect(brandPath("/login")).toBe("/login");
    setActiveBrandSlug(null);
    expect(brandPath("/login")).toBe("/login");
  });

  it("tolerates a path given without its leading slash", () => {
    setActiveBrandSlug("acme");
    expect(brandPath("login")).toBe("/acme/login");
  });
});
