import { describe, it, expect } from "vitest";
import { bumpSession, sessionMark, sessionChanged } from "./sessionEpoch";

describe("sessionEpoch", () => {
  it("a mark stays valid until the session changes", () => {
    const mark = sessionMark();
    expect(sessionChanged(mark)).toBe(false);
    bumpSession();
    // The in-flight response taken under the old mark is now stale.
    expect(sessionChanged(mark)).toBe(true);
  });

  it("a mark taken after the bump is valid again", () => {
    bumpSession();
    const mark = sessionMark();
    expect(sessionChanged(mark)).toBe(false);
  });

  it("models the login race: an abc response is dropped after xyz signs in", () => {
    const abcMark = sessionMark(); // abc fires a hydrate
    bumpSession(); // abc logs out / xyz logs in (resetUserStores)
    const xyzMark = sessionMark(); // xyz fires its own hydrate
    // abc's response arrives late → dropped; xyz's applies.
    expect(sessionChanged(abcMark)).toBe(true);
    expect(sessionChanged(xyzMark)).toBe(false);
  });
});
