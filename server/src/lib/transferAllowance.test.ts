import { describe, it, expect } from "vitest";

import { MAX_DEPARTMENTS, transferDepartmentAllowance } from "./transfer.js";

// `callTransferLimit` is 0 for both "unlimited" and "feature off" — each case here is one a raw read gets backwards.

describe("transferDepartmentAllowance", () => {
  it("gives nothing when the plan excludes transfer, whatever the limit says", () => {
    // The STARTER case, and the one a naive `limit || Infinity` read gets wrong:
    // limit 0 here means "not applicable", not "unlimited".
    expect(transferDepartmentAllowance({ callTransferEnabled: false, callTransferLimit: 0 })).toBe(0);
    // A stale limit left behind by a plan that used to include transfer must not
    // resurrect the feature once the toggle goes off.
    expect(transferDepartmentAllowance({ callTransferEnabled: false, callTransferLimit: 5 })).toBe(0);
  });

  it("honours a real cap", () => {
    expect(transferDepartmentAllowance({ callTransferEnabled: true, callTransferLimit: 3 })).toBe(3);
    expect(transferDepartmentAllowance({ callTransferEnabled: true, callTransferLimit: 1 })).toBe(1);
  });

  it("reads 0 as unlimited once the feature is on", () => {
    expect(transferDepartmentAllowance({ callTransferEnabled: true, callTransferLimit: 0 })).toBe(
      MAX_DEPARTMENTS,
    );
  });

  it("never promises more than the tool supports", () => {
    // An admin typing 500 doesn't get 500 — the prompt handed to Vapi has to stay
    // bounded, so the hard ceiling wins over the plan's number.
    expect(
      transferDepartmentAllowance({ callTransferEnabled: true, callTransferLimit: 500 }),
    ).toBe(MAX_DEPARTMENTS);
  });

  it("treats a missing plan as no allowance", () => {
    // Reached whenever a lapsed or plan-less profile is resolved; falling open
    // here would hand transfer to accounts that never paid for it.
    expect(transferDepartmentAllowance(null)).toBe(0);
    expect(transferDepartmentAllowance(undefined)).toBe(0);
  });
});
