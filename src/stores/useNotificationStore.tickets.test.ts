import { describe, expect, it } from "vitest";
import {
  ticketIdFromLink,
  unreadTicketCounts,
  type AppNotification,
} from "@/stores/useNotificationStore";

// Which bell a ticket notification rings. A brand admin holds two surfaces at once
// (answers customers, asks the platform), so the split is decided purely by the server-written link.

const REQUESTER = (id: string) => `/dashboard/support?ticket=${id}`;
const SUPPORT_INBOX = (id: string) => `/dashboard/admin/tickets?ticket=${id}`;
const BRAND_INBOX = (id: string) => `/superadmin/tickets?ticket=${id}`;

function note(over: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    type: "ticket",
    title: "Reply on TCK-1",
    message: "",
    read: false,
    createdAt: "2026-09-04T10:00:00.000Z",
    ...over,
  };
}

describe("ticketIdFromLink", () => {
  it("reads the ticket id off every ticket surface's link", () => {
    expect(ticketIdFromLink(REQUESTER("abc"))).toBe("abc");
    expect(ticketIdFromLink(SUPPORT_INBOX("def"))).toBe("def");
    expect(ticketIdFromLink(BRAND_INBOX("ghi"))).toBe("ghi");
  });

  it("copes with extra params and a missing one", () => {
    expect(ticketIdFromLink("/dashboard/support?rate=1&ticket=t9")).toBe("t9");
    expect(ticketIdFromLink("/dashboard/support?ticket=")).toBeNull();
    expect(ticketIdFromLink("/dashboard/calls")).toBeNull();
    expect(ticketIdFromLink(null)).toBeNull();
    expect(ticketIdFromLink(undefined)).toBeNull();
  });
});

describe("unreadTicketCounts", () => {
  it("gives the brand admin two independent bells — one per side they hold", () => {
    // The middle rung of the hierarchy answers below and asks above, so a
    // single combined count would tell them the wrong thing on both screens.
    const counts = unreadTicketCounts([
      note({ id: "1", link: SUPPORT_INBOX("t1") }),
      note({ id: "2", link: SUPPORT_INBOX("t2") }),
      note({ id: "3", link: REQUESTER("t3") }),
    ]);
    expect(counts).toEqual({ requester: 1, supportInbox: 2, brandInbox: 0 });
  });

  it("keeps the platform owner's inbox separate from a brand's", () => {
    const counts = unreadTicketCounts([
      note({ id: "1", link: BRAND_INBOX("t1") }),
      note({ id: "2", link: SUPPORT_INBOX("t2") }),
    ]);
    expect(counts).toEqual({ requester: 0, supportInbox: 1, brandInbox: 1 });
  });

  it("counts only what is unread", () => {
    const counts = unreadTicketCounts([
      note({ id: "1", link: SUPPORT_INBOX("t1") }),
      note({ id: "2", link: SUPPORT_INBOX("t2"), read: true }),
    ]);
    expect(counts.supportInbox).toBe(1);
  });

  it("ignores everything that isn't a ticket", () => {
    const counts = unreadTicketCounts([
      note({ id: "1", type: "billing", title: "Plan renewed", link: "/dashboard/plans" }),
      note({ id: "2", type: "missed_call", title: "Missed call", link: "/dashboard/calls" }),
    ]);
    expect(counts).toEqual({ requester: 0, supportInbox: 0, brandInbox: 0 });
  });

  it("counts a ring inside a ticket like the ticket itself", () => {
    const counts = unreadTicketCounts([
      note({ id: "1", type: "ticket_video_call", title: "Incoming video call", link: SUPPORT_INBOX("t1") }),
      note({ id: "2", type: "ticket_voice_call", title: "Incoming audio call", link: REQUESTER("t2") }),
    ]);
    expect(counts).toEqual({ requester: 1, supportInbox: 1, brandInbox: 0 });
  });

  it("counts nothing for a ticket notification with no link to follow", () => {
    // Every ticket row the server writes carries one, so this is defensive —
    // but a bell that rings and then goes nowhere is worse than no bell.
    expect(unreadTicketCounts([note({ id: "1", link: undefined })])).toEqual({
      requester: 0,
      supportInbox: 0,
      brandInbox: 0,
    });
  });

  it("is all zeros for an empty list", () => {
    expect(unreadTicketCounts([])).toEqual({
      requester: 0,
      supportInbox: 0,
      brandInbox: 0,
    });
  });
});
