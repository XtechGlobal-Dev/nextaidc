import { describe, it, expect, vi, beforeEach } from "vitest";

// Brand requests: filing (from inside a main-domain customer's dashboard) checks the address against what's already
// taken and allows one open request per account; a claim lets exactly one "Complete setup" through, and a closed
// request can't be acted on again. Stripe ids and password hashes on old requests never reach the browser.

const h = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  reqFindFirst: vi.fn(),
  reqFindUnique: vi.fn(),
  reqCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "r1",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  })),
  reqUpdate: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    email: "jo@acme.com",
    contactName: "Jo",
    brandName: "Acme",
    ...data,
  })),
  reqUpdateMany: vi.fn(),
  sendTemplate: vi.fn(async (): Promise<boolean> => true),
  notifyPlatformOwners: vi.fn(async (): Promise<void> => undefined),
  assertDomain: vi.fn(async (raw: string | null | undefined): Promise<string | null> =>
    raw ? raw.trim().toLowerCase() : null,
  ),
  resolveTheme: vi.fn((i: { themePreset?: string; primaryColor?: string; accentColor?: string; fontFamily?: string }) => {
    if (i.fontFamily === "comic") throw new Error('Unknown font "comic".');
    return {
      themePreset: i.themePreset ?? "ocean",
      primaryColor: (i.primaryColor ?? "#2C76ED").toLowerCase(),
      accentColor: (i.accentColor ?? "#7C5CFC").toLowerCase(),
      fontFamily: i.fontFamily ?? "inter",
      fontStyle: "business",
      darkModeDefault: false,
    };
  }),
  stripeOn: vi.fn(() => true),
  customerDel: vi.fn(async () => ({})),
  storageOn: vi.fn(() => true),
  upload: vi.fn(async (prefix: string) => ({ url: `https://cdn.test/${prefix}/f.png`, key: `${prefix}/f.png` })),
  deleteObject: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: { findUnique: h.brandFindUnique },
    brandRequest: {
      findFirst: h.reqFindFirst,
      findUnique: h.reqFindUnique,
      create: h.reqCreate,
      update: h.reqUpdate,
      updateMany: h.reqUpdateMany,
    },
  },
}));
vi.mock("./stripe.js", () => ({
  isStripeConfigured: h.stripeOn,
  stripe: () => ({ customers: { del: h.customerDel } }),
}));
vi.mock("./email.js", () => ({ sendTemplate: h.sendTemplate }));
vi.mock("./notifications.js", () => ({ notifyPlatformOwners: h.notifyPlatformOwners }));
vi.mock("./brands.js", () => ({ assertDomainAvailable: h.assertDomain, resolveTheme: h.resolveTheme }));
vi.mock("./storage.js", () => ({
  isStorageConfigured: h.storageOn,
  uploadObject: h.upload,
  deleteObject: h.deleteObject,
}));

import {
  checkRequestSlug,
  claimBrandRequest,
  declineBrandRequest,
  fileBrandAdminRequest,
  serializeBrandRequest,
} from "./brandRequests.js";

const INPUT = { brandName: "Acme Voice", slug: "" };
const ME = { brandId: "c1", userId: "u1", email: "Jo@Acme.com", fullName: "Jo Blake" };
const fileBrandRequest = (input: Parameters<typeof fileBrandAdminRequest>[1], logos = {}) =>
  fileBrandAdminRequest(ME, input, logos);

const png = { buffer: Buffer.from("png"), mimetype: "image/png", originalname: "logo.png" };

beforeEach(() => {
  vi.clearAllMocks();
  h.brandFindUnique.mockResolvedValue(null);
  h.reqFindFirst.mockResolvedValue(null);
  h.storageOn.mockReturnValue(true);
  h.stripeOn.mockReturnValue(true);
});

describe("fileBrandAdminRequest", () => {
  it("files the request for the signed-in account, with a derived slug and no password", async () => {
    await fileBrandRequest(INPUT);
    const data = h.reqCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ applicantBrandId: "c1", applicantUserId: "u1", contactName: "Jo Blake" });
    expect(data.slug).toBe("acme-voice");
    expect(data.email).toBe("jo@acme.com");
    expect(data.passwordHash).toBeUndefined();
    expect(data.customDomain).toBe("");
    expect(h.sendTemplate).toHaveBeenCalledWith("brand_request_received", "jo@acme.com", expect.any(Object));
    expect(h.notifyPlatformOwners).toHaveBeenCalled();
  });

  it("keeps the applicant's own domain, checked like a brand's", async () => {
    await fileBrandRequest({ ...INPUT, customDomain: " App.Acme.com " });
    expect(h.assertDomain).toHaveBeenCalledWith(" App.Acme.com ", "c1");
    expect(h.reqCreate.mock.calls[0][0].data.customDomain).toBe("app.acme.com");
  });

  it("refuses an own domain another brand holds", async () => {
    h.assertDomain.mockRejectedValueOnce(new Error('The domain "app.acme.com" is already pointed at another brand.'));
    await expect(fileBrandRequest({ ...INPUT, customDomain: "app.acme.com" })).rejects.toThrow(/another brand/);
    expect(h.reqCreate).not.toHaveBeenCalled();
  });

  it("refuses an address a brand already has", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b1" });
    await expect(fileBrandRequest(INPUT)).rejects.toThrow(/already taken/);
    expect(h.reqCreate).not.toHaveBeenCalled();
  });

  it("refuses a second open request from the same account", async () => {
    // The account's own open request is looked up first.
    h.reqFindFirst.mockResolvedValueOnce({ brandName: "Acme" });
    await expect(fileBrandRequest(INPUT)).rejects.toThrow(/already in review/);
    expect(h.reqFindFirst.mock.calls[0][0].where).toMatchObject({ applicantBrandId: "c1" });
    expect(h.reqCreate).not.toHaveBeenCalled();
  });

  it("refuses a reserved address", async () => {
    await expect(fileBrandRequest({ ...INPUT, slug: "admin" })).rejects.toThrow(/reserved/);
  });
});

describe("fileBrandAdminRequest — the look", () => {
  it("stores the palette and typeface, validated like a brand's", async () => {
    await fileBrandRequest({ ...INPUT, themePreset: "violet", primaryColor: "#7C3AED", accentColor: "#EC4899", fontFamily: "poppins" });
    expect(h.reqCreate.mock.calls[0][0].data).toMatchObject({
      themePreset: "violet",
      primaryColor: "#7c3aed",
      accentColor: "#ec4899",
      fontFamily: "poppins",
    });
  });

  it("leaves the look blank when none was picked", async () => {
    await fileBrandRequest(INPUT);
    expect(h.resolveTheme).not.toHaveBeenCalled();
    expect(h.reqCreate.mock.calls[0][0].data.themePreset).toBeUndefined();
  });

  it("refuses a typeface outside the catalog, before anything is stored", async () => {
    await expect(fileBrandRequest({ ...INPUT, fontFamily: "comic" }, { logoLight: png })).rejects.toThrow(/Unknown font/);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.reqCreate).not.toHaveBeenCalled();
  });

  it("uploads each logo and keeps its URL", async () => {
    await fileBrandRequest(INPUT, { logoLight: png, favicon: png });
    expect(h.upload).toHaveBeenCalledTimes(2);
    const data = h.reqCreate.mock.calls[0][0].data;
    expect(data.logoLightUrl).toBe("https://cdn.test/brand-requests/logo-light/acme-voice/f.png");
    expect(data.faviconUrl).toBe("https://cdn.test/brand-requests/favicon/acme-voice/f.png");
    expect(data.logoDarkUrl).toBeUndefined();
  });

  it("uploads nothing for a request that's refused", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b1" });
    await expect(fileBrandRequest(INPUT, { logoLight: png })).rejects.toThrow(/already taken/);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("deletes the uploaded logos when the row can't be written", async () => {
    h.reqCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(fileBrandRequest(INPUT, { logoLight: png })).rejects.toThrow(/db down/);
    expect(h.deleteObject).toHaveBeenCalledWith("brand-requests/logo-light/acme-voice/f.png");
  });

  it("says so when logos can't be stored on this server", async () => {
    h.storageOn.mockReturnValue(false);
    await expect(fileBrandRequest(INPUT, { logoLight: png })).rejects.toThrow(/without them/);
  });
});

describe("checkRequestSlug", () => {
  it("counts an open request as taken", async () => {
    h.reqFindFirst.mockResolvedValue({ id: "r0" });
    const res = await checkRequestSlug("acme");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/already asked/);
    expect(res.suffix).toBeTruthy();
  });
});

describe("claimBrandRequest", () => {
  it("claims a pending request", async () => {
    h.reqUpdateMany.mockResolvedValue({ count: 1 });
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "approving", updatedAt: new Date() });
    await expect(claimBrandRequest("r1", "admin1")).resolves.toMatchObject({ status: "approving" });
    const where = h.reqUpdateMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ status: "pending" });
  });

  it("says why when someone else already has it", async () => {
    h.reqUpdateMany.mockResolvedValue({ count: 0 });
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "approving", updatedAt: new Date() });
    await expect(claimBrandRequest("r1", "admin1")).rejects.toThrow(/right now/);
  });

  it("refuses an approved request", async () => {
    h.reqUpdateMany.mockResolvedValue({ count: 0 });
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "approved", updatedAt: new Date() });
    await expect(claimBrandRequest("r1", "admin1")).rejects.toThrow(/already been set up/);
  });
});

describe("declineBrandRequest", () => {
  it("deletes the request's logos", async () => {
    h.reqFindUnique.mockResolvedValue({
      id: "r1",
      status: "pending",
      updatedAt: new Date(),
      logoLightUrl: "https://cdn.test/brand-requests/logo-light/acme/a.png",
      logoDarkUrl: "",
      faviconUrl: "https://cdn.test/brand-requests/favicon/acme/b.png",
    });
    await declineBrandRequest("r1", { reason: "", actorId: "admin1", notify: false });
    expect(h.reqUpdate.mock.calls[0][0].data).toMatchObject({ logoLightUrl: "", faviconUrl: "" });
    expect(h.deleteObject).toHaveBeenCalledWith("brand-requests/logo-light/acme/a.png");
    expect(h.deleteObject).toHaveBeenCalledWith("brand-requests/favicon/acme/b.png");
    expect(h.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("deletes the saved card's Stripe customer", async () => {
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "pending", updatedAt: new Date(), stripeCustomerId: "cus_1" });
    await declineBrandRequest("r1", { reason: "", actorId: "admin1", notify: false });
    expect(h.customerDel).toHaveBeenCalledWith("cus_1");
    expect(h.reqUpdate.mock.calls[0][0].data).toMatchObject({ stripeCustomerId: "", paymentMethodId: "" });
  });

  it("declines, drops the password hash and emails the reason", async () => {
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "pending", updatedAt: new Date() });
    await declineBrandRequest("r1", { reason: " Not a fit ", actorId: "admin1", notify: true });
    const data = h.reqUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "declined", declineReason: "Not a fit", passwordHash: "" });
    expect(h.sendTemplate).toHaveBeenCalledWith(
      "brand_request_declined",
      "jo@acme.com",
      expect.objectContaining({ reason: "Not a fit" }),
    );
  });

  it("won't decline one that's already set up", async () => {
    h.reqFindUnique.mockResolvedValue({ id: "r1", status: "approved", updatedAt: new Date() });
    await expect(declineBrandRequest("r1", { reason: "", actorId: "a", notify: false })).rejects.toThrow(
      /already been set up/,
    );
  });
});

describe("serializeBrandRequest", () => {
  it("never exposes the password hash", () => {
    const view = serializeBrandRequest({
      id: "r1",
      status: "pending",
      brandName: "Acme",
      slug: "acme",
      tagline: "",
      customDomain: "",
      themePreset: "",
      primaryColor: "",
      accentColor: "",
      fontFamily: "",
      logoLightUrl: "",
      logoDarkUrl: "",
      faviconUrl: "",
      brandPlanId: "",
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      cardBrand: "visa",
      cardLast4: "4242",
      contactName: "Jo",
      email: "jo@acme.com",
      phone: "",
      country: "",
      timezone: "",
      notes: "",
      passwordHash: "secret",
      applicantBrandId: null,
      applicantUserId: null,
      brandId: null,
      reviewedById: null,
      reviewedAt: null,
      declineReason: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(JSON.stringify(view)).not.toContain("secret");
    // Old requests' Stripe ids stay on the server.
    expect(JSON.stringify(view)).not.toContain("cus_1");
    expect(JSON.stringify(view)).not.toContain("pm_1");
  });
});
