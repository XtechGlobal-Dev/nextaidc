import { describe, it, expect } from "vitest";
import { parseToolCalls, toolArgBoolean, toolArgString } from "./vapiToolCalls.js";

describe("parseToolCalls", () => {
  it("reads the toolCallList shape with string arguments", () => {
    const out = parseToolCalls({
      message: {
        toolCallList: [
          { id: "tc1", function: { name: "sendInfoSms", arguments: '{"topic":"website"}' } },
        ],
        call: { id: "call_1", customer: { number: "+61412345678" } },
      },
    });
    expect(out.calls).toEqual([{ id: "tc1", name: "sendInfoSms", args: { topic: "website" } }]);
    expect(out.callerNumber).toBe("+61412345678");
    expect(out.callId).toBe("call_1");
  });

  it("reads the toolCalls shape with object arguments", () => {
    const out = parseToolCalls({
      message: { toolCalls: [{ id: "tc2", name: "sendInfoSms", arguments: { topic: "email" } }] },
    });
    expect(out.calls[0]).toEqual({ id: "tc2", name: "sendInfoSms", args: { topic: "email" } });
  });

  it("tolerates malformed JSON arguments by treating them as empty", () => {
    const out = parseToolCalls({
      message: { toolCallList: [{ id: "x", function: { name: "n", arguments: "{not json" } }] },
    });
    expect(out.calls[0].args).toEqual({});
  });

  it("skips entries with no name", () => {
    const out = parseToolCalls({ message: { toolCallList: [{ id: "x", function: {} }] } });
    expect(out.calls).toEqual([]);
  });

  it("returns empty structures for a body with no message", () => {
    expect(parseToolCalls({})).toEqual({ calls: [], callerNumber: "", callId: "" });
  });
});

describe("toolArgString", () => {
  it("trims a string", () => {
    expect(toolArgString("  hi ")).toBe("hi");
  });
  it("treats a non-string as absent", () => {
    expect(toolArgString(42)).toBe("");
  });
});

describe("toolArgBoolean", () => {
  it("passes a real boolean through", () => {
    expect(toolArgBoolean(true)).toBe(true);
    expect(toolArgBoolean(false)).toBe(false);
  });
  it("accepts the string 'true' the model sometimes emits", () => {
    expect(toolArgBoolean("true")).toBe(true);
    expect(toolArgBoolean("TRUE")).toBe(true);
  });
  it("treats anything else as false", () => {
    expect(toolArgBoolean("yes")).toBe(false);
    expect(toolArgBoolean(undefined)).toBe(false);
  });
});
