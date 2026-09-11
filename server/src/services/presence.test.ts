import { describe, it, expect, beforeEach } from "vitest";
import type { Response } from "express";
import { addClient, removeClient, onlineUserIds, liveClientCount } from "./events.js";

/* Presence is derived from open SSE streams, and admin tabs only re-fetch when
 * something is pushed to them. So a presence CHANGE has to publish, or the
 * online dot sits stale until an unrelated event happens to arrive. These pin
 * the "changed" part: first stream on, last stream off, and nothing in between. */

/** A fake SSE response that records what was written to it. */
function fakeRes(): Response & { events: { type: string; userId?: string; online?: boolean }[] } {
  const events: { type: string; userId?: string; online?: boolean }[] = [];
  return {
    events,
    write(payload: string) {
      const m = /^data: (.*)\n\n$/.exec(payload);
      if (m) events.push(JSON.parse(m[1]));
      return true;
    },
  } as unknown as Response & { events: { type: string; userId?: string; online?: boolean }[] };
}

const openAdmin = () => {
  const res = fakeRes();
  return { res, id: addClient(res, ["user:admin-1", "admin"]) };
};

/** Drain the events the admin saw from its own connection announcement. */
const drain = (admin: ReturnType<typeof openAdmin>) => {
  admin.res.events.length = 0;
};

describe("presence announcements to admins", () => {
  const opened: number[] = [];
  beforeEach(() => {
    while (opened.length) removeClient(opened.pop()!);
    expect(liveClientCount()).toBe(0);
  });
  const open = (channels: string[], impersonated = false) => {
    const res = fakeRes();
    const id = addClient(res, channels, { impersonated });
    opened.push(id);
    return { res, id };
  };

  it("announces when a user's first stream opens", () => {
    const admin = open(["user:admin-1", "admin"]);
    drain(admin as never);
    open(["user:u1"]);
    expect(admin.res.events).toEqual([{ type: "presence", userId: "u1", online: true }]);
    expect(onlineUserIds().has("u1")).toBe(true);
  });

  it("stays quiet when the same user opens a second tab", () => {
    const first = open(["user:u1"]);
    const admin = open(["user:admin-1", "admin"]);
    drain(admin as never);
    open(["user:u1"]); // second tab
    expect(admin.res.events).toEqual([]);
    // …and closing just one of the two is not going offline.
    removeClient(first.id);
    expect(admin.res.events).toEqual([]);
    expect(onlineUserIds().has("u1")).toBe(true);
  });

  it("announces offline only when the last stream closes", () => {
    const only = open(["user:u1"]);
    const admin = open(["user:admin-1", "admin"]);
    drain(admin as never);
    removeClient(only.id);
    expect(admin.res.events).toEqual([{ type: "presence", userId: "u1", online: false }]);
    expect(onlineUserIds().has("u1")).toBe(false);
  });

  it("ignores impersonated sessions, so viewing a panel can't fake presence", () => {
    const admin = open(["user:admin-1", "admin"]);
    drain(admin as never);
    open(["user:u1"], true);
    expect(admin.res.events).toEqual([]);
    expect(onlineUserIds().has("u1")).toBe(false);
  });

  it("is idempotent — repeat cleanup for one stream announces once", () => {
    const only = open(["user:u1"]);
    const admin = open(["user:admin-1", "admin"]);
    drain(admin as never);
    removeClient(only.id);
    removeClient(only.id); // disconnect paths can fire more than once
    expect(admin.res.events).toEqual([{ type: "presence", userId: "u1", online: false }]);
  });
});
