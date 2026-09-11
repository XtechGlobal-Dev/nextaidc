import { describe, it, expect } from "vitest";
import { turnsFromVapiMessages } from "./vapiTranscript.js";

/* ------------------------------------------------------------------ *
 *  Phone-call transcripts must carry per-turn timing, built from Vapi's
 *  structured artifact.messages (which the plain-string transcript lacks).
 * ------------------------------------------------------------------ */

describe("turnsFromVapiMessages", () => {
  it("maps bot→agent / user→caller and uses secondsFromStart as `at`", () => {
    const turns = turnsFromVapiMessages([
      { role: "bot", message: "Thanks for calling HomeVista. How can I help?", secondsFromStart: 0 },
      { role: "user", message: "At what time do you open?", secondsFromStart: 5 },
      { role: "bot", message: "We're open 9 to 5.", secondsFromStart: 9 },
    ]);
    expect(turns).toEqual([
      { role: "agent", text: "Thanks for calling HomeVista. How can I help?", at: 0 },
      { role: "caller", text: "At what time do you open?", at: 5 },
      { role: "agent", text: "We're open 9 to 5.", at: 9 },
    ]);
  });

  it("drops system / tool messages, keeping only spoken turns", () => {
    const turns = turnsFromVapiMessages([
      { role: "system", message: "You are a receptionist.", secondsFromStart: 0 },
      { role: "bot", message: "Hi!", secondsFromStart: 1 },
      { role: "tool_calls", message: "", secondsFromStart: 2 },
      { role: "tool_call_result", message: "{...}", secondsFromStart: 3 },
      { role: "user", message: "Hello", secondsFromStart: 4 },
    ]);
    expect(turns).toEqual([
      { role: "agent", text: "Hi!", at: 1 },
      { role: "caller", text: "Hello", at: 4 },
    ]);
  });

  it("rounds fractional secondsFromStart", () => {
    const turns = turnsFromVapiMessages([{ role: "user", message: "Hi", secondsFromStart: 5.7 }]);
    expect(turns).toEqual([{ role: "caller", text: "Hi", at: 6 }]);
  });

  it("falls back to epoch `time` (relative to the earliest) when secondsFromStart is absent", () => {
    const t0 = 1_785_000_000_000;
    const turns = turnsFromVapiMessages([
      { role: "bot", message: "Hi", time: t0 },
      { role: "user", message: "Hey", time: t0 + 6000 },
    ]);
    expect(turns).toEqual([
      { role: "agent", text: "Hi", at: 0 },
      { role: "caller", text: "Hey", at: 6 },
    ]);
  });

  it("accepts `content` as an alternative text field", () => {
    const turns = turnsFromVapiMessages([{ role: "assistant", content: "Hello there", secondsFromStart: 0 }]);
    expect(turns).toEqual([{ role: "agent", text: "Hello there", at: 0 }]);
  });

  it("defaults `at` to 0 when there is no timing at all", () => {
    const turns = turnsFromVapiMessages([{ role: "user", message: "Hi" }]);
    expect(turns).toEqual([{ role: "caller", text: "Hi", at: 0 }]);
  });

  it("returns null for a non-array, empty, or no-spoken input (caller falls back to the string)", () => {
    expect(turnsFromVapiMessages(undefined)).toBeNull();
    expect(turnsFromVapiMessages("AI: hi")).toBeNull();
    expect(turnsFromVapiMessages([])).toBeNull();
    expect(turnsFromVapiMessages([{ role: "system", message: "prompt" }])).toBeNull();
  });
});
