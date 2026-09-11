import { describe, it, expect } from "vitest";
import { bookingPromptSection, buildBookingTools } from "./vapi.js";
import type { BookingConfig } from "./booking/config.js";
import { parseWorkingHours } from "./booking/hours.js";

/* ------------------------------------------------------------------ *
 *  Booking is deliberately simple now: the AI books on the call when — and only
 *  when — the owner has auto-booking ON and Google Calendar connected
 *  (canAutoBook). Otherwise it takes a message. There is no website/link path.
 *
 *  INVARIANT: the prompt only ever describes abilities the AI actually has. If
 *  canAutoBook, the create/availability tools are attached and the prompt says
 *  "book them in yourself"; if not, no tools and the prompt says take a message.
 * ------------------------------------------------------------------ */

function cfg(over: Partial<BookingConfig> = {}): BookingConfig {
  return {
    connected: false,
    autoBookEnabled: false,
    canAutoBook: false,
    durationMin: 30,
    calendarId: "primary",
    timezone: "UTC",
    hours: parseWorkingHours(""),
    businessName: "Example Co",
    ...over,
  };
}

const TOOL_NAMES = (c: BookingConfig) =>
  buildBookingTools(c, "user_1", "https://api.example.com").map((t) => t.function.name);

describe("booking tools follow canAutoBook", () => {
  it("no tools when the AI cannot auto-book", () => {
    expect(TOOL_NAMES(cfg())).toHaveLength(0);
  });

  it("the full booking tool family attaches when canAutoBook", () => {
    const names = TOOL_NAMES(cfg({ connected: true, autoBookEnabled: true, canAutoBook: true }));
    expect(names).toEqual(
      expect.arrayContaining([
        "checkAvailability",
        "createBooking",
        "cancelBooking",
        "rescheduleBooking",
      ]),
    );
  });

  it("never attaches a website/link tool — that feature is gone", () => {
    const names = TOOL_NAMES(cfg({ connected: true, autoBookEnabled: true, canAutoBook: true }));
    expect(names).not.toContain("sendBookingLink");
  });
});

describe("booking prompt matches the tools", () => {
  it("canAutoBook → prompt tells the AI to book on the call", () => {
    const p = bookingPromptSection(cfg({ connected: true, autoBookEnabled: true, canAutoBook: true }));
    expect(p).toContain("## BOOKINGS");
    expect(p).toContain("book it for them yourself on this call");
    expect(p).toContain("createBooking");
    // No website language anywhere.
    expect(p).not.toContain("website");
    expect(p).not.toContain("sendBookingLink");
  });

  it("cannot auto-book → prompt tells the AI to take a message", () => {
    const p = bookingPromptSection(cfg());
    expect(p).toContain("## BOOKINGS");
    expect(p).toContain("cannot book it directly");
    expect(p).toContain("Take their name, number and reason as a message");
    expect(p).toContain("Never claim a booking is scheduled");
    expect(p).not.toContain("website");
  });

  it("auto-book stays off until Google Calendar is actually connected", () => {
    // Toggle on but not connected → canAutoBook false → no tools, take-a-message.
    const wanted = cfg({ connected: false, autoBookEnabled: true, canAutoBook: false });
    expect(TOOL_NAMES(wanted)).toHaveLength(0);
    expect(bookingPromptSection(wanted)).toContain("cannot book it directly");
  });
});
