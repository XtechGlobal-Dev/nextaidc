import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, PhoneOff, Loader2, Radio, AlertCircle, CreditCard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { api } from "@/lib/api";
import { env } from "@/lib/env";
import { cn, formatDuration } from "@/lib/utils";
import { preCallCap, tightest } from "@/lib/callCap";
import { toast } from "sonner";

interface Line {
  role: "agent" | "caller";
  text: string;
  /** Seconds into the call when this line was spoken. Stamped as the line
   *  arrives — the saved transcript used to number lines 0s, 5s, 10s… by index,
   *  which drifted past the call's own duration and matched nothing real. */
  at: number;
}

export function AssistantTesterDialog() {
  const open = useUiStore((s) => s.assistantTesterOpen);
  const setOpen = useUiStore((s) => s.setAssistantTester);
  const config = useAgentStore((s) => s.config);
  const promptTemplate = useAgentStore((s) => s.promptTemplate);
  const trial = useTrialStore((s) => s.trial);
  const subscriptionStatus = useAuthStore((s) => s.user?.profile?.subscriptionStatus);
  const navigate = useNavigate();

  // A browser test call runs off the CURRENT AI Brain config (built inline in
  // begin()), so it needs no live assistant / assigned number — a trial user can
  // test freely, gated only by their remaining trial minutes. Real inbound calls
  // still need a provisioned number, set up separately via the number wizard.

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
  /** Same value, rendered. The ref alone can't drive the label — a ref change
   *  doesn't re-render, so the limit shown during "connecting" only refreshed
   *  when the state happened to flip, which is how a stale number stayed on
   *  screen until the call connected and then jumped. */
  const [capSeconds, setCapSeconds] = useState<number | null>(null);
  const applyCap = (v: number | null) => {
    capSecondsRef.current = v;
    setCapSeconds(v);
  };
  /** The platform's per-call ceiling (seconds), read from the warmed-up payload
   *  the server builds. It lives ONLY there — an admin can cap every call at, say,
   *  2 minutes while the account still has 200 plan minutes — so until this lands
   *  we genuinely don't know what will cut the call. */
  const [serverCapSeconds, setServerCapSeconds] = useState<number | null>(null);
  /** Whether the 30s-left warning has fired for the current call. */
  const warnedRef = useRef(false);
  /** The server-built assistant payload, requested as soon as the dialog opens.
   *  /test-token compiles the wire prompt through the LLM summarizer, which takes
   *  seconds — awaiting it on click left the button looking dead, so it's warmed
   *  here and is normally already resolved by the time the user presses start. */
  const payloadRef = useRef<Promise<VapiAssistantPayload | null> | null>(null);
  // Mirror the latest transcript + duration into refs so the deferred end-of-call
  // save can read the FINAL values without re-subscribing the save effect to them.
  // (Keying that effect on `lines`/`elapsed` made a late transcript line re-run it,
  // whose cleanup cancelled the pending save — calls silently never recorded.)
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
    // Warm the assistant payload while the user is still reading the dialog.
    // Deliberately keyed on `open` only: it snapshots the config as opened, which
    // is what the call will run on, and re-requesting on every keystroke would
    // fire an LLM summarization per edit.
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
  }, [open]);

  // Reopening after a finished call: reset to a clean slate so the previous call's
  // transcript/timer doesn't linger. close() intentionally leaves them intact on
  // exit so the save effect can persist them, so we clear them here instead. Only
  // runs on (re)open and never touches a live call.
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

  // Client-side fallback: end the call the moment it reaches the user's remaining
  // minutes, so the trial/plan allowance can't be overshot even if Vapi's own
  // maxDurationSeconds cutoff lags. 30s before that, warn the user and cue the
  // assistant to wrap up gracefully instead of getting cut off mid-sentence.
  useEffect(() => {
    const cap = capSecondsRef.current;
    if (state !== "active" || cap == null) return;
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
  }, [elapsed, state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  // When a call ends, persist it so it appears in the Call Inbox + Dashboard and
  // its minutes are recorded. We save IMMEDIATELY (with `keepalive` so an instant
  // page refresh can't lose the call or its billed minutes), then enrich the AI
  // summary + recording a moment later — those arrive via Vapi's end-of-call
  // report seconds afterwards. The old flow waited ~2.5s and did summarize→create,
  // so a refresh in that window aborted the request → no history, no deduction.
  // Keyed on `state` ONLY (transcript/duration come from refs) so a late
  // transcript line can't re-run this.
  useEffect(() => {
    if (state !== "ended" || savedRef.current) return;
    // Snapshot the duration + transcript NOW (begin()/close() reset the refs).
    // A connected call (any transcript) bills at least 1 second → rounded up to a
    // full minute server-side.
    const finalLines = linesRef.current;
    const finalElapsed = Math.max(elapsedRef.current, finalLines.length > 0 ? 1 : 0);
    if (finalElapsed <= 0) return;
    savedRef.current = true;
    const assistantName = config.identity.assistantName || "your assistant";
    const firstCaller = finalLines.find((l) => l.role === "caller");
    const transcript = finalLines.map((l) => ({ role: l.role, text: l.text, at: l.at }));
    const report = reportRef.current;
    // A summary we can send right now, without waiting on a network round-trip —
    // so the immediate save has something readable. Enriched with the AI summary
    // below once the user is confirmed still here.
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
  }, [state, config.identity.assistantName]);

  // Mid-call reload / tab close: the call never reaches "ended", so the save
  // above never runs and the minutes used so far would be lost. On page hide,
  // if a call is live and unsaved, persist what we have (elapsed + transcript so
  // far) as a `missed` call via a keepalive request, so the minutes are still
  // recorded. `savedRef` keeps this from racing/duplicating the normal end save.
  useEffect(() => {
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
  }, [state, config.identity.assistantName]);

  async function begin() {
    if (trialBlocked) {
      toast.error(blocked?.reason ?? "Your free trial has ended.");
      return;
    }
    // Flip to "connecting" before any await. Everything below can take a moment,
    // and without this the button sits idle looking broken until the call starts —
    // long enough that people press it again and stack calls.
    setState("connecting");
    setElapsed(0);
    setLines([]);
    savedRef.current = false;
    reportRef.current = null;
    vapiCallIdRef.current = null;
    warnedRef.current = false;
    // Provisional cap, so an early failure can't leave the call uncapped: the
    // minutes the user has left, ALREADY lowered to the platform's per-call
    // ceiling if the warm-up told us one. Showing the bare allowance here was
    // wrong twice over — it advertised 380:00 on an account capped at 2:00, and
    // the number then jumped the moment the payload landed. Vapi enforces
    // maxDurationSeconds server-side; the elapsed-watch effect is the UX fallback.
    applyCap(plannedCapSeconds);
    // Build the payload SERVER-side. Only the server can produce the prompt a real
    // inbound call runs on — the compact wire scaffold, put through the LLM
    // summarizer, with the REGIONAL STYLE block appended — and it returns the live
    // booking + info-SMS tools with it. Compiling here instead (the fallback below)
    // uses the FULL template, skips summarization and drops the regional block, so
    // the test call would NOT match a real call. The current draft config goes with
    // the request so unsaved AI Brain edits still apply.
    // Normally already resolved from the warm-up when the dialog opened; awaiting
    // it again here is what makes a very fast click still get the right payload.
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
    // The server already stamps the authoritative cap (remaining minutes lowered
    // to the platform's per-call ceiling). Only ever tighten it here — the local
    // fallback path above compiles without a cap, so this still guards that case,
    // but it must never hand the call a longer limit than the server allowed.
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
    handleRef.current?.stop();
    setState("ended");
  }

  function close(next: boolean) {
    if (!next && (state === "active" || state === "connecting")) {
      // Closing via the X (or an outside click) mid-call must end it exactly like
      // the "End call" button — otherwise the call is dropped without ever reaching
      // the "ended" state, so the save effect never runs: no call log, no minutes
      // recorded. Do NOT reset elapsed/lines here — the save effect reads them from
      // refs on the state→"ended" transition, and clearing them in the same render
      // would persist an empty, zero-duration call. The reopen effect resets for the
      // next call.
      handleRef.current?.stop();
      setState("ended");
    }
    setOpen(next);
  }

  const live = state === "active" || state === "connecting";

  const blocked = trial ? blockedCopy(trial) : null;
  const trialBlocked = Boolean(blocked);
  // Send a blocked user straight to the in-dashboard plans page with ?renew=1,
  // which auto-pops the plan confirmation modal (the chosen plan, pre-filled).
  // A user seeing this modal is on the dashboard, so AppLayout hasn't gated them
  // (status is trialing/active/past_due, never none/canceled/suspended) and they
  // always have a subscription row — so the page + modal render in one hop, no
  // bounce through /subscribe.
  const hasPaidPlan = subscriptionStatus === "active" || subscriptionStatus === "past_due";
  const upgradePath = "/dashboard/plans?renew=1";
  const upgradeLabel = hasPaidPlan ? "Renew plan" : "Upgrade plan";

  /** Seconds this call may run, from the live entitlement. `null` = uncapped
   *  (unlimited plan, or admins/users without a trial). Mirrors the server's
   *  remainingCallSeconds clamp (Vapi's floor is 10s). */
  const callCapSeconds = (() => {
    if (!trial || trial.unlimited) return null;
    if (trial.phase !== "trial" && trial.phase !== "active") return null;
    // Auto-renew plan/trial: when minutes run out it auto-renews (paid plan) or
    // auto-converts the trial to the paid plan, charging the saved card — so don't
    // cut the live call at the boundary. Grant a full allowance of headroom on top
    // of what's left (mirrors the server's remainingCallSeconds).
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

  /** The cutoff to tell the user about before the call starts, and which of the
   *  two it is — "your call is capped at 2:00" and "you have 2:00 of plan
   *  minutes left" are very different messages and must not be worded alike.
   *
   *  The platform's per-call ceiling always applies, auto-renew or not. The
   *  allowance is only worth showing when auto-renew is OFF: otherwise running
   *  out just renews the plan mid-call, so a countdown is pure noise. */
  const preCall = preCallCap({
    serverCapSeconds,
    allowanceSeconds: callCapSeconds,
    autoRenew: Boolean(trial?.autoRenew),
  });

  /** ONE rule for the whole lifecycle — idle, connecting and live — so the
   *  number can't change under the user mid-connect, which is what made the old
   *  label read 380:00 and then 2:00 seconds later. Once the call is running we
   *  show the value actually stamped on it (same limit, just authoritative). */
  const shownCapSeconds: number | null =
    preCall == null ? null : live ? (capSeconds ?? plannedCapSeconds ?? preCall.seconds) : preCall.seconds;
  const showsLimit = preCall?.kind === "limit";

  const assistantName = config.identity.assistantName || "your assistant";
  const initial = (config.identity.assistantName?.trim()?.[0] || "A").toUpperCase();
  const statusText =
    state === "connecting"
      ? "Connecting…"
      : state === "active"
        ? "Call in progress"
        : state === "ended"
          ? "Call ended"
          : "Ready to test";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" onPointerDownOutside={live ? (e) => e.preventDefault() : undefined} onEscapeKeyDown={live ? (e) => e.preventDefault() : undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Test {config.identity.assistantName || "your assistant"}
            {hasVapiKey ? (
              <Badge variant="success" className="gap-1">
                <Radio className="size-3" /> Live
              </Badge>
            ) : (
              <Badge variant="neutral">Simulated</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {hasVapiKey
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
        ) : (
          live && (
            <div className="flex min-h-[7rem] items-center justify-center rounded-xl border border-dashed border-border bg-warm p-3 text-center text-sm text-muted-foreground">
              {state === "connecting" ? "Connecting your call…" : "Listening… start speaking 🎤"}
            </div>
          )
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
          ) : (
            <Button onClick={begin} className="h-11 w-full gap-2 text-[15px]">
              <Mic className="size-4" /> {state === "ended" ? "Call again" : "Start test call"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
