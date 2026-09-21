import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatDuration, uid } from "@/lib/utils";
import type { CallLog, TranscriptTurn } from "@/types";
import {
  buildAssistantPayload,
  startTestCall,
  type CallReport,
  type VapiCallState,
  type VapiCallHandle,
} from "@/lib/vapi";
import { api, ApiError, type CallerIdSource } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { toast } from "sonner";

export default function Step1Call() {
  const [state, setState] = useState<VapiCallState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [vapiKey, setVapiKey] = useState("");
  /** A real phone call is the default: the browser path spends seconds negotiating
   *  WebRTC before the agent speaks, which reads as a broken first impression on the
   *  very first screen. The browser call stays as a fallback. */
  const [mode, setMode] = useState<"phone" | "web">("phone");
  const savedMobile = useAuthStore((s) => s.user?.profile?.mobile ?? "");
  const [toNumber, setToNumber] = useState(savedMobile);
  const [placing, setPlacing] = useState(false);
  const [phoneStage, setPhoneStage] = useState("");
  const [phoneFrom, setPhoneFrom] = useState<{ number: string; source: CallerIdSource } | null>(null);
  /** Vapi id of the phone call in flight; also what the logged call is matched on. */
  const phoneCallIdRef = useRef<string | null>(null);
  const callRef = useRef<VapiCallHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  // Real conversation captured from the live call, persisted on end.
  const turnsRef = useRef<TranscriptTurn[]>([]);
  const reportRef = useRef<CallReport | null>(null);
  const vapiCallIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const finalizedRef = useRef(false);

  // Tick a local seconds counter while the call is active.
  useEffect(() => {
    if (state === "active") {
      timerRef.current = window.setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state]);

  // Save immediately with keepalive, then advance; summary/recording are patched in later (enrichCapturedCall).
  // The old flow waited up to 4s first, and a refresh in that window lost the call and its billed minutes.
  useEffect(() => {
    if (mode !== "web" || state !== "ended") return;
    void (async () => {
      await finalizeCall();
      useQuickSetupStore.getState().next();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Mid-call reload never reaches "ended", so persist what we have as a `missed` call via keepalive
  // so the minutes still bill. `finalizedRef` stops it duplicating the normal save.
  useEffect(() => {
    if (mode !== "web") return;
    if (state !== "active" && state !== "connecting") return;
    const savePartial = () => {
      if (finalizedRef.current) return;
      const turns = turnsRef.current.slice();
      const durationSec = Math.max(
        0,
        Math.round((Date.now() - startedAtRef.current) / 1000),
        turns.length > 0 ? 1 : 0,
      );
      if (durationSec <= 0) return; // nothing spoken yet — nothing to bill/save
      finalizedRef.current = true;
      const assistantName = useAgentStore.getState().config.identity.assistantName || "your assistant";
      const firstCaller = turns.find((t) => t.role === "caller");
      void api.calls.create(
        {
          type: "Web",
          callerName: "Browser Test",
          durationSec,
          outcome: "missed", // reloaded mid-call — the call didn't complete
          summary: firstCaller?.text?.slice(0, 140) || `Test call with ${assistantName}`,
          transcript: turns,
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
  }, [state, mode]);

  /** Resolve once the end-of-call report arrives, or after `maxMs`. */
  function waitForReport(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (reportRef.current) return resolve();
      const start = Date.now();
      const id = window.setInterval(() => {
        if (reportRef.current || Date.now() - start >= maxMs) {
          window.clearInterval(id);
          resolve();
        }
      }, 200);
    });
  }

  // Runtime Vapi key from Admin → Settings, so it works without a build-time env var.
  useEffect(() => {
    api.config().then((c) => setVapiKey(c.vapiPublicKey || "")).catch(() => {});
  }, []);

  // The auth store can hydrate after the first render, so seed the field then too —
  // but never overwrite something already typed.
  useEffect(() => {
    if (savedMobile) setToNumber((n) => n || savedMobile);
  }, [savedMobile]);

  // Clean up the call handle on unmount.
  useEffect(() => {
    return () => {
      callRef.current?.stop();
      callRef.current = null;
    };
  }, []);

  /** Save the captured call immediately (refresh-safe), then enrich it in the
   *  background once Vapi's report lands. */
  async function finalizeCall() {
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    const config = useAgentStore.getState().config;
    const assistantName = config.identity.assistantName || "your assistant";
    const durationSec = Math.max(seconds, Math.round((Date.now() - startedAtRef.current) / 1000));

    const turns = turnsRef.current.slice();
    if (turns.length === 0 && config.identity.greetingMessage) {
      turns.push({ role: "agent", text: config.identity.greetingMessage, at: 0 });
    }

    const report = reportRef.current;
    const firstCaller = turns.find((t) => t.role === "caller");
    // A summary we can send right now, no network round-trip — enriched with the
    // AI summary below once the call is safely saved.
    const fallbackSummary =
      report?.summary?.trim() || firstCaller?.text?.slice(0, 140) || `Test call with ${assistantName}`;
    const analysis = {
      summary: fallbackSummary,
      intent: "Test call",
      sentiment: "Positive" as const,
      actionItems: firstCaller ? ["Review test conversation"] : [],
      ...(vapiCallIdRef.current ? { vapiCallId: vapiCallIdRef.current } : {}),
    };

    try {
      // Save immediately + keepalive — records the call and deducts the minutes,
      // and survives a page refresh.
      const created = await api.calls.create(
        {
          type: "Web",
          callerName: "Browser Test",
          durationSec,
          outcome: "completed",
          summary: fallbackSummary,
          ...(report?.recordingUrl ? { recordingUrl: report.recordingUrl } : {}),
          transcript: turns,
          analysis,
        },
        { keepalive: true },
      );
      useQuickSetupStore.getState().setCaptured(created);
      void useCallsStore.getState().hydrate();
      // Enrich the AI summary + recording once the report lands — background,
      // never blocks advancing.
      if (created?.id) void enrichCapturedCall(created.id, turns, fallbackSummary);
    } catch {
      // Persisting failed — still show the real transcript from this session.
      const local: CallLog = {
        id: uid("call"),
        conversionId: "",
        type: "Web",
        callerName: "Browser Test",
        callerNumber: "",
        createdAt: new Date().toISOString(),
        durationSec,
        outcome: "completed",
        summary: fallbackSummary,
        ...(report?.recordingUrl ? { recordingUrl: report.recordingUrl } : {}),
        transcript: turns,
        analysis,
      };
      useQuickSetupStore.getState().setCaptured(local);
      useCallsStore.getState().addCalls([local]);
    }
  }

  /** Best-effort: after the fast save, wait for Vapi's report, compute the AI
   *  summary, and patch the summary + recording onto the saved call. */
  async function enrichCapturedCall(id: string, turns: TranscriptTurn[], fallbackSummary: string) {
    await waitForReport(4000);
    let aiSummary = "";
    try {
      aiSummary = (await api.calls.summarize(turns)).summary?.trim() || "";
    } catch {
      /* ignore */
    }
    const report = reportRef.current;
    const bestSummary = report?.summary?.trim() || aiSummary;
    const patch: { summary?: string; recordingUrl?: string } = {};
    if (bestSummary && bestSummary !== fallbackSummary) patch.summary = bestSummary;
    if (report?.recordingUrl?.trim()) patch.recordingUrl = report.recordingUrl.trim();
    if (!Object.keys(patch).length) return;
    const updated = await api.calls.update(id, patch).catch(() => null);
    if (updated) {
      useQuickSetupStore.getState().setCaptured(updated);
      void useCallsStore.getState().hydrate();
    }
  }

  /** Ring the number the user typed. The server decides which line it goes out on
   *  (their own number, their brand's, or the platform's) — the agent that answers
   *  is always theirs either way. */
  async function handlePhoneCall() {
    const dial = toNumber.trim();
    if (!dial) {
      toast.error("Enter the phone number you want us to ring.");
      return;
    }
    setPlacing(true);
    setSeconds(0);
    turnsRef.current = [];
    reportRef.current = null;
    vapiCallIdRef.current = null;
    phoneCallIdRef.current = null;
    finalizedRef.current = false;
    startedAtRef.current = Date.now();
    try {
      const started = await api.agent.testCall(dial, useAgentStore.getState().config);
      phoneCallIdRef.current = started.callId;
      setPhoneFrom({ number: started.from, source: started.fromSource });
      setPhoneStage(started.status || "queued");
      setState("connecting");
    } catch (e) {
      setState("idle");
      toast.error(e instanceof ApiError ? e.message : "Couldn't place the call. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  // Watch the call Vapi is running — the only view this page has of a phone call.
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
          if (s.durationSec > 0) setSeconds(s.durationSec);
        } else if (s.status === "ended") {
          if (s.durationSec > 0) setSeconds(s.durationSec);
          setState("ended");
        }
      } catch {
        /* a dropped poll is not a dropped call */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, state]);

  // A phone call is logged, billed and summarised by the end-of-call webhook, so
  // there is nothing to save here — only the finished row to wait for, so step 2
  // opens on THIS call rather than the previous one.
  useEffect(() => {
    if (mode !== "phone" || state !== "ended") return;
    const wantedId = phoneCallIdRef.current;
    phoneCallIdRef.current = null;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const found = await api.calls
          .list({ pageSize: 5 })
          // Matched on the Vapi id the webhook stamps into `analysis`, so a call
          // already in the list from an earlier session isn't mistaken for this one.
          .then((d) => d.calls.find((c) => (wantedId ? c.analysis?.vapiCallId === wantedId : true)))
          .catch(() => null);
        if (cancelled) return;
        if (found) {
          useQuickSetupStore.getState().setCaptured(found);
          void useCallsStore.getState().hydrate();
          break;
        }
      }
      // Advance either way: step 2 falls back to the most recent call, and a caller
      // who never answered shouldn't be stranded on a spinner.
      if (!cancelled) useQuickSetupStore.getState().next();
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, state]);

  /** Hang up from here. The caller can equally just put the handset down. */
  function handlePhoneEnd() {
    const id = phoneCallIdRef.current;
    setState("ended");
    if (id) void api.agent.testCallEnd(id).catch(() => {});
  }

  function handleCall() {
    setSeconds(0);
    turnsRef.current = [];
    reportRef.current = null;
    vapiCallIdRef.current = null;
    finalizedRef.current = false;
    startedAtRef.current = Date.now();
    const payload = buildAssistantPayload(useAgentStore.getState().config, {
      promptTemplate: useAgentStore.getState().promptTemplate,
    });
    callRef.current = startTestCall(
      payload,
      {
        onState: setState,
        onTranscript: (role, text) =>
          turnsRef.current.push({
            role,
            text,
            at: Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)),
          }),
        onReport: (r) => {
          reportRef.current = r;
        },
        onCallId: (id) => {
          vapiCallIdRef.current = id;
        },
        onError: (m) => toast.error(m),
      },
      vapiKey,
    );
  }

  function handleEnd() {
    callRef.current?.stop();
    callRef.current = null;
    setState("ended");
  }

  const inCall = state === "connecting" || state === "active";

  if (state === "ended") {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Wrapping up your call…</p>
      </div>
    );
  }

  if (inCall) {
    return (
      <div className="flex flex-col items-center gap-6 py-6 text-center">
        <div
          className={cn(
            "flex size-36 items-center justify-center rounded-full",
            mode === "phone" ? "bg-primary/10 text-primary" : "bg-danger-tint text-danger",
          )}
        >
          {mode === "phone" ? <Phone className="size-12" /> : <Mic className="size-12" />}
        </div>

        <div className="font-mono text-3xl font-bold tabular-nums">
          {formatDuration(seconds)}
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          {mode === "phone"
            ? state === "connecting"
              ? phoneStage === "ringing"
                ? "Ringing your phone — pick up!"
                : "Placing the call…"
              : "You're connected — say hello"
            : state === "connecting"
              ? "Connecting…"
              : "AI is speaking…"}
        </div>

        {mode === "phone" && phoneFrom && (
          <p className="text-xs text-muted-foreground">
            Calling from {phoneFrom.number}
            {phoneFrom.source === "customer" ? " — your own number." : "."}
          </p>
        )}

        <Button
          variant="danger"
          size="lg"
          className="w-full"
          onClick={mode === "phone" ? handlePhoneEnd : handleEnd}
        >
          <PhoneOff />
          END CALL
        </Button>
      </div>
    );
  }

  if (mode === "phone") {
    return (
      <div className="flex flex-col items-center gap-6 py-6 text-center">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Let your AI receptionist call you</h2>
          <p className="text-muted-foreground">
            Enter your mobile and we&apos;ll ring you — the same agent your customers will reach.
          </p>
        </div>

        <div className="w-full max-w-sm space-y-2 text-left">
          <Label htmlFor="quicksetup-call-number">Your phone number</Label>
          <Input
            id="quicksetup-call-number"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="+61 412 345 678"
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handlePhoneCall();
            }}
          />
          <p className="text-xs text-muted-foreground">Include the country code.</p>
        </div>

        <Button
          size="lg"
          className="w-full max-w-sm gap-2"
          disabled={placing || !toNumber.trim()}
          onClick={() => void handlePhoneCall()}
        >
          {placing ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
          {placing ? "Calling…" : "CALL ME NOW"}
        </Button>

        <button
          type="button"
          onClick={() => setMode("web")}
          className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          No phone handy? Test in the browser instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 py-6 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Call your AI receptionist</h2>
        <p className="text-muted-foreground">
          Speak to your AI agent to test the live customer experience.
        </p>
      </div>

      <button
        type="button"
        onClick={handleCall}
        className={cn(
          "group flex size-36 flex-col items-center justify-center gap-1.5 rounded-full",
          "bg-primary text-white shadow-lg ring-8 ring-primary/15",
          "transition-transform hover:scale-105 focus-visible:focus-ring active:scale-95",
        )}
      >
        <Phone className="size-8" />
        <span className="text-xs font-semibold tracking-wide">TAP TO CALL</span>
      </button>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Mic className="size-3.5" />
        Web call powered by your microphone
      </div>

      <button
        type="button"
        onClick={() => setMode("phone")}
        className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Ring my phone instead (connects faster)
      </button>
    </div>
  );
}
