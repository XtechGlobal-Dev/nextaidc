import { describe, expect, it } from "vitest";
import { SAVED_REPLY_VARIABLES, fillSavedReply } from "./savedReplies";
import type { Ticket } from "@/types/ticket";

/* A saved reply goes out as a real message, so a blank that fails to fill is
 * a "Hi {{requester_first_name}}" the customer actually reads. */

const TICKET = {
  id: "t1",
  number: 42,
  reference: "TCK-7F3K2Q",
  subject: "Calls not forwarding",
  lane: "support",
  status: "open",
  priority: "normal",
  source: "app",
  department: { id: "d1", name: "Technical" },
  requester: { id: "u1", name: "Jane Doe", email: "jane@acme.test", role: "USER" },
  brand: { id: "b1", name: "Acme Voice", slug: "acme" },
  assignedTo: null,
  lastMessageAt: "2026-09-04T10:00:00.000Z",
  createdAt: "2026-09-04T09:00:00.000Z",
  closedAt: null,
  unreadForStaff: true,
  unreadForRequester: false,
  rating: null,
  ratingComment: "",
  ratedAt: null,
  rateable: false,
} as Ticket;

describe("fillSavedReply", () => {
  it("fills every blank the editor offers", () => {
    // The chips in the editor and the substitution here read from one list, so
    // this proves a chip can never insert a token nothing replaces.
    for (const { token } of SAVED_REPLY_VARIABLES) {
      const out = fillSavedReply(token, TICKET, "Sam Patel");
      expect({ token, out }).not.toEqual({ token, out: token });
    }
  });

  it("uses the requester's name, and their first name on its own", () => {
    expect(fillSavedReply("Hi {{requester_first_name}},", TICKET, "Sam")).toBe("Hi Jane,");
    expect(fillSavedReply("{{requester_name}}", TICKET, "Sam")).toBe("Jane Doe");
  });

  it("names the request the way each side refers to it", () => {
    expect(fillSavedReply("{{ticket_number}} / {{ticket_reference}}", TICKET, "Sam")).toBe(
      "#42 / TCK-7F3K2Q",
    );
  });

  it("carries the tenant, which is what a platform-side reply needs", () => {
    expect(fillSavedReply("Thanks for flagging this, {{brand_name}}.", TICKET, "Sam")).toBe(
      "Thanks for flagging this, Acme Voice.",
    );
  });

  it("signs off with whoever is actually replying", () => {
    expect(fillSavedReply("— {{agent_name}}", TICKET, "Sam Patel")).toBe("— Sam Patel");
  });

  it("falls back to a greeting that still reads as English", () => {
    const nameless = { ...TICKET, requester: { ...TICKET.requester, name: "" } };
    expect(fillSavedReply("Hi {{requester_first_name}},", nameless, "Sam")).toBe("Hi there,");
  });

  it("leaves an unknown blank exactly as typed, so a typo is visible", () => {
    // Silently dropping it would send a sentence with a hole in it.
    expect(fillSavedReply("Hi {{custmer_name}},", TICKET, "Sam")).toBe("Hi {{custmer_name}},");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(fillSavedReply("{{ subject }}", TICKET, "Sam")).toBe("Calls not forwarding");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(fillSavedReply("{{subject}} — {{subject}}", TICKET, "Sam")).toBe(
      "Calls not forwarding — Calls not forwarding",
    );
  });

  it("says Support for a request with no department rather than leaving a gap", () => {
    const orphan = { ...TICKET, department: null };
    expect(fillSavedReply("The {{department}} team", orphan, "Sam")).toBe("The Support team");
  });
});
