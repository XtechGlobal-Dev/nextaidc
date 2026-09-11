import { describe, it, expect } from "vitest";
import { clampPage, pageCount, pageWindow, rangeLabel } from "@/lib/pagination";

describe("pageCount", () => {
  it("rounds partial pages up", () => {
    expect(pageCount(57, 10)).toBe(6);
    expect(pageCount(60, 10)).toBe(6);
    expect(pageCount(61, 10)).toBe(7);
  });
  it("never drops below one page", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(-5, 10)).toBe(1);
  });
  it("survives a zero page size", () => {
    expect(pageCount(20, 0)).toBe(20);
  });
});

describe("clampPage", () => {
  it("keeps in-range pages untouched", () => {
    expect(clampPage(3, 57, 10)).toBe(3);
  });
  it("pulls an overshooting page back to the last one", () => {
    expect(clampPage(9, 57, 10)).toBe(6);
    // The list shrank to a single page (e.g. after deletes).
    expect(clampPage(9, 4, 10)).toBe(1);
  });
  it("floors garbage input at page 1", () => {
    expect(clampPage(0, 57, 10)).toBe(1);
    expect(clampPage(-3, 57, 10)).toBe(1);
    expect(clampPage(Number.NaN, 57, 10)).toBe(1);
  });
});

describe("rangeLabel", () => {
  it("describes the records on the current page", () => {
    expect(rangeLabel(1, 10, 57)).toBe("1–10 of 57");
    expect(rangeLabel(3, 10, 57)).toBe("21–30 of 57");
  });
  it("stops the upper bound at the total on the last page", () => {
    expect(rangeLabel(6, 10, 57)).toBe("51–57 of 57");
  });
  it("names the records when empty", () => {
    expect(rangeLabel(1, 10, 0, "calls")).toBe("0 calls");
  });
  it("clamps a stale page instead of running past the total", () => {
    expect(rangeLabel(9, 10, 57)).toBe("51–57 of 57");
  });
});

describe("pageWindow", () => {
  it("lists every page when they all fit", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("elides the tail near the start", () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, 3, 4, 5, "gap", 10]);
    expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, 5, "gap", 10]);
  });

  it("elides both sides in the middle", () => {
    expect(pageWindow(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageWindow(6, 10)).toEqual([1, "gap", 5, 6, 7, "gap", 10]);
  });

  it("elides the head near the end", () => {
    expect(pageWindow(10, 10)).toEqual([1, "gap", 6, 7, 8, 9, 10]);
    expect(pageWindow(8, 10)).toEqual([1, "gap", 6, 7, 8, 9, 10]);
  });

  it("always keeps the first and last page reachable", () => {
    for (let page = 1; page <= 40; page++) {
      const tokens = pageWindow(page, 40);
      expect(tokens[0]).toBe(1);
      expect(tokens[tokens.length - 1]).toBe(40);
      expect(tokens).toContain(page);
    }
  });

  it("never exceeds the requested width", () => {
    for (const max of [5, 6, 7, 9]) {
      for (const totalPages of [1, 4, 8, 25, 200]) {
        for (let page = 1; page <= totalPages; page++) {
          expect(pageWindow(page, totalPages, max).length).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("emits strictly ascending page numbers with no duplicates", () => {
    for (let page = 1; page <= 25; page++) {
      const nums = pageWindow(page, 25).filter((t): t is number => t !== "gap");
      expect(nums).toEqual([...nums].sort((a, b) => a - b));
      expect(new Set(nums).size).toBe(nums.length);
    }
  });

  it("clamps an out-of-range page and a degenerate total", () => {
    expect(pageWindow(99, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([1]);
  });
});
