import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDuration, uid } from "@/lib/utils";
import type { CallLog, TranscriptTurn } from "@/types";
import {
  buildAssistantPayload,
  startTestCall,
  type CallReport,
  type VapiCallState,
  type VapiCallHandle,
} from "@/lib/vapi";
import { api } from "@/lib/api";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { toast } from "sonner";

export default function Step1Call() {
  const [state, setState] = useState<VapiCallState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [vapiKey, setVapiKey] = useState("");
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

  // When the call ends, save it IMMEDIATELY (with `keepalive`, so an instant page
  // refresh can't lose the call or its billed minutes) and advance to step 2. The
  // AI summary + recording arrive via Vapi's report seconds later and are patched
  // in afterwards (see enrichCapturedCall). The old flow waited up to 4s before
  // saving, so a refresh in that window aborted the request → no history, no
  // minutes deducted.
  useEffect(() => {
    if (state !== "ended") return;
    void (async () => {
      await finalizeCall();
      useQuickSetupStore.getState().next();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Mid-call reload / tab close: the call never reaches "ended", so finalizeCall
  // never runs and the minutes used so far would be lost. On page hide, if a call
  // is live and unsaved, persist what we have as a `missed` call via a keepalive
  // request so the minutes are still recorded. `finalizedRef` guards against
  // duplicating the normal end save.
  useEffect(() => {
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
  }, [state]);

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

  // Use the runtime Vapi browser key (set in Admin → Settings) so the call works
  // even when it isn't baked in as a build-time env var — same source the main
  // assistant tester uses.
  useEffect(() => {
    api.config().then((c) => setVapiKey(c.vapiPublicKey || "")).catch(() => {});
  }, []);

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
        <div className="flex size-36 items-center justify-center rounded-full bg-danger-tint text-danger">
          <Mic className="size-12" />
        </div>

        <div className="font-mono text-3xl font-bold tabular-nums">
          {formatDuration(seconds)}
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          {state === "connecting" ? "Connecting…" : "AI is speaking…"}
        </div>

        <Button variant="danger" size="lg" className="w-full" onClick={handleEnd}>
          <PhoneOff />
          END CALL
        </Button>
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
    </div>
  );
}
