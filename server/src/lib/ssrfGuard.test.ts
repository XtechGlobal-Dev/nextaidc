import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  SSRF guard. DNS is stubbed so tests are deterministic and offline:
 *  a hostname resolves to whatever address the test sets.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: h.lookup }));

const { assertPublicHttpUrl, isPublicHttpUrl } = await import("./ssrfGuard.js");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: hostnames resolve to a public address unless a test overrides it.
  h.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("assertPublicHttpUrl — allows public http(s)", () => {
  it("accepts a normal public https URL", async () => {
    await expect(assertPublicHttpUrl("https://example.com/page")).resolves.toBeInstanceOf(URL);
  });

  it("accepts a public IP literal without a DNS lookup", async () => {
    await expect(assertPublicHttpUrl("http://93.184.216.34/")).resolves.toBeInstanceOf(URL);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});

describe("assertPublicHttpUrl — blocks SSRF targets", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("gopher://x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("ftp://x")).rejects.toThrow();
  });

  it("rejects the cloud metadata IP", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });

  it("rejects loopback and private IP literals", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://localhost/", // resolves via DNS mock below
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://[::1]/",
    ]) {
      if (u.includes("localhost")) h.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
      await expect(assertPublicHttpUrl(u), u).rejects.toThrow();
    }
  });

  it("rejects a hostname that RESOLVES to a private address (DNS rebinding / nip.io)", async () => {
    h.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(assertPublicHttpUrl("http://internal.attacker.com/")).rejects.toThrow();
  });

  it("rejects when ANY resolved address is private, even if one is public", async () => {
    h.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(assertPublicHttpUrl("http://mixed.example/")).rejects.toThrow();
  });

  it("rejects an IPv4-mapped IPv6 loopback", async () => {
    await expect(assertPublicHttpUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow();
  });

  it("rejects when DNS resolution fails", async () => {
    h.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicHttpUrl("http://does-not-exist.example/")).rejects.toThrow();
  });
});

describe("isPublicHttpUrl — boolean wrapper never throws", () => {
  it("returns true for public, false for blocked", async () => {
    expect(await isPublicHttpUrl("https://example.com")).toBe(true);
    expect(await isPublicHttpUrl("http://127.0.0.1")).toBe(false);
    expect(await isPublicHttpUrl("not a url")).toBe(false);
  });
});
