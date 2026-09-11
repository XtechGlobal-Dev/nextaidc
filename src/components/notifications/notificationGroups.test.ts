import { describe, it, expect } from "vitest";

/* ------------------------------------------------------------------ *
 *  The rules behind the notifications slide-over: which chip a notification
 *  falls under, which day-group it lands in, and how its timestamp reads.
 * ------------------------------------------------------------------ */

import {
  filterNotifications,
  formatNotificationTime,
  groupKeyFor,
  groupNotifications,
  matchesFilter,
} from "./notificationGroups";

// A fixed "now" so the tests never depend on when they run:
// Wednesday 3 September 2025, 14:00 local time.
const NOW = new Date(2025, 8, 3, 14, 0, 0);
const at = (y: number, m: number, d: number, h = 9, min = 0) =>
  new Date(y, m, d, h, min).toISOString();

describe("groupKeyFor", () => {
  it("puts anything since local midnight in Today", () => {
    expect(groupKeyFor(at(2025, 8, 3, 0, 0), NOW)).toBe("today");
    expect(groupKeyFor(at(2025, 8, 3, 13, 59), NOW)).toBe("today");
  });

  it("treats a slightly future timestamp (server clock skew) as Today, not Earlier", () => {
    expect(groupKeyFor(at(2025, 8, 3, 14, 5), NOW)).toBe("today");
  });

  it("uses the local calendar day for Yesterday", () => {
    expect(groupKeyFor(at(2025, 8, 2, 23, 59), NOW)).toBe("yesterday");
    expect(groupKeyFor(at(2025, 8, 2, 0, 0), NOW)).toBe("yesterday");
  });

  it("files everything older under Earlier", () => {
    expect(groupKeyFor(at(2025, 8, 1, 23, 59), NOW)).toBe("earlier");
    expect(groupKeyFor(at(2024, 8, 3), NOW)).toBe("earlier");
  });

  it("crosses a month boundary correctly", () => {
    const firstOfMonth = new Date(2025, 9, 1, 8, 0);
    expect(groupKeyFor(at(2025, 8, 30, 22, 0), firstOfMonth)).toBe("yesterday");
  });

  it("never throws on a bad timestamp", () => {
    expect(groupKeyFor("not-a-date", NOW)).toBe("earlier");
  });
});

describe("groupNotifications", () => {
  it("buckets in Today → Yesterday → Earlier order and drops empty groups", () => {
    const list = [
      { id: "a", createdAt: at(2025, 8, 3, 10) },
      { id: "b", createdAt: at(2025, 8, 1) },
      { id: "c", createdAt: at(2025, 8, 3, 8) },
    ];
    const groups = groupNotifications(list, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Earlier"]);
    // Input (newest-first) order is kept inside a group.
    expect(groups[0].items.map((n) => n.id)).toEqual(["a", "c"]);
    expect(groups[1].items.map((n) => n.id)).toEqual(["b"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupNotifications([], NOW)).toEqual([]);
  });
});

describe("formatNotificationTime", () => {
  it("shows just the time for today", () => {
    expect(formatNotificationTime(at(2025, 8, 3, 10, 30), NOW, "en-US")).toBe("10:30 AM");
  });

  it("prefixes Yesterday, with a zero-padded hour", () => {
    expect(formatNotificationTime(at(2025, 8, 2, 16, 45), NOW, "en-US")).toBe("Yesterday, 04:45 PM");
  });

  it("shows month + day for earlier this year", () => {
    expect(formatNotificationTime(at(2025, 7, 29, 11, 5), NOW, "en-US")).toBe("Aug 29, 11:05 AM");
  });

  it("adds the year once it's a different year", () => {
    expect(formatNotificationTime(at(2024, 11, 24, 9, 0), NOW, "en-US")).toBe("Dec 24, 2024, 09:00 AM");
  });

  it("returns an empty string for a bad timestamp", () => {
    expect(formatNotificationTime("nope", NOW, "en-US")).toBe("");
  });
});

describe("filters", () => {
  const missed = { id: "1", type: "missed_call" as const };
  const handled = { id: "2", type: "new_lead" as const };
  const billing = { id: "3", type: "billing" as const };
  const agent = { id: "4", type: "agent" as const };
  const system = { id: "5", type: "system" as const };
  const all = [missed, handled, billing, agent, system];

  it("All matches everything", () => {
    expect(all.every((n) => matchesFilter(n, "all"))).toBe(true);
    expect(filterNotifications(all, "all")).toEqual(all);
  });

  it("Calls covers missed and handled; the dropdown sub-filters narrow it", () => {
    expect(filterNotifications(all, "calls").map((n) => n.id)).toEqual(["1", "2"]);
    expect(filterNotifications(all, "missed").map((n) => n.id)).toEqual(["1"]);
    expect(filterNotifications(all, "handled").map((n) => n.id)).toEqual(["2"]);
  });

  it("System also covers AI-agent lifecycle notices", () => {
    expect(filterNotifications(all, "system").map((n) => n.id)).toEqual(["4", "5"]);
    expect(filterNotifications(all, "billing").map((n) => n.id)).toEqual(["3"]);
  });
});
