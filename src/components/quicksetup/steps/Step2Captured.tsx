import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Phone,
} from "lucide-react";
import type { CallLog } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";

/** Render duration as "0m 36s". */
function durationLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function Loading() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <Loader2 className="size-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">
        Loading, generating live call logs…
      </p>
    </div>
  );
}

export default function Step2Captured() {
  const captured = useQuickSetupStore((s) => s.captured);
  const next = useQuickSetupStore((s) => s.next);
  const goTo = useQuickSetupStore((s) => s.goTo);

  const [checking, setChecking] = useState(() => captured === null);
  const [callsDone, setCallsDone] = useState<number | null>(null);

  // Real "calls done" count for the analytics tile.
  useEffect(() => {
    let active = true;
    api.calls
      .stats()
      .then((s) => active && setCallsDone(s.total))
      .catch(() => active && setCallsDone(null));
    return () => {
      active = false;
    };
  }, []);

  // If we landed here without an in-session capture (e.g. a refresh), pull the
  // most recent real call from the backend instead of fabricating one.
  useEffect(() => {
    if (captured !== null) return;
    let active = true;
    api.calls
      .list({ pageSize: 1 })
      .then((d) => {
        if (active && d.calls[0]) useQuickSetupStore.getState().setCaptured(d.calls[0]);
      })
      .catch(() => {})
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [captured]);

  if (captured === null) {
    return checking ? <Loading /> : <NoCall onRetry={() => goTo(1)} />;
  }

  return (
    <Results captured={captured} callsDone={callsDone} onNext={next} onRetry={() => goTo(1)} />
  );
}

function NoCall({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary-tint text-primary">
        <Phone className="size-6" />
      </div>
      <p className="text-sm text-muted-foreground">
        No test call yet — make a quick call so your AI can capture a real lead.
      </p>
      <Button onClick={onRetry}>Make a test call</Button>
    </div>
  );
}

function Results({
  captured,
  callsDone,
  onNext,
  onRetry,
}: {
  captured: CallLog;
  callsDone: number | null;
  onNext: () => void;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Derive a friendly label for the call duration row.
  const callLabel = captured.summary?.trim() || "Test Call";

  return (
    <div className="space-y-5">
      <h2 className="text-center text-2xl font-bold">
        Here&apos;s what your AI captured
      </h2>

      {/* LIVE ANALYTICS */}
      <Card>
        <CardContent className="relative space-y-4 p-5 pt-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Live Analytics
            </span>
            <Badge variant="success" className="uppercase tracking-wide">
              <span className="size-1.5 rounded-full bg-success" />
              Live
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Calls Done
              </p>
              <p className="text-3xl font-bold tabular-nums">{callsDone ?? 1}</p>
              <p className="text-xs font-medium text-success">
                +1 lead captured just now
              </p>
              <p className="text-[11px] text-muted-foreground">
                *Call recording in dashboard
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Call Duration
              </p>
              <p className="text-3xl font-bold tabular-nums">
                {durationLabel(captured.durationSec)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {callLabel}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI SUMMARY + TRANSCRIPT */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-2 p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                AI Summary
              </span>
            </div>
            <p className="text-sm leading-relaxed text-foreground">
              {captured.analysis?.summary || captured.summary}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Transcript
            </span>
            <div
              ref={scrollRef}
              className="max-h-48 space-y-2 overflow-y-auto pr-1"
            >
              {(captured.transcript ?? []).map((turn, i) => (
                <p key={i} className="text-sm leading-relaxed">
                  <span
                    className={cn(
                      "font-semibold",
                      turn.role === "agent" ? "text-primary" : "text-danger",
                    )}
                  >
                    {turn.role === "agent" ? "AI Agent:" : "Caller:"}
                  </span>{" "}
                  <span className="text-foreground">{turn.text}</span>
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Success panel */}
      <div className="space-y-3 rounded-[var(--radius-card)] bg-success-tint p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          Lead captured and logged to your inbox
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          SMS summary sent to your mobile
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-3 pt-1">
        <Button variant="primary" size="lg" className="w-full" onClick={onNext}>
          SAVE AND CONTINUE
          <ArrowRight />
        </Button>
        <button
          type="button"
          onClick={onRetry}
          className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          ← Make another test call
        </button>
      </div>
    </div>
  );
}
