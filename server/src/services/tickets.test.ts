import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../lib/ticketFiles.js";
import type { TicketActor } from "./tickets.js";

// Who can see and touch a ticket: attachment signatures (or a client claims any S3 key), the
// lane + tenant wall, staff scoping, and fan-out that must never cross a lane. One stand-in plays both planes.

const h = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
  findManyUsers: vi.fn(),
  findUniqueRole: vi.fn(),
  findManyRoles: vi.fn(),
  createManyNotifications: vi.fn(),
  sendTemplate: vi.fn(),
  updateTicket: vi.fn(),
  mainFindManyTickets: vi.fn(),
  tenantFindManyTickets: vi.fn(),
  unreachable: new Set<string>(),
}));

/** The lane's database — a brand's own, or the control plane; same shape. */
const db = {
  user: { findUnique: h.findUniqueUser, findMany: h.findManyUsers },
  staffRole: { findUnique: h.findUniqueRole, findMany: h.findManyRoles },
  ticket: { findFirst: vi.fn(), findUnique: vi.fn(), update: h.updateTicket, count: vi.fn(), findMany: h.tenantFindManyTickets },
  ticketMessage: { create: vi.fn(), findFirst: vi.fn() },
  ticketAttachment: { findMany: vi.fn() },
  ticketDepartment: { count: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
  notification: { createMany: h.createManyNotifications },
  $transaction: vi.fn(),
} as never;

vi.mock("../env.js", () => ({
  env: { JWT_SECRET: "ticket-suite-secret" },
  appBaseUrl: "https://app.test",
  publicApiBaseUrl: "https://api.test",
  canonicalApiBaseUrl: "https://api.test",
  shareLinkBaseUrl: "https://api.test",
  platformDomain: "app.test",
  allowUnverifiedBrandDomains: false,
  corsOrigins: ["https://app.test"],
}));
// The control plane, reached only for the platform's half of an escalation.
vi.mock("../prisma.js", () => ({ prisma: { ticket: { findMany: h.mainFindManyTickets } } }));
vi.mock("./tenantDb.js", () => ({
  laneDb: async () => db,
  planeOf: async () => db,
  // The platform's half of an escalation is read from the control plane.
  controlPlaneAsTenant: () => ({ ticket: { findMany: h.mainFindManyTickets } }),
  allTenants: async () => [],
  tenantFor: async (brandId: string) => {
    if (h.unreachable.has(brandId)) throw new Error(`brand ${brandId} unavailable`);
    return db;
  },
}));
vi.mock("./events.js", () => ({ publishToAdmins: vi.fn(), publishToUser: vi.fn() }));
vi.mock("./email.js", () => ({ sendTemplate: h.sendTemplate }));
vi.mock("./storage.js", () => ({ deleteObject: vi.fn() }));
vi.mock("../lib/brandUrls.js", () => ({
  brandAppUrl: (path: string) => `https://app.test${path}`,
  brandDisplayName: () => "Platform",
}));
vi.mock("./brands.js", () => ({
  cachedBrand: (id: string | null) =>
    id === "b_acme"
      ? { id, name: "Acme Voice", slug: "acme" }
      : id === "b1"
        ? { id, name: "Northwind Voice", slug: "northwind" }
        : null,
}));

const {
  assertCan,
  attachEscalationPairs,
  departmentScope,
  forgetDepartmentScopes,
  handlerTicketPath,
  handlerWhere,
  handlersWhere,
  handoffLine,
  markThreadRead,
  notifyRequester,
  notifyTicketStaff,
  preview,
  requesterTicketPath,
  scopeFilter,
  serializeTicket,
  serializeTicketForRequester,
  shouldEmailForMessage,
  signAttachment,
  verifyAttachments,
} = await import("./tickets.js");

const FILE = {
  name: "screenshot.png",
  mime: "image/png",
  size: 1234,
  key: "tickets/abc.png",
  url: "https://cdn.test/tickets/abc.png",
};

/** A handler on the customer lane, belonging to Acme. */
function brandAdmin(over: Partial<TicketActor> = {}): TicketActor {
  return {
    id: "admin_acme",
    role: "ADMIN",
    permissions: [],
    brandId: "b_acme",
    lane: "support",
    ...over,
  };
}

/** A handler on the brand lane — the platform owner. */
function superAdmin(over: Partial<TicketActor> = {}): TicketActor {
  return { id: "owner", role: "SUPER_ADMIN", permissions: [], brandId: null, lane: "brand", ...over };
}

/** A ticket row shaped like the include the notify path is handed. */
function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    reference: "TCK-ABC123",
    subject: "Calls not forwarding",
    lane: "support",
    status: "open",
    priority: "high",
    brandId: "b_acme",
    departmentId: "d1",
    department: { id: "d1", name: "Technical" },
    requesterId: "cust1",
    requester: { id: "cust1", fullName: "Jane Doe", email: "jane@acme.test", role: "USER" },
    assignedToId: null,
    assignedTo: null,
    unreadForStaff: true,
    unreadForRequester: false,
    escalationId: null,
    escalatedFromId: null,
    escalatedFromBrandId: null,
    ...over,
  } as unknown as Parameters<typeof notifyTicketStaff>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Grants are cached per (lane, staff id) for a few seconds; tests reuse ids.
  forgetDepartmentScopes();
  h.unreachable.clear();
  h.sendTemplate.mockResolvedValue(true);
  h.createManyNotifications.mockResolvedValue({ count: 1 });
  h.findManyRoles.mockResolvedValue([]);
  h.mainFindManyTickets.mockResolvedValue([]);
  h.tenantFindManyTickets.mockResolvedValue([]);
});

/* ----------------------------- Attachments ------------------------------- */

describe("attachment signatures", () => {
  it("accepts a descriptor exactly as the server issued it", () => {
    const signed = signAttachment(FILE);
    expect(verifyAttachments([signed])).toHaveLength(1);
  });

  it("rejects an unsigned descriptor", () => {
    expect(() => verifyAttachments([{ ...FILE, sig: "" }])).toThrow(/could not be verified/i);
  });

  it("rejects a swapped S3 key — the signature covers it", () => {
    const signed = signAttachment(FILE);
    expect(() => verifyAttachments([{ ...signed, key: "branding/other-tenant-logo.png" }])).toThrow(
      /could not be verified/i,
    );
  });

  it("rejects a swapped URL, so nobody can render an arbitrary link as an upload", () => {
    const signed = signAttachment(FILE);
    expect(() => verifyAttachments([{ ...signed, url: "https://evil.test/x.png" }])).toThrow(
      /could not be verified/i,
    );
  });

  it("rejects a tampered name, type or size", () => {
    const signed = signAttachment(FILE);
    expect(() => verifyAttachments([{ ...signed, name: "invoice.pdf" }])).toThrow();
    expect(() => verifyAttachments([{ ...signed, mime: "application/pdf" }])).toThrow();
    expect(() => verifyAttachments([{ ...signed, size: 9 }])).toThrow();
  });

  it("rejects a validly-signed descriptor whose type isn't allowed", () => {
    // Belt and braces: even if one escaped the uploader, attaching it fails.
    const signed = signAttachment({ ...FILE, name: "run.exe", mime: "application/x-msdownload" });
    expect(() => verifyAttachments([signed])).toThrow(/not an allowed file type/i);
  });

  it("caps how many files ride on one message", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) =>
      signAttachment({ ...FILE, key: `tickets/${i}.png` }),
    );
    expect(() => verifyAttachments(many)).toThrow(
      new RegExp(`up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`, "i"),
    );
  });

  it("treats an absent list as no attachments", () => {
    expect(verifyAttachments(undefined)).toEqual([]);
    expect(verifyAttachments([])).toEqual([]);
  });
});

/* ------------------------------- Scoping --------------------------------- */

describe("scopeFilter — lane, tenant, department, ownership", () => {
  it("pins a brand admin to their own tenant's customer lane", () => {
    // Two walls in one object: `lane` keeps them out of the platform's queue,
    // `brandId` keeps them out of every other tenant's.
    expect(scopeFilter(brandAdmin(), null)).toEqual({ lane: "support", brandId: "b_acme" });
  });

  it("gives the platform owner every tenant's brand request, and no customer's", () => {
    expect(scopeFilter(superAdmin(), null)).toEqual({ lane: "brand" });
  });

  it("limits staff to their granted queues and, within them, to what nobody holds", () => {
    const staff = brandAdmin({ id: "s1", role: "STAFF", permissions: ["tickets.view"] });
    expect(scopeFilter(staff, ["d1", "d2"])).toEqual({
      lane: "support",
      brandId: "b_acme",
      departmentId: { in: ["d1", "d2"] },
      AND: [{ OR: [{ assignedToId: null }, { assignedToId: "s1" }] }],
    });
  });

  it("matches nothing when no department is granted", () => {
    // `in: []` is what makes "no queues" mean "no tickets" rather than "no
    // filter" — the difference between a closed and a wide-open inbox.
    const staff = brandAdmin({ id: "s1", role: "STAFF", permissions: ["tickets.view"] });
    expect(scopeFilter(staff, [])).toMatchObject({ departmentId: { in: [] } });
  });
});

describe("departmentScope", () => {
  const staff = (id: string) => brandAdmin({ id, role: "STAFF", permissions: ["tickets.view"] });

  it("gives a full admin every queue in their lane without a lookup", async () => {
    expect(await departmentScope(db, brandAdmin())).toBeNull();
    expect(await departmentScope(db, superAdmin())).toBeNull();
    expect(h.findUniqueUser).not.toHaveBeenCalled();
  });

  // The role is a plain id on the account, so its grants are a second read.
  it("unions the role's grants with the staff member's own", async () => {
    h.findUniqueUser.mockResolvedValue({ staffRoleId: "r1", ticketDepartments: [{ id: "d3", lane: "support" }] });
    h.findUniqueRole.mockResolvedValue({ ticketDepartments: [{ id: "d1", lane: "support" }] });
    const scope = await departmentScope(db, staff("s1"));
    expect(scope?.sort()).toEqual(["d1", "d3"]);
    expect(h.findUniqueRole).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1" } }));
  });

  it("counts a queue held by BOTH routes once", async () => {
    h.findUniqueUser.mockResolvedValue({ staffRoleId: "r1", ticketDepartments: [{ id: "d1", lane: "support" }] });
    h.findUniqueRole.mockResolvedValue({ ticketDepartments: [{ id: "d1", lane: "support" }] });
    expect(await departmentScope(db, staff("s2"))).toEqual(["d1"]);
  });

  it("ignores a grant from the other lane", async () => {
    // A department id alone says nothing about which conversation it belongs to,
    // so a stale platform grant must not widen a staff member's customer queue.
    h.findUniqueUser.mockResolvedValue({ staffRoleId: "r1", ticketDepartments: [{ id: "platform_q", lane: "brand" }] });
    h.findUniqueRole.mockResolvedValue({ ticketDepartments: [{ id: "d1", lane: "support" }] });
    expect(await departmentScope(db, staff("s3"))).toEqual(["d1"]);
  });

  it("gives staff with no grant an empty scope, not a free pass", async () => {
    h.findUniqueUser.mockResolvedValue({ staffRoleId: null, ticketDepartments: [] });
    expect(await departmentScope(db, staff("s4"))).toEqual([]);
    expect(h.findUniqueRole).not.toHaveBeenCalled();
  });
});

describe("assertCan", () => {
  it("lets a brand admin run their own customer inbox", () => {
    expect(() => assertCan(brandAdmin(), "delete")).not.toThrow();
  });

  it("refuses the platform owner a tenant's customer inbox outright", () => {
    // Not merely hidden — refused, the same way requirePermission refuses them
    // the customer list. This is the wall, asserted.
    expect(() => assertCan(superAdmin({ lane: "support" }), "view")).toThrow(
      /belongs to a brand/i,
    );
  });

  it("refuses everyone but the platform owner the brand-request inbox", () => {
    expect(() => assertCan(brandAdmin({ lane: "brand" }), "view")).toThrow(/permission/i);
    expect(() =>
      assertCan(
        brandAdmin({ lane: "brand", role: "STAFF", permissions: ["brand_tickets.view"] }),
        "view",
      ),
    ).toThrow(/permission/i);
  });

  it("lets the platform owner run their own", () => {
    expect(() => assertCan(superAdmin(), "delete")).not.toThrow();
  });

  it("holds staff to the capability they actually hold", () => {
    const staff = brandAdmin({ role: "STAFF", permissions: ["tickets.view", "tickets.edit"] });
    expect(() => assertCan(staff, "edit")).not.toThrow();
    expect(() => assertCan(staff, "delete")).toThrow(/permission/i);
  });

  it("refuses a customer, whatever keys are stored on them", () => {
    expect(() =>
      assertCan(brandAdmin({ role: "USER", permissions: ["tickets.edit"] }), "edit"),
    ).toThrow(/permission/i);
  });
});

describe("handlerWhere — who answers a queue", () => {
  it("narrows the brand lane to the platform's own team", async () => {
    // Up there are the owner and the platform's own staff — holding the key,
    // granted the queue through their role or personally.
    h.findManyRoles.mockResolvedValue([{ id: "r_platform" }]);
    const where = await handlerWhere(db, "brand", "d1");
    expect(where.OR?.[0]).toEqual({ role: "SUPER_ADMIN" });
    expect(where.OR?.[1]).toMatchObject({
      role: "STAFF",
      permissions: { has: "brand_tickets.view" },
      OR: [{ staffRoleId: { in: ["r_platform"] } }, { ticketDepartments: { some: { id: "d1" } } }],
    });
  });

  it("never filters the control plane's accounts by brand — they have no such column", async () => {
    // A `brandId` clause here is a query Prisma refuses outright, and the fan-out
    // swallows the throw: the platform owner's bell simply never rings.
    h.findManyRoles.mockResolvedValue([{ id: "r_platform" }]);
    expect(JSON.stringify(await handlerWhere(db, "brand", "d1"))).not.toContain("brandId");
    expect(JSON.stringify(await handlersWhere(db, "brand", null))).not.toContain("brandId");
  });

  it("narrows the brand lane to the owner alone when no queue is named", async () => {
    // The same "full admins only" narrowing the support lane makes — the
    // audience for a ticket nobody holds.
    expect(await handlerWhere(db, "brand", null)).toEqual({ role: "SUPER_ADMIN" });
    expect(h.findManyRoles).not.toHaveBeenCalled();
  });

  it("matches a queue's staff by role grant OR personal grant", async () => {
    h.findManyRoles.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    const where = await handlerWhere(db, "support", "d1");
    const staffClause = where.OR?.[1] as { permissions: { has: string }; OR: unknown[] };
    expect(staffClause.permissions).toEqual({ has: "tickets.view" });
    expect(staffClause.OR).toEqual([
      { staffRoleId: { in: ["r1", "r2"] } },
      { ticketDepartments: { some: { id: "d1" } } },
    ]);
    expect(h.findManyRoles).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ticketDepartments: { some: { id: "d1" } } } }),
    );
  });

  it("includes the brand's admins — and never the platform owner", async () => {
    // The database IS the brand, so no tenant clause; SUPER_ADMIN is excluded by role
    // so a customer's thread never lands in the platform owner's bell.
    const where = await handlerWhere(db, "support", "d1");
    expect(where.OR?.[0]).toEqual({ role: "ADMIN" });
    expect(JSON.stringify(where)).not.toContain("SUPER_ADMIN");
    expect(JSON.stringify(where)).not.toContain("brandId");
  });

  it("asks for the capability it was given, so the assignee picker demands edit", async () => {
    const where = await handlerWhere(db, "support", "d1", "edit");
    const staffClause = where.OR?.[1] as { permissions: { has: string } };
    expect(staffClause.permissions).toEqual({ has: "tickets.edit" });
  });

  it("narrows to the brand's admins alone for an orphaned ticket with no queue", async () => {
    expect(await handlerWhere(db, "support", null)).toEqual({ role: "ADMIN" });
  });
});

/* ------------------------------ Notifying -------------------------------- */

describe("notifyTicketStaff", () => {
  const TEAM = [
    { id: "s1", email: "sam@acme.test", fullName: "Sam" },
    { id: "s2", email: "ravi@acme.test", fullName: "Ravi" },
  ];

  beforeEach(() => {
    h.findManyUsers.mockResolvedValue(TEAM);
    h.findUniqueUser.mockResolvedValue({ id: "s2", email: "ravi@acme.test", fullName: "Ravi" });
  });

  it("mails the whole queue while a ticket is unassigned", async () => {
    await notifyTicketStaff(db, ticketRow(), {
      title: "New ticket",
      message: "Calls not forwarding",
      templateKey: "ticket_staff_new",
    });
    expect(h.sendTemplate.mock.calls.map((c) => c[1]).sort()).toEqual([
      "ravi@acme.test",
      "sam@acme.test",
    ]);
  });

  it("mails ONLY the assignee once the ticket is owned", async () => {
    await notifyTicketStaff(db, ticketRow({ assignedToId: "s2" }), {
      title: "Reply",
      message: "…",
      templateKey: "ticket_staff_reply",
    });
    // Mail that always went to the whole team would be filtered by the whole
    // team, so once someone owns it the mail is theirs alone.
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(h.sendTemplate.mock.calls[0][1]).toBe("ravi@acme.test");
  });

  it("writes the bell into the lane's own database, linking into the brand admin's inbox", async () => {
    await notifyTicketStaff(db, ticketRow(), { title: "New ticket", message: "…" });
    const rows = h.createManyNotifications.mock.calls[0][0].data;
    expect(rows[0].link).toBe("/dashboard/admin/tickets?ticket=t1");
  });

  it("links a brand request into the platform owner's own inbox instead", async () => {
    h.findManyUsers.mockResolvedValue([{ id: "owner", email: "owner@platform.test", fullName: "Owner" }]);
    await notifyTicketStaff(db, ticketRow({ lane: "brand" }), { title: "New brand request", message: "…" });
    const rows = h.createManyNotifications.mock.calls[0][0].data;
    expect(rows[0].userId).toBe("owner");
    expect(rows[0].link).toBe("/superadmin/tickets?ticket=t1");
  });

  it("carries the tenant's name, so a platform-side handler knows who is asking", async () => {
    // From the brands cache: the ticket names its brand by id only.
    await notifyTicketStaff(db, ticketRow({ lane: "brand" }), {
      title: "New brand request",
      message: "…",
      templateKey: "ticket_staff_new",
    });
    expect(h.sendTemplate.mock.calls[0][2]).toMatchObject({ brand_name: "Acme Voice" });
  });

  it("never notifies the person who caused the event", async () => {
    await notifyTicketStaff(db, ticketRow(), {
      title: "Moved here",
      message: "…",
      templateKey: "ticket_staff_new",
      excludeUserId: "s1",
    });
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(h.sendTemplate.mock.calls[0][1]).toBe("ravi@acme.test");
    const rows = h.createManyNotifications.mock.calls[0][0].data;
    expect(rows.map((r: { userId: string }) => r.userId)).toEqual(["s2"]);
  });

  it("stays in-app when no template is given", async () => {
    await notifyTicketStaff(db, ticketRow(), { title: "Requester closed it", message: "…" });
    expect(h.createManyNotifications).toHaveBeenCalledTimes(1);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it("never throws when the mailer or the database fails", async () => {
    h.findManyUsers.mockRejectedValue(new Error("db down"));
    await expect(
      notifyTicketStaff(db, ticketRow(), { title: "x", message: "y", templateKey: "ticket_staff_new" }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyRequester", () => {
  it("sends both lanes' requesters to the one page they know, in their own brand's database", async () => {
    await notifyRequester(ticketRow(), { title: "Received", message: "…" });
    expect(h.createManyNotifications.mock.calls[0][0].data[0]).toMatchObject({
      userId: "cust1",
      link: "/dashboard/support?ticket=t1",
    });
  });

  it("mails without ringing the bell when the requester did it themselves", async () => {
    await notifyRequester(ticketRow({ lane: "brand" }), {
      title: "Received",
      message: "…",
      templateKey: "ticket_created",
      inApp: false,
    });
    expect(h.createManyNotifications).not.toHaveBeenCalled();
    expect(h.sendTemplate).toHaveBeenCalled();
  });

  it("tells the requester who is answering, in their own words", async () => {
    await notifyRequester(ticketRow(), {
      title: "Received",
      message: "…",
      templateKey: "ticket_created",
    });
    expect(h.sendTemplate.mock.calls[0][2]).toMatchObject({ handler_name: "the support team" });

    h.sendTemplate.mockClear();
    await notifyRequester(ticketRow({ lane: "brand" }), {
      title: "Received",
      message: "…",
      templateKey: "ticket_created",
    });
    expect(h.sendTemplate.mock.calls[0][2]).toMatchObject({ handler_name: "the platform team" });
  });
});

/* ------------------------------- Escalation ------------------------------- */

describe("attachEscalationPairs — one pair, two databases", () => {
  it("fills a customer ticket's platform half from the control plane", async () => {
    h.mainFindManyTickets.mockResolvedValue([{ id: "m1", reference: "TCK-UP", status: "open" }]);
    const [row] = await attachEscalationPairs([
      { id: "t1", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: "m1", escalatedFromId: null, escalatedFromBrandId: null },
    ]);
    expect(row.escalation).toEqual({ id: "m1", reference: "TCK-UP", status: "open" });
    expect(row.escalatedFrom).toBeNull();
    expect(h.mainFindManyTickets).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["m1"] } } }));
  });

  it("fills a platform ticket's customer half from the brand's database it names", async () => {
    h.tenantFindManyTickets.mockResolvedValue([
      { id: "t1", number: 7, reference: "TCK-DOWN", subject: "Calls drop", status: "pending", requesterName: "Jane Doe", requesterEmail: "jane@acme.test" },
    ]);
    const [row] = await attachEscalationPairs([
      { id: "m1", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: null, escalatedFromId: "t1", escalatedFromBrandId: "b_acme" },
    ]);
    expect(row.escalatedFrom).toEqual({
      id: "t1",
      number: 7,
      reference: "TCK-DOWN",
      subject: "Calls drop",
      status: "pending",
      requesterName: "Jane Doe",
    });
    expect(row.escalation).toBeNull();
  });

  it("leaves the pair absent — not the list broken — when the brand's database is unreachable", async () => {
    h.unreachable.add("b_gone");
    const [row] = await attachEscalationPairs([
      { id: "m1", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: null, escalatedFromId: "t1", escalatedFromBrandId: "b_gone" },
    ]);
    expect(row.escalatedFrom).toBeNull();
  });

  it("reads once per direction, however many rows", async () => {
    await attachEscalationPairs([
      { id: "a", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: "m1", escalatedFromId: null, escalatedFromBrandId: null },
      { id: "b", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: "m2", escalatedFromId: null, escalatedFromBrandId: null },
      { id: "c", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: null, escalatedFromId: "t1", escalatedFromBrandId: "b_acme" },
      { id: "d", requesterId: "u1", requesterName: "Jane", requesterEmail: "jane@acme.test", lane: "support", escalationId: null, escalatedFromId: "t2", escalatedFromBrandId: "b_acme" },
    ]);
    expect(h.mainFindManyTickets).toHaveBeenCalledTimes(1);
    expect(h.tenantFindManyTickets).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------- Read marks ------------------------------- */

describe("markThreadRead", () => {
  const ticket = {
    id: "t1",
    requesterId: "cust1",
    unreadForStaff: true,
    unreadForRequester: true,
    lane: "support" as const,
    brandId: "b_acme",
  };

  it("stamps the read time and nudges the other side", async () => {
    await markThreadRead(db, ticket, "staff");
    expect(h.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unreadForStaff: false, staffReadAt: expect.any(Date) }),
      }),
    );
  });

  it("stays silent on a thread that was already read — this is what stops a ping-pong", async () => {
    // Each side re-reads on a nudge, and re-reading marks it read: without this
    // guard the two tabs would wake each other for ever.
    await markThreadRead(db, { ...ticket, unreadForStaff: false }, "staff");
    expect(h.updateTicket).not.toHaveBeenCalled();
  });
});

/* -------------------------------- Wording -------------------------------- */

describe("handoffLine", () => {
  it("says who did what, in one line", () => {
    expect(handoffLine("Sam", { assignee: "Rahul" })).toBe("Sam assigned this to Rahul.");
    expect(handoffLine("Sam", { self: true })).toBe("Sam took this.");
    expect(handoffLine("Sam", { assignee: null })).toBe(
      "Sam unassigned this — nobody holds it now.",
    );
    expect(handoffLine("Sam", { movedTo: "Billing", assignee: null })).toBe(
      "Sam moved this to Billing — nobody holds it yet.",
    );
    expect(handoffLine("Sam", { movedTo: "Billing", assignee: "Rahul" })).toBe(
      "Sam moved this to Billing and assigned it to Rahul.",
    );
    expect(handoffLine("Sam", { movedTo: "Billing", self: true })).toBe(
      "Sam moved this to Billing and took it.",
    );
  });

  it("carries the handler's note, trimmed", () => {
    expect(handoffLine("Sam", { assignee: "Rahul" }, "  wants a refund ")).toBe(
      "Sam assigned this to Rahul: “wants a refund”",
    );
  });
});

describe("shouldEmailForMessage — the quiet-for-an-hour rule", () => {
  it("mails once the thread has been quiet for an hour", () => {
    expect(shouldEmailForMessage({ lastMessageAt: new Date(Date.now() - 2 * 3600_000) })).toBe(true);
  });

  it("stays quiet while the conversation is live — the bell is enough", () => {
    expect(shouldEmailForMessage({ lastMessageAt: new Date(Date.now() - 60_000) })).toBe(false);
  });
});

describe("paths and previews", () => {
  it("sends every requester straight to their conversation, and each handler to their own inbox", () => {
    expect(requesterTicketPath("support", "t1")).toBe("/dashboard/support?ticket=t1");
    // A brand admin's request is read on the Support page too — never via their inbox, which would
    // mount, 404 on the admin API and only then hop across (two screens flashing past). `from=inbox`
    // is the way back.
    expect(requesterTicketPath("brand", "t1")).toBe("/dashboard/support?ticket=t1&from=inbox");
    expect(handlerTicketPath("support", "t1")).toBe("/dashboard/admin/tickets?ticket=t1");
    expect(handlerTicketPath("brand", "t1")).toBe("/superadmin/tickets?ticket=t1");
  });

  it("truncates a long preview and describes an attachment-only message", () => {
    expect(preview("It rings once then drops.")).toBe("It rings once then drops.");
    const long = preview("x".repeat(400));
    expect(long).toHaveLength(301);
    expect(long.endsWith("…")).toBe(true);
    expect(preview("   ", true)).toBe("(sent an attachment)");
    expect(preview("", false)).toBe("");
  });
});

describe("serializeTicketForRequester — the handler's name never crosses over", () => {
  /* A ticket assigned to a real person, as the database has it. */
  const assigned = (lane: "support" | "brand") => ({
    id: "t1",
    number: 8,
    reference: "TCK-000008",
    subject: "Wallet payout has not landed",
    lane,
    status: "pending" as const,
    priority: "normal" as const,
    source: "portal" as const,
    brandId: "b1",
    departmentId: "d1",
    requesterId: "u1",
    assignedToId: "s9",
    updatedAt: new Date(0),
    department: { id: "d1", name: "Billing & Wallet" },
    requester: { id: "u1", fullName: "Bea Admin", email: "bea@northwind.test", role: "ADMIN" as const },
    assignedTo: { id: "s9", fullName: "Super Admin", email: "superadmin@platform.test" },
    lastMessageAt: new Date(0),
    createdAt: new Date(0),
    closedAt: null,
    unreadForStaff: false,
    unreadForRequester: true,
    staffReadAt: null,
    requesterReadAt: null,
    rating: null,
    ratingComment: "",
    ratedAt: null,
    escalatedFromId: null,
    escalatedFromBrandId: null,
    escalationId: null,
    requesterBrandId: "b1",
    requesterName: "Bea Admin",
    requesterEmail: "bea@northwind.test",
    escalatedFrom: null,
    escalation: null,
  });

  it("hands the handler the real person, and names the brand from the cache", () => {
    // The inbox has to name who holds a ticket — that is how a team divides work.
    const full = serializeTicket(assigned("brand"));
    expect(full.assignedTo).toEqual({ id: "s9", name: "Super Admin" });
    expect(full.brand).toEqual({ id: "b1", name: "Northwind Voice", slug: "northwind" });
  });

  it("hands the requester a team, not a person", () => {
    // The regression: the transcript masked handlers as "Platform" but the side
    // panel still said "Super Admin is looking after this."
    expect(serializeTicketForRequester(assigned("brand")).assignedTo).toEqual({
      id: null,
      name: "Platform",
    });
  });

  it("uses the other lane's label on the other lane", () => {
    expect(serializeTicketForRequester(assigned("support")).assignedTo).toEqual({
      id: null,
      name: "Support",
    });
  });

  it("leaks no handler name or address anywhere else in the payload", () => {
    // Cheap and broad on purpose: a field added later that carries the handler
    // through fails here without anyone remembering to update this test.
    const json = JSON.stringify(serializeTicketForRequester(assigned("brand")));
    expect(json).not.toContain("Super Admin");
    expect(json).not.toContain("superadmin@platform.test");
    expect(json).not.toContain("s9");
  });

  it("still says an unassigned ticket is unassigned", () => {
    // Masking must not invent a holder — "somebody has this" is a real signal
    // and it has to stay false while it is false.
    const open = { ...assigned("brand"), assignedTo: null };
    expect(serializeTicketForRequester(open).assignedTo).toBeNull();
  });

  it("changes nothing else about the ticket", () => {
    const full = serializeTicket(assigned("brand"));
    const masked = serializeTicketForRequester(assigned("brand"));
    const { assignedTo: _a, ...restFull } = full;
    const { assignedTo: _b, ...restMasked } = masked;
    expect(restMasked).toEqual(restFull);
  });
});
