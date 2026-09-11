import { describe, it, expect } from "vitest";
import {
  callerContactCaptured,
  classifyIntentHeuristic,
  normalizeIntent,
  resolveIntent,
} from "./callIntent.js";

describe("normalizeIntent", () => {
  it("passes through the canonical values", () => {
    expect(normalizeIntent("booking")).toBe("booking");
    expect(normalizeIntent("Support")).toBe("support");
  });

  it("maps synonyms and loose formatting the model might return", () => {
    expect(normalizeIntent("Appointment")).toBe("booking");
    expect(normalizeIntent("inquiry")).toBe("enquiry");
    expect(normalizeIntent("wrong-number")).toBe("spam");
  });

  it("returns '' for anything unrecognised rather than guessing", () => {
    expect(normalizeIntent("banana")).toBe("");
    expect(normalizeIntent("")).toBe("");
    expect(normalizeIntent(undefined)).toBe("");
    expect(normalizeIntent(42)).toBe("");
  });
});

describe("callerContactCaptured", () => {
  it("is true when the caller volunteered a name, email or callback number", () => {
    expect(callerContactCaptured({ name: "Sarah Cole" })).toBe(true);
    expect(callerContactCaptured({ email: "sarah@example.com" })).toBe(true);
    expect(callerContactCaptured({ phone: "0412 345 678" })).toBe(true);
  });

  it("ignores the placeholders the extraction model writes when nothing was said", () => {
    expect(callerContactCaptured({ name: "", email: "", phone: "" })).toBe(false);
    expect(callerContactCaptured({ name: "Unknown", phone: "N/A" })).toBe(false);
    expect(callerContactCaptured({ name: "not provided" })).toBe(false);
    expect(callerContactCaptured({})).toBe(false);
    expect(callerContactCaptured(null)).toBe(false);
  });
});

describe("classifyIntentHeuristic", () => {
  it("covers only support and spam", () => {
    expect(classifyIntentHeuristic({ purpose: "Complaint about late delivery" })).toBe("support");
    expect(classifyIntentHeuristic({ transcript: "Caller: sorry, wrong number" })).toBe("spam");
  });

  it("never guesses booking from booking words", () => {
    // The bug this replaced: /book/ matched every call to a restaurant or hotel.
    expect(classifyIntentHeuristic({ purpose: "Booking a haircut" })).toBe("");
    expect(classifyIntentHeuristic({ transcript: "Caller: I want to book a table." })).toBe("");
  });

  it("never guesses lead vs enquiry — that is the contact rule's job", () => {
    expect(classifyIntentHeuristic({ purpose: "Quote for bathroom reno" })).toBe("");
    expect(classifyIntentHeuristic({ transcript: "Caller: are you open on Sunday?" })).toBe("");
  });

  it("returns '' when nothing matches", () => {
    expect(classifyIntentHeuristic({ summary: "The caller said hello and hung up." })).toBe("");
    expect(classifyIntentHeuristic({})).toBe("");
  });
});

describe("resolveIntent", () => {
  it("lets a confirmed appointment outrank every other signal", () => {
    expect(
      resolveIntent({
        bookingConfirmed: true,
        structuredIntent: "support",
        structured: { name: "Sarah" },
      }),
    ).toBe("booking");
  });

  it("never badges booking without a confirmed appointment", () => {
    // Even if a model insists — talking about booking is not booking.
    expect(
      resolveIntent({
        structuredIntent: "booking",
        summary: "Wants to book a table",
        callerText: "I want to book a table.",
      }),
    ).toBe("enquiry");
  });

  it("treats an unfinished booking that captured details as a LEAD", () => {
    // The real regression: caller asked to book a table, no time was ever
    // confirmed, but she gave her name and callback number. Nothing is in the
    // diary — the owner has to ring her back. That is a lead.
    expect(
      resolveIntent({
        bookingConfirmed: false,
        structured: { name: "Gina", phone: "0412345678" },
        summary: "The caller, Gina, wants to book a dining table for tomorrow.",
        transcript: "Caller: I want to book a table. Agent: The team will follow up to confirm.",
        callerText: "I want to book a table.",
      }),
    ).toBe("lead");
  });

  it("ranks support above lead so a complaint never becomes a sales lead", () => {
    expect(
      resolveIntent({ structuredIntent: "support", structured: { name: "Dave", phone: "0400111222" } }),
    ).toBe("support");
  });

  it("ranks spam above everything but a confirmed booking", () => {
    expect(resolveIntent({ structuredIntent: "spam", structured: { name: "Telco Offers" } })).toBe(
      "spam",
    );
  });

  it("calls it a lead when the caller volunteered contact details", () => {
    expect(
      resolveIntent({
        structured: { name: "Sarah Cole", phone: "0412345678" },
        summary: "Asked what a bathroom reno would cost.",
      }),
    ).toBe("lead");
  });

  it("does NOT trust the model's own lead/enquiry opinion", () => {
    // Model says lead, but the caller left nothing to follow up with → enquiry.
    expect(
      resolveIntent({
        structuredIntent: "lead",
        summary: "Asked about pricing.",
        structured: {},
        callerText: "How much do you charge?",
      }),
    ).toBe("enquiry");
    // Model says enquiry, but they gave us their details → lead.
    expect(
      resolveIntent({
        structuredIntent: "enquiry",
        summary: "Asked about pricing.",
        structured: { email: "sarah@example.com" },
      }),
    ).toBe("lead");
  });

  it("defaults to enquiry when the caller asked something but left no details", () => {
    expect(
      resolveIntent({
        transcript: "Agent: How can I help? Caller: are you open on Sunday?",
        callerText: "are you open on Sunday?",
      }),
    ).toBe("enquiry");
  });

  it("treats a silent caller as spam", () => {
    // The agent greeted an empty line and the caller hung up. Nothing to answer,
    // follow up or file.
    expect(
      resolveIntent({
        transcript: "Agent: Thanks for calling. Agent: How can I help you today?",
        callerText: "",
      }),
    ).toBe("spam");
    // Punctuation-only caller turns are still silence.
    expect(
      resolveIntent({ transcript: "Agent: Hello? Caller: …", callerText: " … ? " }),
    ).toBe("spam");
  });

  it("ignores an AI summary that invents a caller who never spoke", () => {
    // Given an agent-only transcript the summariser writes "the caller inquired
    // about our services". That hallucination must not become an Enquiry badge.
    expect(
      resolveIntent({
        transcript: "Agent: Thanks for calling Luxury Hotels and Resorts.",
        summary: "The caller inquired about services offered by Luxury Hotels and Resorts.",
        callerText: "",
      }),
    ).toBe("spam");
  });

  it("stays unbadged when there is no transcript at all", () => {
    // No data is not the same as junk — never report "we don't know" as spam.
    expect(resolveIntent({ callerText: "" })).toBe("");
    expect(resolveIntent({ summary: "Something happened." })).toBe("");
  });

  it("never calls a call spam just because callerText wasn't supplied", () => {
    // undefined means "we weren't told", not "they were silent". Without this
    // guard a call site that forgets the field would suppress every lead.
    expect(
      resolveIntent({
        transcript: "Agent: Hi. Caller: I'm Sarah, here's my number.",
        structured: { name: "Sarah" },
      }),
    ).toBe("lead");
  });

  it("leaves an empty call unclassified rather than badging it", () => {
    expect(resolveIntent({})).toBe("");
    expect(resolveIntent({ structured: {}, summary: "  " })).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 *  The agreed spec, one test per case. If this block passes, the five
 *  categories behave exactly as specified — no ambiguity between them.
 * ------------------------------------------------------------------ */
describe("the five categories, end to end", () => {
  const AGENT = "Agent: Thanks for calling. How can I help you today?";

  it("BOOKING — an appointment was actually created", () => {
    expect(
      resolveIntent({
        bookingConfirmed: true,
        transcript: `${AGENT} Caller: Book me for Tuesday at 2. Agent: Done, you're booked.`,
        callerText: "Book me for Tuesday at 2.",
        structured: { name: "Ravi" },
      }),
    ).toBe("booking");
  });

  it("LEAD — the caller gave details, or the AI took them", () => {
    // Volunteered.
    expect(
      resolveIntent({
        transcript: `${AGENT} Caller: I'm Sarah, call me on 0412 345 678.`,
        callerText: "I'm Sarah, call me on 0412 345 678.",
        structured: { name: "Sarah", phone: "0412345678" },
      }),
    ).toBe("lead");
    // Asked for by the AI at the end of the call — same field, same result.
    expect(
      resolveIntent({
        transcript: `${AGENT} Caller: Yes. Agent: What's the best name? Caller: Gina.`,
        callerText: "Yes. Gina.",
        structured: { name: "Gina" },
      }),
    ).toBe("lead");
  });

  it("LEAD — beats a booking that was only ever discussed", () => {
    // Wanted a table, no appointment exists, but we have her details.
    expect(
      resolveIntent({
        bookingConfirmed: false,
        structuredIntent: "booking",
        transcript: `${AGENT} Caller: I want to book a table. Agent: The team will follow up.`,
        callerText: "I want to book a table.",
        structured: { name: "Gina", phone: "0412345678" },
      }),
    ).toBe("lead");
  });

  it("LEAD — a web/test call, where there is no structuredData to read", () => {
    // The real regression: the caller asked to book a room, the AI couldn't book
    // so it took their name and confirmed the callback number, and the team was
    // told to follow up. Web calls carry structuredData: null, so this can only
    // work via the transcript read.
    expect(
      resolveIntent({
        bookingConfirmed: false,
        structured: {}, // web call — nothing extracted
        contactCaptured: true, // ...but the transcript read says we got them
        transcript: "Agent: What's your name? Caller: V I. Agent: Is this number best? Caller: Yes.",
        callerText: "I want to book a room. V I. Tomorrow. 2 nights. Chandigarh. Yes.",
      }),
    ).toBe("lead");
  });

  it("ENQUIRY — asked to book but refused to leave any details", () => {
    expect(
      resolveIntent({
        structured: {},
        contactCaptured: false,
        transcript: "Agent: Can I take your name? Caller: No thanks, I'll call back.",
        callerText: "I want to book a room. No thanks, I'll call back.",
      }),
    ).toBe("enquiry");
  });

  it("SUPPORT — an existing customer with a problem", () => {
    expect(
      resolveIntent({
        transcript: `${AGENT} Caller: My order hasn't arrived and it's a week late.`,
        callerText: "My order hasn't arrived and it's a week late.",
        // Even with their details captured, it's support, not a new lead.
        structured: { name: "Dave", phone: "0400111222" },
      }),
    ).toBe("support");
  });

  it("ENQUIRY — everything else the caller actually asked", () => {
    expect(
      resolveIntent({
        transcript: `${AGENT} Caller: Are you open on Sunday?`,
        callerText: "Are you open on Sunday?",
        structured: {},
      }),
    ).toBe("enquiry");
  });

  it("SPAM — wrong number, robocall, or nothing said", () => {
    expect(
      resolveIntent({
        transcript: `${AGENT} Caller: Sorry, wrong number.`,
        callerText: "Sorry, wrong number.",
      }),
    ).toBe("spam");
    expect(
      resolveIntent({
        structuredIntent: "spam",
        transcript: `${AGENT} Caller: I'm calling about your business insurance.`,
        callerText: "I'm calling about your business insurance.",
      }),
    ).toBe("spam");
    expect(resolveIntent({ transcript: AGENT, callerText: "" })).toBe("spam");
  });

  it("every case is mutually exclusive — no call gets two answers", () => {
    // A call that trips several signals resolves to exactly one, by precedence.
    const kitchenSink = {
      bookingConfirmed: true,
      structuredIntent: "support",
      llmIntent: "spam",
      structured: { name: "Ravi", email: "ravi@example.com" },
      transcript: `${AGENT} Caller: my order is late, and book me in for Tuesday.`,
      callerText: "my order is late, and book me in for Tuesday.",
    };
    expect(resolveIntent(kitchenSink)).toBe("booking");
    // Drop the proof and the next rule down takes over, cleanly.
    expect(resolveIntent({ ...kitchenSink, bookingConfirmed: false })).toBe("support");
  });
});
