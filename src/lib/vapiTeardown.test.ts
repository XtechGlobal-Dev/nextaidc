import { describe, it, expect, vi, beforeEach } from "vitest";

/* Reported as: starting a test call several times in a row fails with
 * "Duplicate DailyIframe instances are not allowed", and the new call dies at
 * 0:00.
 *
 * Cause: the Vapi SDK's `stop()` is ASYNC — it awaits `daily.destroy()` before
 * releasing its call object — but every caller here fired it and moved on (a
 * hang-up, the minute cap, closing the dialog). Starting the next call inside
 * that window makes the SDK call `daily.createCallObject()` while the previous
 * object is still being destroyed, and Daily refuses.
 *
 * These pin the ORDERING, which is the whole fix: a start must never reach the
 * SDK until the pending teardown has settled. */

/**
 * A stand-in for the SDK that models the two ways its call object gets
 * corrupted, both of which real users hit:
 *
 *  - `start()` entered while a destroy is running → Daily's duplicate error.
 *  - `stop()` entered while a join is running → the join's later step finds the
 *    call object gone ("Cannot read properties of null"), AND the half-built
 *    object leaks, so every later start fails as a duplicate. That is what
 *    "End call during Connecting…, repeatedly" produced.
 */
class FakeVapi {
  destroying = false;
  connecting = false;
  leaked = false;
  events = new Map<string, (...a: unknown[]) => void>();
  startCalls = 0;
  duplicateErrors = 0;
  nullErrors = 0;

  on(event: string, fn: (...a: unknown[]) => void) {
    this.events.set(event, fn);
  }

  async stop(): Promise<void> {
    if (this.connecting) {
      // Tore the call object out from under an in-flight join.
      this.nullErrors++;
      this.leaked = true;
    }
    this.destroying = true;
    await new Promise((r) => setTimeout(r, 20)); // daily.destroy() takes a moment
    this.destroying = false;
  }

  async start(): Promise<{ id: string }> {
    this.startCalls++;
    if (this.destroying || this.leaked) {
      this.duplicateErrors++;
      throw new Error("Duplicate DailyIframe instances are not allowed");
    }
    this.connecting = true;
    try {
      await new Promise((r) => setTimeout(r, 20)); // the join takes a moment
      if (!this.connecting) {
        this.nullErrors++;
        throw new Error(
          "Cannot read properties of null (reading 'startRemoteParticipantsAudioLevelObserver')",
        );
      }
      return { id: `call_${this.startCalls}` };
    } finally {
      this.connecting = false;
    }
  }
}

// Must be constructible — the module does `new Vapi(key)`.
vi.mock("@vapi-ai/web", () => ({
  default: function MockVapi() {
    return fake;
  },
}));
vi.mock("./env", () => ({ env: { vapiPublicKey: "pk_test", apiUrl: "" } }));

let fake: FakeVapi;

beforeEach(() => {
  fake = new FakeVapi();
  vi.resetModules();
});

/** Import fresh so the module-level teardown chain starts empty each time. */
async function load() {
  return import("./vapi");
}

const PAYLOAD = { firstMessage: "hi" } as never;
const noopCb = { onState: () => {}, onTranscript: () => {} };

describe("test call teardown ordering", () => {
  it("does not start a new call while the previous one is still being destroyed", async () => {
    const { startTestCall } = await load();

    // Call once, hang up, and immediately start again — the exact sequence a
    // user produces by clicking "Call again" the moment a call ends.
    const first = startTestCall(PAYLOAD, noopCb);
    await vi.waitFor(() => expect(fake.startCalls).toBe(1));
    first.stop();
    startTestCall(PAYLOAD, noopCb);

    await vi.waitFor(() => expect(fake.startCalls).toBe(2), { timeout: 2000 });
    expect(fake.duplicateErrors).toBe(0);
  });

  it("survives several rapid start/stop cycles", async () => {
    const { startTestCall } = await load();

    for (let i = 0; i < 4; i++) {
      const h = startTestCall(PAYLOAD, noopCb);
      await vi.waitFor(() => expect(fake.startCalls).toBe(i + 1), { timeout: 2000 });
      h.stop();
    }

    expect(fake.duplicateErrors).toBe(0);
  });

  it("clears a call that ended on its own before starting the next", async () => {
    const { startTestCall } = await load();

    // No explicit stop() — the AI hung up, so the dialog just starts again.
    startTestCall(PAYLOAD, noopCb);
    await vi.waitFor(() => expect(fake.startCalls).toBe(1));
    startTestCall(PAYLOAD, noopCb);

    await vi.waitFor(() => expect(fake.startCalls).toBe(2), { timeout: 2000 });
    expect(fake.duplicateErrors).toBe(0);
  });

  /* The reported sequence: hit "Call again", then "End call" while it still says
   * Connecting…, over and over. Previously the stop nulled the call object
   * mid-join, which both threw and leaked — after which nothing would connect
   * on that page until a reload. */
  it("ending a call DURING connect neither throws nor leaks", async () => {
    const { startTestCall } = await load();

    const h = startTestCall(PAYLOAD, noopCb);
    h.stop(); // cancelled while still connecting

    await vi.waitFor(() => expect(fake.destroying).toBe(false), { timeout: 2000 });
    expect(fake.nullErrors).toBe(0);
    expect(fake.leaked).toBe(false);
  });

  it("still connects after several cancel-while-connecting cycles", async () => {
    const { startTestCall } = await load();

    for (let i = 0; i < 5; i++) {
      startTestCall(PAYLOAD, noopCb).stop();
    }

    // The page must not be wedged: a normal call still goes through.
    let connected: string | null = null;
    startTestCall(PAYLOAD, { ...noopCb, onCallId: (id: string) => (connected = id) });

    await vi.waitFor(() => expect(connected).not.toBeNull(), { timeout: 3000 });
    expect(fake.nullErrors).toBe(0);
    expect(fake.duplicateErrors).toBe(0);
  });

  it("a cancelled attempt never reports its call id", async () => {
    const { startTestCall } = await load();

    const ids: string[] = [];
    const h = startTestCall(PAYLOAD, { ...noopCb, onCallId: (id: string) => ids.push(id) });
    h.stop();

    await new Promise((r) => setTimeout(r, 200));
    // Saving a log against an abandoned attempt would record a phantom call.
    expect(ids).toEqual([]);
  });
});
