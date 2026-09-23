import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Phone, PhoneOff, Loader2, Radio, AlertCircle, CreditCard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUiStore } from "@/stores/useUiStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { blockedCopy } from "@/lib/trial";
import {
  buildAssistantPayload,
  startTestCall,
  type CallReport,
  type VapiAssistantPayload,
  type VapiCallHandle,
  type VapiCallState,
} from "@/lib/vapi";
import { api, ApiError, type CallerIdSource, type TestCallPreflight } from "@/lib/api";
import { env } from "@/lib/env";
import { cn, formatDuration } from "@/lib/utils";
import { preCallCap, tightest } from "@/lib/callCap";
import { toast } from "sonner";

interface Line {
  role: "agent" | "caller";
  text: string;
  /** Seconds into the call, stamped on arrival; index-based times used to drift past the call's real duration. */
  at: number;
}

export function AssistantTesterDialog() {
  const open = useUiStore((s) => s.assistantTesterOpen);
  const setOpen = useUiStore((s) => s.setAssistantTester);
  const config = useAgentStore((s) => s.config);
  const promptTemplate = useAgentStore((s) => s.promptTemplate);
  /** Unsaved AI-Brain edits. The ONLY reason to send the draft with the call — the
   *  saved assistant already runs the saved config, and rebuilding it re-summarises
   *  the prompt through an LLM while the caller waits. */
  const configDirty = useAgentStore((s) => s.dirty);
  const trial = useTrialStore((s) => s.trial);
  const subscriptionStatus = useAuthStore((s) => s.user?.profile?.subscriptionStatus);
  const savedMobile = useAuthStore((s) => s.user?.profile?.mobile ?? "");
  const navigate = useNavigate();

  /** How the test call is placed. A real phone call is the default: a browser call
   *  spends several seconds negotiating WebRTC before the agent speaks, and on some
   *  machines the mic never opens at all. The browser path stays as a fallback for
   *  anyone without a phone to hand, or before an outbound number is configured. */
  const [mode, setMode] = useState<"phone" | "web">("phone");
  const [toNumber, setToNumber] = useState("");
  const [placing, setPlacing] = useState(false);
  /** Vapi id of the phone call in flight — also what stops the status poll. */
  const phoneCallIdRef = useRef<string | null>(null);
  const [phoneFrom, setPhoneFrom] = useState<{ number: string; source: CallerIdSource } | null>(null);
  /** Vapi's own lifecycle word (queued/ringing/in-progress/ended) — finer than
   *  our three states, so the caller can tell "ringing" from "answered". */
  const [phoneStage, setPhoneStage] = useState("");
  const [phoneEndedReason, setPhoneEndedReason] = useState("");
  /** Settled while the caller is still typing their number, so pressing the button
   *  is just the dial. Null until the warm-up answers. */
  const [preflight, setPreflight] = useState<TestCallPreflight | null>(null);

  // Test calls run off the current AI Brain config, so no live assistant/number needed; only trial minutes gate them.

  const [state, setState] = useState<VapiCallState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [vapiKey, setVapiKey] = useState("");
  const handleRef = useRef<VapiCallHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef(false);
  const reportRef = useRef<CallReport | null>(null);
  const vapiCallIdRef = useRef<string | null>(null);
  /** Per-call duration cap (seconds) snapshotted when the call starts; null = uncapped. */
  const capSecondsRef = useRef<number | null>(null);
  /** Same value as state, because a ref change doesn't re-render and the label went stale during "connecting". */
  const [capSeconds, setCapSeconds] = useState<number | null>(null);
  const applyCap = (v: number | null) => {
    capSecondsRef.current = v;
    setCapSeconds(v);
  };
  /** Platform per-call ceiling from the server payload. Only the server knows it (an admin can cap calls at
   *  2 min on an account with 200 plan minutes), so until it lands we don't know what will cut the call. */
  const [serverCapSeconds, setServerCapSeconds] = useState<number | null>(null);
  /** Whether the 30s-left warning has fired for the current call. */
  const warnedRef = useRef(false);
  /** Server payload warmed on open: /test-token runs an LLM summarizer that takes seconds, and awaiting it on click looked dead. */
  const payloadRef = useRef<Promise<VapiAssistantPayload | null> | null>(null);
  // Refs so the end-of-call save reads final values without depending on them; keying the effect on
  // `lines`/`elapsed` let a late transcript line cancel the pending save, and calls silently went unrecorded.
  const linesRef = useRef<Line[]>([]);
  const elapsedRef = useRef(0);

  /** Recording URL: from the live report if present, else fetched from Vapi by
   * call id (web recordings finish processing a few seconds after the call). */
  async function resolveRecordingUrl(): Promise<string | undefined> {
    if (reportRef.current?.recordingUrl) return reportRef.current.recordingUrl;
    const callId = vapiCallIdRef.current;
    if (!callId) return undefined;
    for (let i = 0; i < 4; i++) {
      try {
        const { recordingUrl } = await api.agent.callRecording(callId);
        if (recordingUrl) return recordingUrl;
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return undefined;
  }

  // Fetch the runtime Vapi browser key (set in Admin → Settings) when opened. The
  // voice provider is derived from the agent's own voiceId in buildAssistantPayload.
  useEffect(() => {
    if (!open) return;
    api
      .config()
      .then((c) => setVapiKey(c.vapiPublicKey || ""))
      .catch(() => {});
    // Browser path only: /test-token builds the whole inline assistant, which a phone
    // call never uses (the server builds its own from the draft when the call is placed).
    if (mode !== "web") return;
    // Warm the payload. Keyed on `open`/`mode` only: re-requesting per keystroke would fire an LLM summarization per edit.
    setServerCapSeconds(null);
    payloadRef.current = api.agent
      .testToken(config)
      .then((r) => {
        const p = r.assistant as unknown as VapiAssistantPayload;
        setServerCapSeconds(p?.maxDurationSeconds ?? null);
        return p;
      })
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Warm the call path the moment the dialog opens: resolve the caller ID, prime
  // the phone-number lookup and, for a dirty draft, pre-compress the prompt. All of
  // it used to happen after the click, which is why connecting felt so slow.
  useEffect(() => {
    if (!open || mode !== "phone") return;
    let active = true;
    setPreflight(null);
    api.agent
      .testCallPreflight(configDirty ? config : undefined)
      .then((p) => active && setPreflight(p))
      .catch(() => active && setPreflight(null));
    return () => {
      active = false;
    };
    // Keyed on open/mode only: re-warming per keystroke would fire a summarization per edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Prefill the number to ring from the account's own mobile, so the common case is one click.
  useEffect(() => {
    if (!open) return;
    setToNumber((n) => n || savedMobile);
    // Keyed on `open` only — a profile edit mid-call must not rewrite what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset on reopen after a finished call. close() leaves transcript/timer intact so the save effect
  // can persist them, so the clearing has to happen here. Never touches a live call.
  useEffect(() => {
    if (open && state === "ended") {
      setState("idle");
      setElapsed(0);
      setLines([]);
      savedRef.current = false;
    }
    // Keyed on `open` only — this is a per-open reset, not a state watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const hasVapiKey = Boolean(vapiKey || env.vapiPublicKey);

  useEffect(() => {
    if (state === "active") {
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [state]);

  // Client-side cap in case Vapi's maxDurationSeconds cutoff lags; 30s before, warn and cue the assistant to wrap up.
  // Browser calls only: a phone call runs entirely on Vapi, which enforces the same cap and hangs up itself —
  // cutting it here would only stop the timer, leaving the caller on a line the page no longer tracks.
  useEffect(() => {
    const cap = capSecondsRef.current;
    if (mode !== "web" || state !== "active" || cap == null) return;
    if (!warnedRef.current && cap > 60 && elapsed >= cap - 30) {
      warnedRef.current = true;
      toast.info("About 30 seconds of call time left — the assistant will wrap up.");
      handleRef.current?.wrapUp();
    }
    if (elapsed >= cap) {
      handleRef.current?.stop();
      setState("ended");
      toast.warning("You've reached your available call minutes — the call was ended.");
    }
  }, [elapsed, state, mode]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  // Save immediately with keepalive (a refresh during the old 2.5s summarize-then-create window lost the
  // call and its billed minutes), then enrich summary/recording after. Keyed on `state` only; see refs above.
  useEffect(() => {
    if (mode !== "web" || state !== "ended" || savedRef.current) return;
    // Snapshot now (begin()/close() reset the refs). Any transcript bills at least 1s, rounded up to a minute server-side.
    const finalLines = linesRef.current;
    const finalElapsed = Math.max(elapsedRef.current, finalLines.length > 0 ? 1 : 0);
    if (finalElapsed <= 0) return;
    savedRef.current = true;
    const assistantName = config.identity.assistantName || "your assistant";
    const firstCaller = finalLines.find((l) => l.role === "caller");
    const transcript = finalLines.map((l) => ({ role: l.role, text: l.text, at: l.at }));
    const report = reportRef.current;
    // Something readable for the immediate save; the AI summary replaces it below.
    const fallbackSummary =
      report?.summary?.trim() || firstCaller?.text?.slice(0, 140) || `Test call with ${assistantName}`;

    void (async () => {
      try {
        // 1) Save immediately + keepalive — this is what records the call and
        //    deducts the minutes, and it survives a page refresh.
        const created = await api.calls.create(
          {
            type: "Web",
            callerName: "Browser Test",
            durationSec: finalElapsed,
            outcome: "completed",
            summary: fallbackSummary,
            ...(report?.recordingUrl ? { recordingUrl: report.recordingUrl } : {}),
            transcript,
            analysis: {
              summary: fallbackSummary,
              intent: "Test call",
              sentiment: "Positive",
              actionItems: firstCaller ? ["Review test conversation"] : [],
              ...(vapiCallIdRef.current ? { vapiCallId: vapiCallIdRef.current } : {}),
            },
          },
          { keepalive: true },
        );
        void useCallsStore.getState().hydrate();
        void useTrialStore.getState().hydrate();
        toast.success("Call saved to your inbox");

        // 2) Best-effort enrichment (skipped harmlessly if the user navigated
        //    away): the AI summary, and the recording once Vapi finishes it.
        if (created?.id) {
          const aiSummary = await api.calls
            .summarize(transcript)
            .then((r) => r.summary?.trim() || "")
            .catch(() => "");
          const bestSummary = reportRef.current?.summary?.trim() || aiSummary;
          const recordingUrl = report?.recordingUrl ? undefined : await resolveRecordingUrl();
          const patch: { summary?: string; recordingUrl?: string } = {};
          if (bestSummary && bestSummary !== fallbackSummary) patch.summary = bestSummary;
          if (recordingUrl) patch.recordingUrl = recordingUrl;
          if (Object.keys(patch).length) {
            await api.calls.update(created.id, patch).catch(() => {});
            void useCallsStore.getState().hydrate();
          }
        }
      } catch {
        toast.error("Couldn't save the call");
      }
    })();
  }, [state, mode, config.identity.assistantName]);

  // Mid-call reload/tab close never reaches "ended", so persist what we have as a `missed` call via
  // keepalive so the minutes are still billed. `savedRef` stops it duplicating the normal save.
  // Browser calls only — a phone call survives the page and is logged from the webhook.
  useEffect(() => {
    if (mode !== "web") return;
    if (state !== "active" && state !== "connecting") return;
    const savePartial = () => {
      if (savedRef.current) return;
      const finalLines = linesRef.current;
      const finalElapsed = Math.max(elapsedRef.current, finalLines.length > 0 ? 1 : 0);
      if (finalElapsed <= 0) return; // nothing spoken yet — nothing to bill/save
      savedRef.current = true;
      const assistantName = config.identity.assistantName || "your assistant";
      const firstCaller = finalLines.find((l) => l.role === "caller");
      const transcript = finalLines.map((l) => ({ role: l.role, text: l.text, at: l.at }));
      void api.calls.create(
        {
          type: "Web",
          callerName: "Browser Test",
          durationSec: finalElapsed,
          outcome: "missed", // reloaded mid-call — the call didn't complete
          summary: firstCaller?.text?.slice(0, 140) || `Test call with ${assistantName}`,
          transcript,
          analysis: {
            summary: `Browser test call with ${assistantName} (ended early — page reloaded).`,
            intent: "Test call",
            sentiment: "Neutral",
            actionItems: [],
            ...(vapiCallIdRef.current ? { vapiCallId: vapiCallIdRef.current } : {}),
          },
        },
        { keepalive: true },
      );
    };
    window.addEventListener("pagehide", savePartial);
    window.addEventListener("beforeunload", savePartial);
    return () => {
      window.removeEventListener("pagehide", savePartial);
      window.removeEventListener("beforeunload", savePartial);
    };
  }, [state, mode, config.identity.assistantName]);

  /** Place the call to a real handset. The server picks the number it dials FROM
   *  (the account's own if it holds one, else its brand's, else the platform's)
   *  and always runs THIS account's agent, so the knowledge the caller hears is
   *  theirs whichever line it arrives on. */
  async function beginPhone() {
    if (trialBlocked) {
      toast.error(blocked?.reason ?? "Your free trial has ended.");
      return;
    }
    const dial = toNumber.trim();
    if (!dial) {
      toast.error("Enter the phone number you want us to ring.");
      return;
    }
    setPlacing(true);
    setElapsed(0);
    setLines([]);
    setPhoneEndedReason("");
    // Show the line it goes out on immediately — preflight already resolved it, so
    // there is no reason to wait for the call to be accepted to say it.
    if (preflight?.ready && preflight.from && preflight.fromSource)
      setPhoneFrom({ number: preflight.from, source: preflight.fromSource });
    setPhoneStage("queued");
    savedRef.current = false;
    phoneCallIdRef.current = null;
    warnedRef.current = false;
    applyCap(plannedCapSeconds);
    // Only after the request is accepted, so a rejected number doesn't leave the
    // dialog stuck on "Connecting…" with no call behind it.
    try {
      // Saved config → no draft → the server dials the live assistant as-is.
      const started = await api.agent.testCall(dial, configDirty ? config : undefined);
      phoneCallIdRef.current = started.callId;
      setPhoneFrom({ number: started.from, source: started.fromSource });
      applyCap(tightest(started.maxDurationSeconds, callCapSeconds));
      setPhoneStage(started.status || "queued");
      setState("connecting");
    } catch (e) {
      setState("idle");
      toast.error(e instanceof ApiError ? e.message : "Couldn't place the call. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  // Poll the call Vapi is running. It is the only view the browser has of a phone
  // call — nothing about it happens on this page, so without the poll the dialog
  // could not tell ringing from answered, or say why the call ended.
  useEffect(() => {
    if (mode !== "phone") return;
    if (state !== "connecting" && state !== "active") return;
    let cancelled = false;
    const tick = async () => {
      const id = phoneCallIdRef.current;
      if (!id) return;
      try {
        const s = await api.agent.testCallStatus(id);
        if (cancelled) return;
        setPhoneStage(s.status);
        if (s.status === "in-progress" || s.status === "forwarding") {
          setState("active");
          // Vapi's own clock wins: the local 1s timer starts when the poll first
          // sees the call answered, which is a beat or two after it really was.
          if (s.durationSec > 0) setElapsed(s.durationSec);
        } else if (s.status === "ended") {
          setPhoneEndedReason(s.endedReason);
          if (s.durationSec > 0) setElapsed(s.durationSec);
          setState("ended");
        }
      } catch {
        /* a dropped poll is not a dropped call — try again on the next tick */
      }
    };
    void tick();
    // Ramped, not a flat 2s: the queued→ringing flip happens within a second of the
    // POST, and a fixed 2s poll made a call that was already ringing still read
    // "Placing the call…". Fast while that is in play, then relaxed for the rest of
    // the call, where a 2s-stale timer costs nothing.
    const startedAt = Date.now();
    let timer = 0;
    const schedule = () => {
      const elapsedMs = Date.now() - startedAt;
      const every = elapsedMs < 8_000 ? 400 : elapsedMs < 20_000 ? 1_000 : 2_500;
      timer = window.setTimeout(async () => {
        await tick();
        if (!cancelled) schedule();
      }, every);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, state]);

  // The call was logged, billed and summarised by the webhook while it ran; pull
  // the fresh numbers in once it ends so the inbox and the minutes agree.
  useEffect(() => {
    if (mode !== "phone" || state !== "ended" || !phoneCallIdRef.current) return;
    const id = phoneCallIdRef.current;
    phoneCallIdRef.current = null;
    // The end-of-call report lands a moment after the call drops.
    const timer = window.setTimeout(() => {
      void useCallsStore.getState().hydrate();
      void useTrialStore.getState().hydrate();
    }, 4000);
    void id;
    return () => window.clearTimeout(timer);
  }, [mode, state]);

  /** Hang up a phone call from here. The caller can also just put their handset
   *  down — the poll sees that too. */
  async function endPhone() {
    const id = phoneCallIdRef.current;
    setState("ended");
    if (id) await api.agent.testCallEnd(id).catch(() => {});
  }

  async function begin() {
    if (trialBlocked) {
      toast.error(blocked?.reason ?? "Your free trial has ended.");
      return;
    }
    // Flip to "connecting" before any await, or the button looks dead and people double-press and stack calls.
    setState("connecting");
    setElapsed(0);
    setLines([]);
    savedRef.current = false;
    reportRef.current = null;
    vapiCallIdRef.current = null;
    warnedRef.current = false;
    // Provisional cap so an early failure can't leave the call uncapped. Already lowered to the platform
    // ceiling if known; showing the bare allowance advertised 380:00 on an account capped at 2:00.
    applyCap(plannedCapSeconds);
    // Server-built payload: only the server produces the prompt a real call runs on (summarized wire
    // scaffold + regional block + live tools). The local fallback below won't match a real call.
    let payload: VapiAssistantPayload | undefined =
      (await payloadRef.current) ?? undefined;
    try {
      if (!payload) {
        const res = await api.agent.testToken(config);
        payload = res.assistant as unknown as VapiAssistantPayload;
      }
    } catch {
      // Server unreachable — fall back to a local compile so the button still works.
      const booking = await api.booking
        .toolConfig()
        .then((c) => ({ enabled: c.enabled, tools: c.tools, promptSection: c.promptSection }))
        .catch(() => undefined);
      payload = buildAssistantPayload(config, {
        promptTemplate,
        ...(booking ? { booking } : {}),
      });
    }
    // Only ever tighten the server's cap (the local fallback compiles without one); never hand the call a longer limit.
    const serverCap = payload?.maxDurationSeconds ?? null;
    setServerCapSeconds(serverCap);
    const effectiveCap = tightest(serverCap, callCapSeconds);
    if (effectiveCap != null) payload = { ...payload, maxDurationSeconds: effectiveCap };
    // The countdown must show what will actually cut the call, not just the
    // minutes left — with a platform ceiling those are different numbers.
    applyCap(effectiveCap);
    handleRef.current = startTestCall(
      payload,
      {
        onState: setState,
        // Stamp the line with the live call clock as it lands, so the saved
        // transcript's times are the ones the caller actually heard.
        onTranscript: (role, text) => setLines((ls) => [...ls, { role, text, at: elapsedRef.current }]),
        onReport: (r) => {
          reportRef.current = r;
        },
        onCallId: (id) => {
          vapiCallIdRef.current = id;
        },
        onError: (msg) => toast.error(msg),
      },
      vapiKey,
    );
  }

  function end() {
    if (mode === "phone") {
      void endPhone();
      return;
    }
    handleRef.current?.stop();
    setState("ended");
  }

  function close(next: boolean) {
    if (!next && (state === "active" || state === "connecting")) {
      if (mode === "phone") {
        // A phone call is NOT hung up by closing the dialog — the caller is holding a
        // live handset. Stop watching it; the webhook still logs and bills it, and the
        // end-effect below still refreshes the inbox.
        setState("ended");
      } else {
        // Closing mid-call must reach "ended" or the save effect never runs (no log, no minutes billed).
        // Don't reset elapsed/lines here: clearing them in the same render would save an empty call.
        handleRef.current?.stop();
        setState("ended");
      }
    }
    setOpen(next);
  }

  const live = state === "active" || state === "connecting";

  const blocked = trial ? blockedCopy(trial) : null;
  const trialBlocked = Boolean(blocked);
  // ?renew=1 auto-pops the plan modal. Anyone seeing this dialog is already past AppLayout's gate and
  // has a subscription row, so no bounce through /subscribe is needed.
  const hasPaidPlan = subscriptionStatus === "active" || subscriptionStatus === "past_due";
  const upgradePath = "/dashboard/plans?renew=1";
  const upgradeLabel = hasPaidPlan ? "Renew plan" : "Upgrade plan";

  /** Seconds this call may run; null = uncapped. Mirrors the server's remainingCallSeconds clamp (Vapi floor is 10s). */
  const callCapSeconds = (() => {
    if (!trial || trial.unlimited) return null;
    if (trial.phase !== "trial" && trial.phase !== "active") return null;
    // Auto-renew charges the saved card when minutes run out, so don't cut the call at the boundary;
    // grant a full allowance of headroom (mirrors the server).
    if (
      trial.autoRenew &&
      trial.minutesAllocated > 0 &&
      (trial.phase === "active" || trial.phase === "trial")
    ) {
      return Math.max(10, Math.floor((trial.minutesRemaining + trial.minutesAllocated) * 60));
    }
    return Math.max(10, Math.floor(trial.minutesRemaining * 60));
  })();
  /** What will actually cut this call: the lower of the two limits, ignoring
   *  whichever one isn't set. */
  const plannedCapSeconds = tightest(serverCapSeconds, callCapSeconds);

  /** Pre-call cutoff and which kind it is: "capped at 2:00" and "2:00 of minutes left" must not read alike.
   *  The allowance is only shown when auto-renew is off, since otherwise running out just renews. */
  const preCall = preCallCap({
    serverCapSeconds,
    allowanceSeconds: callCapSeconds,
    autoRenew: Boolean(trial?.autoRenew),
  });

  /** One rule across idle/connecting/live so the number can't jump mid-connect (380:00 then 2:00). */
  const shownCapSeconds: number | null =
    preCall == null ? null : live ? (capSeconds ?? plannedCapSeconds ?? preCall.seconds) : preCall.seconds;
  const showsLimit = preCall?.kind === "limit";

  const assistantName = config.identity.assistantName || "your assistant";
  const initial = (config.identity.assistantName?.trim()?.[0] || "A").toUpperCase();
  const statusText =
    state === "connecting"
      ? mode === "phone"
        ? phoneStage === "ringing"
          ? "Ringing your phone…"
          : "Placing the call…"
        : "Connecting…"
      : state === "active"
        ? "Call in progress"
        : state === "ended"
          ? "Call ended"
          : mode === "phone"
            ? "Ready to call you"
            : "Ready to test";

  /** Plain-English reason a phone call ended, for the cases a caller can act on.
   *  Vapi's own reasons are engine-speak ("customer-did-not-answer"). */
  const endedNote = (() => {
    if (mode !== "phone" || state !== "ended" || !phoneEndedReason) return "";
    const r = phoneEndedReason.toLowerCase();
    if (r.includes("did-not-answer") || r.includes("no-answer")) return "No answer — nobody picked up.";
    if (r.includes("busy")) return "The line was busy.";
    if (r.includes("declin") || r.includes("rejected")) return "The call was declined.";
    if (r.includes("max-duration")) return "The call reached its time limit.";
    if (r.includes("customer-ended")) return "You hung up.";
    if (r.includes("assistant-ended")) return "Your assistant ended the call.";
    if (r.includes("failed") || r.includes("error"))
      return "The call couldn't be completed. Check the number and try again.";
    return "";
  })();

  /** Whose line the handset showed. Worth saying out loud: it is the one thing a
   *  test call can't show you about itself, and it's what a brand admin is checking. */
  const fromNote =
    phoneFrom &&
    (phoneFrom.source === "customer"
      ? `Called from your number, ${phoneFrom.number}.`
      : phoneFrom.source === "brand"
        ? `Called from your provider's number, ${phoneFrom.number} — activate your own number to call from it instead.`
        : `Called from our shared number, ${phoneFrom.number} — activate your own number to call from it instead.`);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" onPointerDownOutside={live ? (e) => e.preventDefault() : undefined} onEscapeKeyDown={live ? (e) => e.preventDefault() : undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Test {config.identity.assistantName || "your assistant"}
            {mode === "phone" ? (
              <Badge variant="success" className="gap-1">
                <Phone className="size-3" /> Phone
              </Badge>
            ) : hasVapiKey ? (
              <Badge variant="success" className="gap-1">
                <Radio className="size-3" /> Live
              </Badge>
            ) : (
              <Badge variant="neutral">Simulated</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === "phone"
              ? "We'll ring the number you enter and your assistant will answer — the same agent, voice and knowledge a real caller reaches."
              : hasVapiKey
                ? "A real browser call using your current AI Brain config (voice + master prompt)."
                : "Simulated call — configure the voice provider key in Admin → Settings to place a real call."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          <div className="relative flex size-28 items-center justify-center">
            {live && (
              <>
                <span
                  className={cn(
                    "absolute size-28 animate-ping rounded-full opacity-40",
                    state === "active" ? "bg-success/30" : "bg-primary/30",
                  )}
                />
                <span
                  className={cn(
                    "absolute size-24 rounded-full",
                    state === "active" ? "bg-success/10" : "bg-primary/10",
                  )}
                />
              </>
            )}
            <div
              className={cn(
                "relative grid size-24 place-items-center rounded-full text-3xl font-bold text-white shadow-[0_10px_30px_-8px_rgba(29,78,216,0.5)] ring-4 ring-card transition-all",
                state === "active"
                  ? "bg-gradient-to-br from-success to-emerald-600"
                  : state === "ended"
                    ? "bg-gradient-to-br from-muted-foreground/70 to-muted-foreground/50 shadow-none"
                    : "bg-gradient-to-br from-primary to-[#1d4ed8]",
              )}
            >
              {state === "connecting" ? <Loader2 className="size-9 animate-spin" /> : initial}
            </div>
          </div>

          <div className="text-center">
            <p className="text-base font-semibold leading-tight">{assistantName}</p>
            <p
              className={cn(
                "mt-1 inline-flex items-center gap-1.5 text-sm font-medium",
                state === "active"
                  ? "text-success"
                  : state === "connecting"
                    ? "text-primary"
                    : "text-muted-foreground",
              )}
            >
              {state === "active" && <span className="size-1.5 animate-pulse rounded-full bg-success" />}
              {statusText}
              {(state === "active" || state === "ended") && (
                <span className="tabular-nums text-muted-foreground">· {formatDuration(elapsed)}</span>
              )}
            </p>
            {shownCapSeconds != null && state !== "ended" && (
              <p className="mt-1 text-xs text-muted-foreground">
                {showsLimit
                  ? `Call time limit: ${formatDuration(shownCapSeconds)} — ends automatically when the timer reaches it.`
                  : `${trial?.phase === "active" ? "Plan" : "Trial"} minutes left: ${formatDuration(
                      shownCapSeconds,
                    )} — the call ends automatically when they run out.`}
              </p>
            )}
          </div>
        </div>

        {/* Live transcript */}
        {lines.length > 0 ? (
          <div
            ref={scrollRef}
            className="flex max-h-64 min-h-[7rem] flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-warm p-3"
          >
            {lines.map((l, i) => (
              <div key={i} className={cn("flex flex-col", l.role === "caller" ? "items-end" : "items-start")}>
                <span className="mb-0.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {l.role === "agent" ? config.identity.assistantName || "Assistant" : "You"}
                </span>
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug",
                    l.role === "agent"
                      ? "rounded-tl-sm border border-border bg-card"
                      : "rounded-tr-sm bg-primary text-primary-foreground",
                  )}
                >
                  {l.text}
                </div>
              </div>
            ))}
          </div>
        ) : mode === "phone" ? (
          <div className="flex min-h-[7rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-warm p-3 text-center text-sm text-muted-foreground">
            {state === "connecting" ? (
              <span>Answer your phone — {assistantName} is calling.</span>
            ) : state === "active" ? (
              <span>You're on the call. Talk to {assistantName} as a customer would.</span>
            ) : state === "ended" ? (
              <>
                {endedNote && <span className="font-medium text-foreground">{endedNote}</span>}
                <span>The recording, transcript and summary land in your inbox shortly.</span>
              </>
            ) : (
              <span>
                The transcript and recording are saved to your inbox — this call is logged and billed
                exactly like a real one.
              </span>
            )}
            {fromNote && state !== "idle" && <span className="text-xs">{fromNote}</span>}
          </div>
        ) : (
          live && (
            <div className="flex min-h-[7rem] items-center justify-center rounded-xl border border-dashed border-border bg-warm p-3 text-center text-sm text-muted-foreground">
              {state === "connecting" ? "Connecting your call…" : "Listening… start speaking 🎤"}
            </div>
          )
        )}

        {/* Number to ring. Hidden while a call is up so there is nothing to edit mid-call. */}
        {mode === "phone" && !live && !trialBlocked && (
          <div className="space-y-2">
            <Label htmlFor="test-call-number">Number to call</Label>
            <Input
              id="test-call-number"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              placeholder="+61 412 345 678"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void beginPhone();
              }}
            />
            <p className="text-xs text-muted-foreground">
              {preflight?.ready && preflight.from
                ? `Include the country code. We'll call you from ${preflight.from}.`
                : "Include the country code. Your own mobile is the easiest one to test with."}
            </p>
            {preflight && !preflight.ready && (
              <p className="flex items-start gap-1.5 text-xs text-danger">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {preflight.reason}
              </p>
            )}
          </div>
        )}

        {blocked && (
          <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-tint px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>{blocked.title}</strong> — {blocked.reason}. To keep testing and start
              taking real calls, {hasPaidPlan ? "renew your plan" : "upgrade to a paid plan"} below.
            </span>
          </div>
        )}

        <div className="pt-1">
          {live ? (
            <Button variant="danger" onClick={end} className="h-11 w-full gap-2 text-[15px]">
              <PhoneOff className="size-4" /> End call
            </Button>
          ) : trialBlocked ? (
            // Trial/plan exhausted — don't leave a dead "Call again"; guide the
            // user straight to the plans page to renew or upgrade.
            <Button
              onClick={() => {
                close(false);
                navigate(upgradePath);
              }}
              className="h-11 w-full gap-2 text-[15px]"
            >
              <CreditCard className="size-4" /> {upgradeLabel}
            </Button>
          ) : mode === "phone" ? (
            <Button
              onClick={() => void beginPhone()}
              disabled={placing || !toNumber.trim() || preflight?.ready === false}
              className="h-11 w-full gap-2 text-[15px]"
            >
              {placing ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
              {placing ? "Calling…" : state === "ended" ? "Call again" : "Call me now"}
            </Button>
          ) : (
            <Button onClick={begin} className="h-11 w-full gap-2 text-[15px]">
              <Mic className="size-4" /> {state === "ended" ? "Call again" : "Start test call"}
            </Button>
          )}

          {/* Fallback for anyone without a phone to hand, or before an outbound number exists. */}
          {!live && !trialBlocked && (
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "phone" ? "web" : "phone"));
                setState("idle");
                setElapsed(0);
                setLines([]);
                setPhoneEndedReason("");
                setPhoneFrom(null);
              }}
              className="mt-2 w-full text-center text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
            >
              {mode === "phone"
                ? "No phone handy? Test in the browser instead"
                : "Ring my phone instead (connects faster)"}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
