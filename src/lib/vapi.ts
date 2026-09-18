import Vapi from "@vapi-ai/web";
import { env } from "@/lib/env";
import type { AgentConfig } from "@/types";
import { compileMasterPrompt, resolveGreeting } from "@/lib/compilePrompt";
import {
  deepgramVoiceFor,
  elevenLabsModelFor,
  elevenLabsVoiceFor,
  providerForVoiceId,
} from "@/data/voices";
import { languagesForVoiceProvider, transcriberFor, type TranscriberConfig } from "@/data/languages";

// Vapi voice client: a real browser call via @vapi-ai/web when VITE_VAPI_PUBLIC_KEY is set, otherwise a
// simulated lifecycle. The payload mirrors the server's so a test call matches the live agent.

export type VoiceProvider = "deepgram" | "elevenlabs";

export interface VapiAssistantPayload {
  name: string;
  firstMessage: string;
  /** Make the assistant greet immediately on connect (so the call isn't silent
   *  until the caller speaks). */
  firstMessageMode?: "assistant-speaks-first" | "assistant-waits-for-user";
  model: {
    provider: "anthropic";
    model: string;
    messages: { role: "system"; content: string }[];
    temperature: number;
    /** Live booking function tools (from /api/booking/tool-config). Omitted when
     *  booking isn't active so the test call matches a real inbound call. */
    tools?: unknown[];
  };
  voice:
    | { provider: "deepgram"; voiceId: string; model: "aura-2" }
    | { provider: "11labs"; voiceId: string; model: string; speed: number; stability: number };
  /** Always sent so the test call hears what a real inbound call would. Mirrors server/src/services/vapi.ts. */
  transcriber?: TranscriberConfig;
  endCallFunctionEnabled: boolean;
  /** Hang-up backstop: Vapi ends the call on these phrases even if the LLM forgets the endCall tool. */
  endCallPhrases: string[];
  /** Record the call so it can be replayed in the call detail. */
  recordingEnabled: boolean;
  artifactPlan: { recordingEnabled: boolean; recordingFormat: "wav;l16" | "mp3" };
  /** Hard cap (seconds) Vapi enforces so a call can't exceed remaining minutes. */
  maxDurationSeconds?: number;
  /** Barge-in: stop talking the moment the caller speaks and hand them the floor. */
  stopSpeakingPlan?: { numWords: number; voiceSeconds: number; backoffSeconds: number };
  /** Ambient sound under the call, so the browser test matches a real call. */
  backgroundSound?: "off" | "office";
}

/** Sign-offs that hard-end the call. Keep in step with server/src/services/vapi.ts; deliberately excludes
 *  anything in a normal greeting ("thanks for calling") so a call can never end at hello. */
export const END_CALL_PHRASES = [
  "goodbye",
  "have a good one",
  "bye for now",
  "bye now",
  "take care",
  "speak soon",
  "have a great day",
  "have a good day",
  "have a wonderful day",
  "have a lovely day",
  "have a nice day",
  "enjoy the rest of your day",
];

/** Teaches the LLM to actually invoke the endCall tool after signing off, instead
 *  of leaving the line open. Mirrors endCallPromptSection in the server. */
function endCallPromptSection(): string {
  return [
    "## ENDING THE CALL",
    'When the conversation is clearly over — the caller says goodbye, "no thanks", "that\'s all", or declines more help after you\'ve wrapped up — say EXACTLY this, word for word:',
    '"No worries at all — thanks for calling, have a great day!"',
    "Then IMMEDIATELY use the endCall tool to hang up. Say that whole sentence — never shorten it to a single word, never swap it for a shorter sign-off, and never add anything after it.",
    "Never leave the line open waiting for the caller to hang up first, and never ask another question after the caller has said goodbye.",
  ].join("\n");
}

/** Strip the stock "Don't hang up first" line: given both, the agent signs off and then waits. Mirrors the server. */
const DONT_HANG_UP_FIRST_RE = /\s*Don['’]t hang up first[^.]*\.\s*/gi;
function stripDontHangUpFirst(prompt: string): string {
  const stripped = prompt.replace(DONT_HANG_UP_FIRST_RE, " ");
  return stripped === prompt ? prompt : stripped.replace(/[ \t]+\n/g, "\n").trimEnd();
}

/** Build the inline assistant the web SDK starts a call with. `maxDurationSeconds`
 *  caps the call to the caller's remaining trial/plan minutes (omit for unlimited). */
export function buildAssistantPayload(
  config: AgentConfig,
  opts?: {
    maxDurationSeconds?: number;
    promptTemplate?: string;
    /** Live booking behaviour + tools for the test call (from api.booking.toolConfig). */
    booking?: { enabled: boolean; tools: unknown[]; promptSection: string };
  },
): VapiAssistantPayload {
  const basePrompt = config.advanced.masterPromptDirty
    ? config.advanced.masterPrompt
    : compileMasterPrompt(config, opts?.promptTemplate);
  // Graft the website-first booking instructions on when booking is live, mirroring
  // the server assistant so the test call behaves like a real inbound call.
  const withBooking =
    opts?.booking?.enabled && opts.booking.promptSection
      ? `${basePrompt.trimEnd()}\n\n${opts.booking.promptSection}`
      : basePrompt;
  // Only instruct the endCall tool when it exists (allowHangUp); without the
  // instruction the test call sat on the line after signing off.
  const systemPrompt = config.advanced.allowHangUp
    ? `${stripDontHangUpFirst(withBooking).trimEnd()}\n\n${endCallPromptSection()}`
    : withBooking;
  const bookingTools = opts?.booking?.enabled ? opts.booking.tools : [];
  const cap = opts?.maxDurationSeconds;
  // The voice id decides the provider, so the test call uses the same engine as real
  // inbound calls with no toggle. Aura-2 speaks English only; multilingual forces ElevenLabs.
  const provider = providerForVoiceId(config.identity.voiceId, "elevenlabs");
  // Provider-aware, mirroring the server's save-time strip: the ElevenLabs-only
  // languages are dropped on a Deepgram voice, which can't speak them.
  const offered = languagesForVoiceProvider(provider);
  const languages = (config.identity.languages ?? []).filter((l) => offered.includes(l));
  const voice: VapiAssistantPayload["voice"] =
    provider === "elevenlabs" || languages.length
      ? {
          provider: "11labs",
          voiceId: elevenLabsVoiceFor(config.identity.voiceId),
          // Turbo v2.5 for everything, except the one pairing it can't carry:
          // the curated Punjabi voice with Punjabi enabled → Eleven v3.
          model: elevenLabsModelFor(config.identity.voiceId, languages),
          speed: config.advanced.voiceSpeed,
          stability: config.advanced.voiceStability,
        }
      : { provider: "deepgram", voiceId: deepgramVoiceFor(config.identity.voiceId), model: "aura-2" };
  // An empty greeting left the assistant silent on connect; always fall back to a real one.
  const businessName = config.identity.businessName?.trim();
  // Same derivation as the live agent, not a bare read: a stored auto-greeting can
  // carry a previous business name, and the test call used to greet with the OLD one.
  const greeting = resolveGreeting(config.identity.greetingMessage, businessName);
  return {
    transcriber: transcriberFor(languages),
    name: config.identity.assistantName || "Receptionist",
    firstMessage: greeting,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "system", content: systemPrompt }],
      temperature: config.advanced.creativity,
      ...(bookingTools.length ? { tools: bookingTools } : {}),
    },
    voice,
    endCallFunctionEnabled: config.advanced.allowHangUp,
    endCallPhrases: config.advanced.allowHangUp ? END_CALL_PHRASES : [],
    recordingEnabled: true,
    // Same MP3 recording format as a live agent (server/src/services/vapi.ts),
    // so a browser test call produces the same kind of file a real call does.
    artifactPlan: { recordingEnabled: true, recordingFormat: "mp3" },
    // Barge-in: stop talking the instant the caller speaks and let them take over.
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    // Match the live agent; "default" is omitted (a web call is silent by default).
    ...(config.advanced.backgroundSound === "off" || config.advanced.backgroundSound === "office"
      ? { backgroundSound: config.advanced.backgroundSound }
      : {}),
    ...(typeof cap === "number" && Number.isFinite(cap) && cap > 0
      ? { maxDurationSeconds: Math.floor(cap) }
      : {}),
  };
}

export type VapiCallState = "idle" | "connecting" | "active" | "ended";

export interface CallReport {
  summary?: string;
  recordingUrl?: string;
}

export interface TestCallCallbacks {
  onState: (state: VapiCallState) => void;
  onTranscript?: (role: "agent" | "caller", text: string) => void;
  /** Fires when Vapi delivers its end-of-call report (real summary + recording). */
  onReport?: (report: CallReport) => void;
  /** Fires with the Vapi call id once the call starts (used to fetch the recording). */
  onCallId?: (callId: string) => void;
  onError?: (message: string) => void;
}

export interface VapiCallHandle {
  stop: () => void;
  /** Cue the assistant to wrap up ~30s before the minutes cap cuts it off mid-sentence. Best-effort; no-op when simulated. */
  wrapUp: () => void;
}

export const isVapiConfigured = Boolean(env.vapiPublicKey);

// Daily.co allows ONE call object per page, so a fresh `new Vapi()` per call makes the second call die with
// "Duplicate instance". One shared instance; listeners attached once and delegating to `activeCb` (per-call listeners doubled transcripts).
let sharedVapi: Vapi | null = null;
let sharedVapiKey: string | null = null;
let activeCb: TestCallCallbacks | null = null;
let callConnected = false;

// Every start/stop runs through ONE queue: both mutate the same Daily call object, and overlapping them either dies
// with "Duplicate DailyIframe instances" or nulls it under a running join, leaking an object that wedges every later call until reload.
let queue: Promise<unknown> = Promise.resolve();

/** Run `op` after everything already queued, whatever the outcome of those. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  // The queue itself must never reject, or every later operation is skipped.
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Rising id for each call attempt, so a superseded one can't report state or a
 *  call id for the attempt that replaced it. */
let callSeq = 0;
// A start failure can surface via BOTH the "error" event and the start() promise
// rejection — dedupe so the user gets one clear toast, not two. Reset per call.
let errorReported = false;

/** A message field is a string or, on Vapi validation 400s, an ARRAY of them; dropping the array case is
 *  what reduced every rejected config to a useless "Couldn't start the call". */
function messageText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .join("; ")
      .trim();
  }
  return "";
}

/** Human message from whatever Vapi throws: Error, string, or a plain 400 body like `{ error, message }` / `{ error: { message } }`. */
function errText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const nested = o.error as Record<string, unknown> | string | undefined;
    const candidates = [
      o.message,
      o.errorMsg,
      o.msg,
      typeof nested === "string" ? nested : nested?.message,
      (o.response as Record<string, unknown> | undefined)?.message,
    ];
    for (const c of candidates) {
      const text = messageText(c);
      if (text) return text;
    }
  }
  return "";
}

/** Actionable wording for a call-start error; the common one is Vapi out of credits, which blocks every call account-wide. */
function friendlyStartError(raw: string): string {
  const low = raw.toLowerCase();
  if (/wallet balance|purchase more credits|out of credits|insufficient|upgrade your plan/.test(low)) {
    return "Calls are temporarily unavailable — the voice service account is out of credits. Please top up or upgrade the voice provider (Vapi) account, then try again.";
  }
  // A bare "vapi" string or empty payload isn't useful to a caller — keep it generic.
  if (!raw || /^vapi/i.test(raw)) return "Couldn't start the call. Please try again.";
  return raw;
}

/** The payload of the call being started, kept only so a failure can be diagnosed
 *  (Vapi's 400s are about specific fields — transcriber, voice, model). */
let lastPayload: VapiAssistantPayload | null = null;

/** Report a call-start failure once (guarding the connected/duplicate cases). */
function reportStartError(e: unknown): void {
  if (callConnected || errorReported) return;
  const raw = errText(e);
  // Benign SDK "errors" on a normal hang-up — not real failures, let call-end handle it.
  if (/ended|ejection|meeting/i.test(raw)) return;
  errorReported = true;
  // Log the payload too: Vapi's 400 names the bad field but the SDK doesn't always
  // surface it, and a config rejection otherwise looks like a network blip.
  console.error("[vapi] call start failed", { error: e, raw, payload: lastPayload });
  activeCb?.onState("ended");
  activeCb?.onError?.(friendlyStartError(raw));
}

/** The slice of Daily's call object the mic recovery needs. The SDK types `call` as private, so it is
 *  reached through a cast; a missing method just means the recovery is skipped. */
interface DailyCallLike {
  on: (event: string, handler: (e: { type?: string } | undefined) => void) => unknown;
  updateInputSettings: (settings: unknown) => Promise<unknown>;
  setLocalAudio: (enabled: boolean) => unknown;
}

/** Daily call objects already carrying the recovery listener (one per start(); the SDK creates a new one each call). */
const micRecoveryArmed = new WeakSet<object>();

/** How long to wait for the SDK to create its Daily call object after start() is invoked. */
const MIC_RECOVERY_ARM_TIMEOUT_MS = 20_000;

/** Keep the microphone alive when Daily's Krisp noise filter fails to initialise.
 *
 *  The SDK switches the filter on right after joining. On some machines that fails (a 192 kHz default
 *  audio device gives `KrispInitError: NOT_SUPPORTED_SAMPLE_RATE`); Daily then stops the mic track and
 *  reports a `nonfatal-error` of type "input-settings-error". The SDK (2.5.2 and 2.7.0 alike) only
 *  recovers from "audio-processor-error", so the caller's mic stays OFF: the assistant greets, never
 *  hears a word, Vapi never sends "listening" (the dialog sits on "Connecting…"), and the call ends
 *  30 s later with silence-timed-out. Attach our own listener as soon as the call object exists —
 *  polling, because the SDK creates it inside start() and the failure lands milliseconds after join. */
function armMicRecovery(vapi: Vapi): void {
  const startedAt = Date.now();
  // Global timers, not window.*: the wrapper is also exercised under Node in unit tests.
  const timer = setInterval(() => {
    const call = (vapi as unknown as { call?: DailyCallLike | null }).call;
    if (!call) {
      if (Date.now() - startedAt > MIC_RECOVERY_ARM_TIMEOUT_MS) clearInterval(timer);
      return;
    }
    clearInterval(timer);
    if (micRecoveryArmed.has(call) || typeof call.on !== "function") return;
    micRecoveryArmed.add(call);
    call.on("nonfatal-error", (e) => {
      if (e?.type !== "input-settings-error" && e?.type !== "audio-processor-error") return;
      console.warn("[vapi] mic noise filter failed — turning it off and re-enabling the microphone", e);
      Promise.resolve(call.updateInputSettings({ audio: { processor: { type: "none" } } }))
        .then(() => call.setLocalAudio(true))
        .catch((err) => console.error("[vapi] microphone recovery failed", err));
    });
  }, 25);
}

function getVapi(key: string): Vapi {
  if (sharedVapi && sharedVapiKey === key) return sharedVapi;
  if (sharedVapi) {
    // Queued so the old Daily object is fully gone before the next start() creates one.
    const old = sharedVapi;
    void enqueue(() => old.stop());
  }
  const vapi = new Vapi(key);
  sharedVapi = vapi;
  sharedVapiKey = key;

  // Attach listeners ONCE. They read the latest `activeCb`, so each call swaps the
  // callbacks rather than registering another listener (which caused double text).
  vapi.on("call-start", () => {
    callConnected = true;
    activeCb?.onState("active");
  });
  vapi.on("call-end", () => activeCb?.onState("ended"));
  vapi.on("error", (e: unknown) => {
    // Ignored once live (the SDK fires benign ones; the real end is "call-end").
    // Before connect, surface the reason instead of a silent 0:00.
    reportStartError(e);
  });
  vapi.on(
    "message",
    (msg: {
      type?: string;
      role?: string;
      transcriptType?: string;
      transcript?: string;
      summary?: string;
      recordingUrl?: string;
      analysis?: { summary?: string };
      artifact?: { recordingUrl?: string };
    }) => {
      if (msg.type === "transcript" && msg.transcriptType === "final" && msg.transcript) {
        activeCb?.onTranscript?.(msg.role === "assistant" ? "agent" : "caller", msg.transcript);
      } else if (msg.type === "end-of-call-report") {
        activeCb?.onReport?.({
          summary: msg.summary ?? msg.analysis?.summary,
          recordingUrl: msg.recordingUrl ?? msg.artifact?.recordingUrl,
        });
      }
    },
  );

  return vapi;
}

/** Start a real Vapi web call (or simulate one if no public key). */
export function startTestCall(
  payload: VapiAssistantPayload,
  cb: TestCallCallbacks,
  publicKey?: string,
): VapiCallHandle {
  const key = (publicKey ?? "").trim() || env.vapiPublicKey;
  if (!key) {
    // ---- Simulated fallback ----
    cb.onState("connecting");
    const greeting = payload.firstMessage;
    const t1 = window.setTimeout(() => {
      cb.onState("active");
      cb.onTranscript?.("agent", greeting);
    }, 900);
    const t2 = window.setTimeout(() => {
      cb.onTranscript?.("caller", "Hi, I'd like to book a quote please.");
    }, 2600);
    const t3 = window.setTimeout(() => {
      cb.onTranscript?.("agent", "Of course — can I grab your first name and suburb?");
    }, 4200);
    return {
      stop: () => {
        [t1, t2, t3].forEach((t) => window.clearTimeout(t));
        cb.onState("ended");
      },
      wrapUp: () => {},
    };
  }

  // ---- Real web call ---- (reuse the single page-wide instance; swap callbacks)
  const vapi = getVapi(key);
  activeCb = cb;
  callConnected = false;
  errorReported = false;
  lastPayload = payload;

  const mySeq = ++callSeq;
  /** False once a newer attempt (or this one's own stop) has superseded us. */
  const isCurrent = () => mySeq === callSeq;

  cb.onState("connecting");
  // Queued so it never overlaps a teardown. The extra stop clears a call that ended by
  // itself. start() resolves with the call id (for the recording) and rejects with the real reason.
  void enqueue(async () => {
    await vapi.stop().catch(() => {
      /* nothing left to clean up */
    });
    // Cancelled while queued (the user hit End call during "Connecting…") —
    // don't open a call nobody is waiting for.
    if (!isCurrent()) return null;
    armMicRecovery(vapi);
    return vapi.start(payload as unknown as Parameters<typeof vapi.start>[0]);
  })
    .then((call) => {
      const id = (call as { id?: string } | null)?.id;
      // A superseded attempt must not hand its id to the dialog — that would
      // save a call log against the attempt the user already abandoned.
      if (id && isCurrent()) cb.onCallId?.(id);
    })
    .catch((err) => {
      if (isCurrent()) reportStartError(err);
    });

  return {
    stop: () => {
      // Supersede first: if the start is still queued it will now no-op, and if
      // it is mid-flight its result is ignored.
      callSeq++;
      // Queued rather than fired and forgotten, so the stop waits for any
      // in-flight connect instead of nulling the call object underneath it.
      void enqueue(() => vapi.stop());
      cb.onState("ended");
    },
    wrapUp: () => {
      // Cast defensively: send() exists but its message union varies across SDK versions,
      // and a miss must never break the call.
      try {
        (vapi as unknown as { send?: (msg: unknown) => void }).send?.({
          type: "add-message",
          message: {
            role: "system",
            content:
              "The call reaches its time limit in about 30 seconds. Politely wrap up now: " +
              "briefly confirm anything you've collected, thank the caller, and say goodbye. " +
              "Do not start new questions or topics.",
          },
        });
      } catch {
        /* best-effort — the client-side cap still ends the call */
      }
    },
  };
}
