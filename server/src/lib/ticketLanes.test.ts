import { describe, it, expect } from "vitest";
import {
  departmentTenant,
  handlerLane,
  handlerSection,
  holdsEveryQueue,
  laneCopy,
  requesterLane,
} from "./ticketLanes.js";

/* ------------------------------------------------------------------ *
 *  The lane wall.
 *
 *  These four functions are the ONLY thing deciding which support
 *  conversation an account can reach, and they are driven purely by
 *  role — never by a request body. So the table below is the security
 *  property of the whole ticket system, stated once:
 *
 *    a customer talks UP to their brand, and nowhere else
 *    a brand admin talks UP to the platform, and DOWN to its customers
 *    the platform owner talks DOWN to the brands, and nowhere else
 * ------------------------------------------------------------------ */

describe("requesterLane — who asks, and whom", () => {
  it("sends a customer's request up to their own brand", () => {
    expect(requesterLane("USER")).toBe("support");
  });

  it("sends a reseller's the same way — they are a brand's account holder too", () => {
    expect(requesterLane("RESELLER")).toBe("support");
  });

  it("sends a brand admin's request up to the platform", () => {
    expect(requesterLane("ADMIN")).toBe("brand");
  });

  it("gives a staff member nowhere to raise one", () => {
    // Staff work inside a brand's team; they take it up with their own admin,
    // not through a ticket to a tier that has no idea who they are.
    expect(requesterLane("STAFF")).toBeNull();
  });

  it("gives the platform owner nowhere to raise one — there is no tier above", () => {
    expect(requesterLane("SUPER_ADMIN")).toBeNull();
  });

  it("refuses an unknown or missing role rather than guessing a lane", () => {
    expect(requesterLane(null)).toBeNull();
    expect(requesterLane(undefined)).toBeNull();
    expect(requesterLane("ROBOT")).toBeNull();
  });
});

describe("handlerLane — who answers, and whose", () => {
  it("gives a brand admin their customers' queue", () => {
    expect(handlerLane("ADMIN", "b_acme")).toBe("support");
  });

  it("gives a brand's staff the same queue", () => {
    expect(handlerLane("STAFF", "b_acme")).toBe("support");
  });

  it("gives the platform owner the brands' queue, and only that", () => {
    // The one line that keeps a tenant's customer conversations out of the
    // platform owner's inbox: their lane is `brand`, so a `support` ticket is
    // not merely hidden from them, it is unreachable.
    expect(handlerLane("SUPER_ADMIN", null)).toBe("brand");
  });

  it("puts the platform's own staff on the platform's inbox, beside the owner", () => {
    // Staff with no brand are the super admin's support team. Their lane is
    // the one the super admin works — never a tenant's customer queue, which
    // is what "no brand" used to fall through to.
    expect(handlerLane("STAFF", null)).toBe("brand");
    expect(handlerLane("STAFF", undefined)).toBe("brand");
  });

  it("gives a customer or reseller no inbox at all", () => {
    expect(handlerLane("USER", "b_acme")).toBeNull();
    expect(handlerLane("RESELLER", "b_acme")).toBeNull();
  });
});

describe("the two lanes never overlap", () => {
  it("nobody both asks and answers on the same lane", () => {
    for (const role of ["USER", "RESELLER", "ADMIN", "STAFF", "SUPER_ADMIN"]) {
      for (const brandId of ["b_acme", null]) {
        const asks = requesterLane(role);
        const answers = handlerLane(role, brandId);
        if (asks && answers) expect(asks).not.toBe(answers);
      }
    }
  });

  it("the brand admin is the only rung that does both — up and down", () => {
    // The middle of a three-tier hierarchy, which is exactly what this is.
    expect(requesterLane("ADMIN")).toBe("brand");
    expect(handlerLane("ADMIN", "b_acme")).toBe("support");
  });
});

describe("handlerSection — which permission gate each inbox sits behind", () => {
  it("puts the customer inbox on the brand-scoped section", () => {
    // `tickets` is in BRAND_SCOPED_SECTIONS, so requirePermission refuses it to
    // the super admin the same way it refuses them the customer list.
    expect(handlerSection("support")).toBe("tickets");
  });

  it("puts the brand inbox on the platform-only section", () => {
    // `brand_tickets` is in PLATFORM_ONLY_SECTIONS, so no tenant's admin or
    // staff member can be granted it, however their role is configured.
    expect(handlerSection("brand")).toBe("brand_tickets");
  });
});

describe("departmentTenant — who owns the queue, vs who is asking", () => {
  // This one is worth stating plainly because getting it wrong is invisible in
  // types and obvious in use: a brand admin's platform request picker came back
  // EMPTY, because it looked for brand-lane queues owned by their own tenant.
  // The queue belongs to whoever ANSWERS; the ticket carries whoever ASKS.
  it("files a customer's request into their own brand's queues", () => {
    expect(departmentTenant("support", "b_acme")).toBe("b_acme");
  });

  it("files a brand admin's request into the PLATFORM's queues, not their own", () => {
    expect(departmentTenant("brand", "b_acme")).toBeNull();
  });

  it("files the platform owner's own request on the platform's support queues", () => {
    // The super admin is the one account with no brand, so their support
    // request has nowhere else to go.
    expect(departmentTenant("support", null)).toBeNull();
    expect(departmentTenant("support", undefined)).toBeNull();
  });

  it("is null on the brand lane whatever the caller's own tenant is", () => {
    expect(departmentTenant("brand", null)).toBeNull();
    expect(departmentTenant("brand", undefined)).toBeNull();
  });
});

describe("holdsEveryQueue", () => {
  it("exempts a full admin from department grants", () => {
    // A brand ADMIN runs the whole tenant and the SUPER_ADMIN the whole
    // platform, so neither needs granting a queue inside their own scope.
    expect(holdsEveryQueue("ADMIN")).toBe(true);
    expect(holdsEveryQueue("SUPER_ADMIN")).toBe(true);
  });

  it("holds staff to the queues they were actually granted", () => {
    expect(holdsEveryQueue("STAFF")).toBe(false);
  });
});

describe("laneCopy", () => {
  it("names each side of both conversations, so no screen invents its own", () => {
    expect(laneCopy("support")).toMatchObject({
      inbox: "Support Tickets",
      requesterPage: "Support",
      handlerLabel: "Support",
    });
    expect(laneCopy("brand")).toMatchObject({
      inbox: "Brand Requests",
      requesterPage: "Platform Support",
      handlerLabel: "Platform",
    });
  });

  it("gives the two lanes different words for every field", () => {
    // If any label matched, one lane's screens would read as the other's.
    const a = laneCopy("support");
    const b = laneCopy("brand");
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      expect(a[key]).not.toBe(b[key]);
    }
  });
});
