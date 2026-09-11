import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Copy,
  Globe,
  Languages,
  Loader2,
  MessageSquareText,
  Phone,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatDate, formatDuration } from "@/lib/utils";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { api } from "@/lib/api";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import type { CallIntent, CallLog, TranscriptTurn } from "@/types";
import { PhoneMissed } from "lucide-react";
import {
  CALL_INTENTS,
  INTENT_HINTS,
  INTENT_LABELS,
  OUTCOME_LABELS,
  outcomeVariant,
  sentimentVariant,
  transferBadge,
  intentBadge,
  callerLabel,
} from "./callUtils";
import { copyTranscript } from "./CallTable";
import { Waveform } from "./Waveform";

/** Per-session, in-memory cache of transcript/summary translation requests, keyed
 *  by call id + language. Re-opening a call (or StrictMode's double-invoke in dev)
 *  reuses the same promise instead of re-hitting the API. Caching the PROMISE also
 *  dedupes concurrent opens before the first response lands. */
const translationCache = new Map<
  string,
  Promise<{ lang: string; transcript: TranscriptTurn[]; summary: string }>
>();

/**
 * The call's category, as an editable pill. The AI gets it right most of the
 * time; this exists for the rest. Without a way to correct a wrong badge, one
 * bad classification makes an owner distrust every badge on the page — and each
 * correction is a labelled example we can tune the classifier against.
 */
function IntentPicker({ call }: { call: CallLog }) {
  const setIntent = useCallsStore((s) => s.setIntent);
  const [saving, setSaving] = useState(false);
  const current = intentBadge(call);

  const choose = async (next: CallIntent) => {
    if (next === call.intent) return;
    setSaving(true);
    try {
      await setIntent(call.id, next);
      toast.success(`Category set to ${INTENT_LABELS[next]}`);
    } catch {
      toast.error("Couldn't update the category");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={saving}>
        <button
          type="button"
          aria-label="Change call category"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Badge
            variant={current?.variant ?? "outline"}
            className="cursor-pointer transition-opacity hover:opacity-80"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            {current?.label ?? "Set category"}
            <ChevronDown className="size-3 opacity-60" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {CALL_INTENTS.map((key) => (
          <DropdownMenuItem key={key} onSelect={() => void choose(key)}>
            <span className="flex flex-1 flex-col">
              <span className="font-medium">{INTENT_LABELS[key]}</span>
              <span className="text-xs text-muted-foreground">{INTENT_HINTS[key]}</span>
            </span>
            {call.intent === key && <CheckCircle2 className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function fetchTranslation(callId: string, lang: string) {
  const key = `${callId}::${lang}`;
  let p = translationCache.get(key);
  if (!p) {
    p = api.calls.translate(callId);
    // Drop failed lookups so a later open can retry instead of caching the error.
    p.catch(() => translationCache.delete(key));
    translationCache.set(key, p);
  }
  return p;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function CallDetailPanel({
  call,
  onClose,
  autoPlayKey,
}: {
  call: CallLog;
  onClose: () => void;
  autoPlayKey?: number;
}) {
  // Lock background scroll while this slide-over is open.
  useBodyScrollLock(true);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Stream the recording through our own backend (same proxy emails use) so the
  // player + download show our domain instead of storage.vapi.ai. The proxy path
  // is a SIGNED, short-lived token (not the raw call id), and the <audio> element
  // can't send an auth header — so we ask the server (authenticated, scoped to
  // our own calls) to mint a fresh playback URL each time we open the call. The
  // proxy handles both a stored URL (legacy) and the Vapi call id internally.
  const [playbackUrl, setPlaybackUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setPlaybackUrl(undefined);
    api.calls
      .recordingUrl(call.id)
      .then((r) => {
        if (active) setPlaybackUrl(r.url ?? undefined);
      })
      .catch(() => {
        if (active) setPlaybackUrl(undefined);
      });
    return () => {
      active = false;
    };
  }, [call.id]);

  // Copying a link to send to someone else mints a SEPARATE, longer-lived token
  // rather than reusing `playbackUrl` — that one is short-lived by design (it is
  // re-minted every time the panel opens), so a pasted copy of it would die
  // within hours. Minted on click, not up front, so a link only exists once the
  // owner has actually decided to share it.
  const [sharing, setSharing] = useState(false);
  const shareRecording = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const { url, expiresInDays } = await api.calls.recordingUrl(call.id, true);
      if (!url) throw new Error("no recording");
      await navigator.clipboard.writeText(url);
      toast.success("Recording link copied", {
        description: expiresInDays
          ? `Anyone with the link can listen for ${expiresInDays} days.`
          : "Anyone with the link can listen.",
      });
    } catch {
      toast.error("Couldn't copy the recording link");
    } finally {
      setSharing(false);
    }
  };

  // Calls past the archive window come out of the list without their transcript
  // — cold storage holds it, and fetching one per row would have made opening
  // the inbox far more expensive than opening a call. Pull it back the moment
  // the panel opens; the store swaps the fuller record in, which re-renders us
  // with the transcript. A no-op for any call still holding its blobs inline.
  const ensureTranscript = useCallsStore((s) => s.ensureTranscript);
  useEffect(() => {
    if (call.blobArchived) void ensureTranscript(call.id);
  }, [call.id, call.blobArchived, ensureTranscript]);

  // Owner report language: when set (non-English), the transcript is translated
  // on-demand (server caches it) and shown by default, with a toggle to the original.
  const reportLanguage = useAgentStore((s) => s.config.automations.reportLanguage);
  const needsTx =
    Boolean(reportLanguage?.trim()) && reportLanguage.trim().toLowerCase() !== "english";
  const [translated, setTranslated] = useState<TranscriptTurn[] | null>(null);
  const [translatedSummary, setTranslatedSummary] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
  useEffect(() => {
    if (!needsTx) {
      setTranslated(null);
      setTranslatedSummary(null);
      return;
    }
    let active = true;
    setTxLoading(true);
    fetchTranslation(call.id, reportLanguage.trim())
      .then((r) => {
        if (!active) return;
        setTranslated(r.lang ? r.transcript : null);
        setTranslatedSummary(r.lang ? r.summary || null : null);
      })
      .catch(() => {
        if (active) {
          setTranslated(null);
          setTranslatedSummary(null);
        }
      })
      .finally(() => {
        if (active) setTxLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id, needsTx, reportLanguage]);

  // Be defensive: a call that bypassed store normalization (e.g. a future direct
  // fetch, or stale data) may carry a raw/partial shape — never crash the panel.
  const transcript = call.transcript ?? [];
  const displayTranscript = needsTx && !showOriginal && translated ? translated : transcript;
  const analysis = call.analysis ?? {
    summary: call.summary ?? "",
    intent: "—",
    sentiment: "Neutral" as const,
    actionItems: [],
  };
  // AI Summary in the owner's report language when available (toggle shares the
  // transcript's "Show original" state).
  const displaySummary =
    needsTx && !showOriginal && translatedSummary ? translatedSummary : analysis.summary;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/30 backdrop-blur-[1px]"
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-label="Call details"
        className="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col bg-card shadow-[var(--shadow-panel)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{callerLabel(call.callerName)}</h2>
              <IntentPicker call={call} />
              <Badge variant={outcomeVariant(call.outcome)}>{OUTCOME_LABELS[call.outcome]}</Badge>
              {(() => {
                const xfer = transferBadge(call);
                return xfer ? <Badge variant={xfer.variant}>{xfer.label}</Badge> : null;
              })()}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(call.createdAt)}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {call.transferOutcome === "failed" && (
            <div className="mb-5 flex gap-3 rounded-lg border border-danger/30 bg-danger-tint p-3">
              <PhoneMissed className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="text-sm">
                <p className="font-medium text-danger">Transfer didn't connect — call them back</p>
                <p className="mt-0.5 text-muted-foreground">
                  This caller wanted to speak with{" "}
                  {call.requestedDepartment?.trim() &&
                  call.requestedDepartment.toLowerCase() !== "a person"
                    ? `the ${call.requestedDepartment.trim()} team`
                    : "a person"}
                  , but the transfer couldn't be completed.
                  {call.callerNumber?.trim() ? ` Reach them on ${call.callerNumber.trim()}.` : ""}
                </p>
              </div>
            </div>
          )}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Meta label="Caller" value={callerLabel(call.callerName)} />
            <Meta label="Number" value={call.callerNumber} />
            <Meta
              label="Type"
              value={
                <span className="inline-flex items-center gap-1">
                  {call.type === "Web" ? <Globe className="size-3.5" /> : <Phone className="size-3.5" />}
                  {call.type}
                </span>
              }
            />
            <Meta label="Duration" value={formatDuration(call.durationSec)} />
            {call.requestedDepartment?.trim() &&
              call.requestedDepartment.toLowerCase() !== "a person" && (
                <Meta label="Requested department" value={call.requestedDepartment.trim()} />
              )}
          </dl>

          <div className="mt-5">
            <Waveform
              durationSec={call.durationSec}
              seed={call.id}
              autoPlayKey={autoPlayKey}
              recordingUrl={playbackUrl}
              onShare={playbackUrl ? () => void shareRecording() : undefined}
              sharing={sharing}
              onDownload={() =>
                toast.success("Recording download started", {
                  description: `${callerLabel(call.callerName)} · ${formatDuration(call.durationSec)}`,
                })
              }
            />
          </div>

          <Separator className="my-5" />

          <Tabs defaultValue="transcript">
            <TabsList className="w-full">
              <TabsTrigger value="transcript" className="flex-1">
                Transcript
              </TabsTrigger>
              <TabsTrigger value="analysis" className="flex-1">
                Analysis
              </TabsTrigger>
            </TabsList>

            <TabsContent value="transcript" className="mt-4">
              {transcript.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border py-10 text-center">
                  <MessageSquareText className="size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No transcript for this call.</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    {needsTx && (translated || txLoading) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={txLoading}
                        onClick={() => setShowOriginal((o) => !o)}
                      >
                        {txLoading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Languages className="size-4" />
                        )}
                        {txLoading
                          ? "Translating…"
                          : showOriginal
                            ? `Show ${reportLanguage}`
                            : "Show original"}
                      </Button>
                    ) : (
                      <span />
                    )}
                    <Button variant="outline" size="sm" onClick={() => void copyTranscript(call)}>
                      <Copy className="size-4" />
                      Copy Transcript
                    </Button>
                  </div>
                  <div className="flex flex-col gap-3">
                    {displayTranscript.map((turn, i) => {
                      const isAgent = turn.role === "agent";
                      return (
                        <div
                          key={i}
                          className={cn("flex flex-col", isAgent ? "items-start" : "items-end")}
                        >
                          <div
                            className={cn(
                              "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                              isAgent
                                ? "rounded-tl-sm bg-muted text-foreground"
                                : "rounded-tr-sm bg-primary-tint text-foreground",
                            )}
                          >
                            {turn.text}
                          </div>
                          <span className="mt-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {isAgent ? "Agent" : "Caller"} · {formatDuration(turn.at)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="analysis" className="mt-4">
              <div className="space-y-5">
                <section>
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="size-4 text-primary" />
                    AI Summary
                  </div>
                  <p className="rounded-[var(--radius-card)] bg-warm p-3 text-sm text-foreground">
                    {displaySummary}
                  </p>
                </section>

                <section className="flex flex-wrap gap-6">
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Call Intent
                    </p>
                    <Badge variant="outline">{analysis.intent}</Badge>
                  </div>
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Sentiment
                    </p>
                    <Badge variant={sentimentVariant(analysis.sentiment)}>
                      {analysis.sentiment}
                    </Badge>
                  </div>
                </section>

                <section>
                  <p className="mb-2 text-sm font-semibold">Key Action Items</p>
                  {analysis.actionItems.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border p-3 text-sm text-muted-foreground">
                      <CheckCircle2 className="size-4 text-success" />
                      No action required.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {analysis.actionItems.map((item, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded-[var(--radius-card)] border border-border bg-background p-3 text-sm"
                        >
                          <ArrowRight className="mt-0.5 size-4 shrink-0 text-primary" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </aside>
    </div>
  );
}
