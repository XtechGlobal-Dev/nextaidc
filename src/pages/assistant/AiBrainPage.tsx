import { useCallback, useEffect, useState } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
import { Brain, PhoneCall, Save, Check, Loader2, AlertCircle, AlertTriangle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useUiStore } from "@/stores/useUiStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageSkeleton } from "@/components/ui/skeleton";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import type { AgentConfig, AgentSectionKey } from "@/types";
import { SECTIONS } from "./sectionMeta";
import { IdentitySection } from "./sections/IdentitySection";
import { KnowledgeSection } from "./sections/KnowledgeSection";
import { RulesSection } from "./sections/RulesSection";
import { AdvancedSection } from "./sections/AdvancedSection";
import { AutomationsSection, automationContactErrors } from "./sections/AutomationsSection";

/** Best-effort "has the user filled this section in" check, for the tab progress. */
function isSectionComplete(key: AgentSectionKey, c: AgentConfig): boolean {
  switch (key) {
    case "identity":
      return Boolean(c.identity.assistantName && c.identity.businessName);
    case "knowledge":
      return (
        (c.knowledge.services?.length ?? 0) > 0 ||
        c.knowledge.captureFields.some((f) => f.enabled)
      );
    case "rules":
      return (
        c.rules.scenarioHandling.length > 0 ||
        Boolean(c.rules.businessHours?.trim()) ||
        Boolean(c.rules.pricing.behaviour?.trim())
      );
    case "automations":
      return (
        c.automations.ownerEmailSummary ||
        c.automations.ownerSmsSummary ||
        c.automations.ownerWhatsAppSummary ||
        c.automations.clientPostCallSms
      );
    case "advanced":
      return Boolean(c.advanced.masterPrompt?.trim());
  }
}

/** "This account has opened the assistant tester" — per account id, so an admin
 *  who impersonates a customer gets that workspace's own nudge, not theirs. */
const testerSeenKey = (accountId: string) => `hello22_tester_seen:${accountId || "me"}`;

export default function AiBrainPage() {
  const [active, setActive] = useState<AgentSectionKey>("identity");
  const config = useAgentStore((s) => s.config);
  const dirty = useAgentStore((s) => s.dirty);
  const dirtySections = useAgentStore((s) => s.dirtySections);
  const lastSyncedAt = useAgentStore((s) => s.lastSyncedAt);
  const syncFailed = useAgentStore((s) => s.syncFailed);
  const save = useAgentStore((s) => s.save);
  const revert = useAgentStore((s) => s.revert);
  const profileId = useProfileStore((s) => s.profile.id);
  const setTester = useUiStore((s) => s.setAssistantTester);
  const [saving, setSaving] = useState(false);

  // Highlight "Test Call" until the user has actually heard their agent —
  // it reads as just another toolbar action otherwise. Gated on "never tested"
  // rather than on the trial, so it nudges admins (who are unlimited, never
  // "trialing") the same way. Opening the tester clears it for good; so does any
  // recorded usage, covering a test made on another browser.
  const trial = useTrialStore((s) => s.trial);
  const [testerSeen, setTesterSeen] = useState(false);
  useEffect(() => {
    try {
      setTesterSeen(localStorage.getItem(testerSeenKey(profileId)) === "1");
    } catch {
      /* private mode — the nudge just shows again next session */
    }
  }, [profileId]);
  const nudgeTester = !testerSeen && !trial?.blocked && !((trial?.minutesUsed ?? 0) > 0);

  function openTester() {
    try {
      localStorage.setItem(testerSeenKey(profileId), "1");
    } catch {
      /* ignore — worst case the nudge shows once more */
    }
    setTesterSeen(true);
    setTester(true);
  }

  // A tab the user asked to open while there are unsaved changes — held back
  // until they resolve the prompt below.
  const [pendingTab, setPendingTab] = useState<AgentSectionKey | null>(null);

  // Block route navigation away from the builder while there are unsaved edits,
  // so the same Save / Don't save prompt covers leaving the page entirely.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  const promptOpen = pendingTab !== null || blocker.state === "blocked";

  // Native warning for a hard reload / closing the tab (SPA nav is handled above).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Refuse to save/deploy while a Notifications field is invalid — a summary
  // channel with a bad number/email, or an incomplete "Text Info" detail. Surfaces
  // the first problem, jumps to the Notifications tab so the highlighted field is
  // visible, and returns false so the caller aborts.
  const guardContactDetails = useCallback((): boolean => {
    const errs = automationContactErrors(config.automations);
    if (errs.length === 0) return true;
    setActive("automations");
    toast.error("Fix the highlighted issues before saving", {
      description: errs[0],
    });
    return false;
  }, [config.automations]);

  // Deploy to the live Vapi agent only when the user explicitly saves — never
  // automatically while they're still editing.
  async function handleSave() {
    if (saving) return;
    if (!guardContactDetails()) return;
    setSaving(true);
    await save();
    setSaving(false);
  }

  // Carry out whatever the user was trying to do when the prompt interrupted them.
  const proceed = useCallback(() => {
    if (pendingTab) {
      setActive(pendingTab);
      setPendingTab(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (blocker.state === "blocked") {
      blocker.proceed();
    }
  }, [pendingTab, blocker]);

  function cancelPrompt() {
    setPendingTab(null);
    if (blocker.state === "blocked") {
      blocker.reset();
    }
  }

  // "Don't save" — throw away the unsaved edits (restore last-saved config), then continue.
  function discardThenProceed() {
    if (saving) return;
    revert();
    proceed();
  }

  // "Save changes" — deploy the edits to the live agent, then continue what the
  // user was doing. save() swallows failures (toasts + keeps dirty), so gate the
  // proceed on the flag clearing: if it's still dirty the save failed, so stay
  // on the prompt and don't navigate away with unsaved edits.
  async function saveThenProceed() {
    if (saving) return;
    // Invalid contact details block the save: close the prompt and surface the
    // problem on the Notifications tab instead of deploying a bad number.
    if (!guardContactDetails()) {
      cancelPrompt();
      return;
    }
    setSaving(true);
    await save();
    setSaving(false);
    if (!useAgentStore.getState().dirty) proceed();
  }

  // Request a tab change. With unsaved edits we stop and ask first; otherwise switch.
  function requestTab(key: AgentSectionKey) {
    if (key === active) return;
    if (dirty) {
      setPendingTab(key);
      return;
    }
    setActive(key);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const assistantName = config.identity.assistantName || "Your assistant";

  // Drives the Prev / Next step navigation below the rail.
  const activeIndex = SECTIONS.findIndex((s) => s.key === active);
  const prevSection = activeIndex > 0 ? SECTIONS[activeIndex - 1] : null;
  const nextSection = activeIndex < SECTIONS.length - 1 ? SECTIONS[activeIndex + 1] : null;

  // Fresh, not-yet-hydrated session (no cached profile yet) — show a skeleton
  // instead of the editor pre-filled with empty defaults.
  if (!profileId) {
    return <PageSkeleton variant="form" />;
  }

  const currentSection = SECTIONS[activeIndex];

  // Compact progress stepper for tablet & phone (below lg): tappable numbered
  // nodes + a connecting progress track, the active section title, and
  // Prev/Next. Replaces the desktop vertical rail on small screens.
  const mobileNav = (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-soft)] lg:hidden">
      <div role="tablist" aria-label="AI Brain sections" className="flex items-center">
        {SECTIONS.map((s, i) => {
          const step = i + 1;
          const isActive = active === s.key;
          const done = isSectionComplete(s.key, config);
          const isUnsaved = dirtySections.includes(s.key);
          return (
            <div key={s.key} className="flex flex-1 items-center last:flex-none">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={`Step ${step}: ${s.label}`}
                onClick={() => requestTab(s.key)}
                className={cn(
                  "relative grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold transition-all",
                  isActive
                    ? "text-white ring-2 ring-offset-2 ring-offset-card"
                    : done
                      ? "text-white"
                      : "bg-muted text-muted-foreground hover:bg-muted/70",
                )}
                style={
                  isActive
                    ? {
                        backgroundColor: `var(${s.colorVar})`,
                        ["--tw-ring-color" as string]: `color-mix(in srgb, var(${s.colorVar}) 35%, transparent)`,
                      }
                    : done
                      ? { backgroundColor: "var(--color-success)" }
                      : undefined
                }
              >
                {done && !isActive ? <Check className="size-4" /> : step}
                {isUnsaved && (
                  <span
                    className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-warning"
                    title="Unsaved changes in this section"
                  />
                )}
              </button>
              {i < SECTIONS.length - 1 && (
                <span
                  className={cn(
                    "mx-1 h-0.5 flex-1 rounded-full transition-colors",
                    i < activeIndex ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{currentSection.label}</p>
          <p className="text-xs text-muted-foreground">
            Step {activeIndex + 1} of {SECTIONS.length}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={!prevSection}
            onClick={() => prevSection && requestTab(prevSection.key)}
            aria-label="Previous section"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={!nextSection}
            onClick={() => nextSection && requestTab(nextSection.key)}
            aria-label="Next section"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header — sticky so the Save Changes / status bar stays reachable while the
          user scrolls a long section, instead of forcing a scroll back to the top.
          Sits just below the global AppHeader (h-16) on desktop; pins to the top on
          mobile where that header is hidden. --chrome-top adds the impersonation
          banner's height (0 when absent) so it clears the banner too — without it
          the bar tucked behind the banner + header stack. */}
      <div className="sticky top-[var(--chrome-top,0px)] z-30 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur md:-mx-8 md:top-[calc(var(--chrome-top,0px)+4rem)] md:px-8">
        <div className="min-w-0">
          {/* Icon + heading share one aligned row; the description sits full-width
              below on phones and tucks beside the icon again from sm up. */}
          <div className="flex items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-primary to-[#1d4ed8] text-primary-foreground shadow-[var(--shadow-soft)] sm:size-12">
              <Brain className="size-5 sm:size-6" />
            </div>
            <h1 className="text-xl font-bold leading-tight">AI Brain</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground sm:mt-1 sm:pl-[3.75rem]">
            Build {assistantName} — Save Changes to deploy it to your live agent.
          </p>
        </div>

        {/* Toolbar cluster on the right of the heading row — chips and buttons
            sit together on one line, vertically centered with the title. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* Same soft-tinted pill treatment as the unsaved-changes chip, so
                every status in the bar shares one visual language. */}
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-success-tint px-3 text-xs font-medium text-success">
              <span className="size-2 animate-pulse rounded-full bg-success" />
              Live
            </span>
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
              {saving ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Saving…
                </>
              ) : syncFailed ? (
                <>
                  <AlertCircle className="size-3.5 text-warning" /> Saved — live agent not updated. Save again to retry.
                </>
              ) : (
                <>
                  <RefreshCw className="size-3.5" />
                  Synced {lastSyncedAt ? timeAgo(lastSyncedAt) : ""}
                </>
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && !saving && (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-warning-tint px-3 text-xs font-medium text-warning">
                <span className="size-2 rounded-full border-2 border-current" />
                {dirtySections.length} unsaved change{dirtySections.length === 1 ? "" : "s"}
              </span>
            )}
            <Button onClick={handleSave} disabled={saving || (!dirty && !syncFailed)}>
              <Save className="size-4" /> Save Changes
            </Button>
          </div>
        </div>
      </div>

      {/* Vertical tab rail (left) + canvas */}
      {mobileNav}

      <div className="grid min-w-0 gap-5 lg:grid-cols-[232px_minmax(0,1fr)]">
        {/* Pins below both the global AppHeader and the now-sticky page header so
            the rail never tucks behind them when the canvas scrolls. --chrome-top
            adds the impersonation banner's height (0 when absent) so it clears that too. */}
        <aside className="hidden min-w-0 lg:block lg:sticky lg:top-[calc(var(--chrome-top,0px)+164px)] lg:self-start">
          <div
            role="tablist"
            aria-label="AI Brain sections"
            aria-orientation="vertical"
            className="flex flex-col gap-1 rounded-2xl border border-border bg-card p-2 shadow-[var(--shadow-soft)]"
          >
            {SECTIONS.map((s, i) => {
              const step = i + 1;
              const isActive = active === s.key;
              const isUnsaved = dirtySections.includes(s.key);
              const done = isSectionComplete(s.key, config);
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => requestTab(s.key)}
                  className={cn(
                    "group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                    isActive ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  {/* active accent bar on the left edge */}
                  {isActive && (
                    <span
                      className="absolute inset-y-2 left-0 w-0.5 rounded-full"
                      style={{ backgroundColor: `var(${s.colorVar})` }}
                    />
                  )}
                  {/* numbered step badge */}
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors",
                      isActive ? "text-white" : "bg-muted/60 text-foreground",
                    )}
                    style={isActive ? { backgroundColor: `var(${s.colorVar})` } : undefined}
                  >
                    {step}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-sm font-semibold leading-tight",
                        isActive ? "text-foreground" : "text-foreground/80",
                      )}
                    >
                      {s.label}
                    </span>
                    <span className="hidden truncate text-xs text-muted-foreground lg:block">{s.blurb}</span>
                  </span>
                  {isUnsaved ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                      title="Unsaved changes in this section"
                    />
                  ) : done ? (
                    <Check className="size-3.5 shrink-0 text-success" />
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Step navigation — Prev / Next, like a real multi-step form */}
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={!prevSection}
              onClick={() => prevSection && requestTab(prevSection.key)}
            >
              <ChevronLeft className="size-4" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={!nextSection}
              onClick={() => nextSection && requestTab(nextSection.key)}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Step {activeIndex + 1} of {SECTIONS.length}
          </p>

          {/* Test-call card — same action as the header's Test call button, kept
              in view under the step rail so it's always one tap away. */}
          <button
            type="button"
            onClick={openTester}
            disabled={dirty || saving}
            title={dirty || saving ? "Save your changes to enable test calls" : undefined}
            className={cn(
              "mt-3 flex w-full flex-col items-center gap-4 rounded-2xl border border-border bg-card px-4 py-8 shadow-[var(--shadow-soft)] transition-colors",
              dirty || saving
                ? "cursor-not-allowed opacity-50"
                : "hover:border-emerald-300 hover:bg-emerald-50/60 active:scale-[0.99] dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40",
            )}
          >
            <span className="grid place-items-center rounded-full bg-emerald-100/70 p-4 dark:bg-emerald-500/10">
              <span className="grid place-items-center rounded-full bg-emerald-200/60 p-3 dark:bg-emerald-500/15">
                <span className="relative grid size-16 place-items-center rounded-full bg-linear-to-b from-emerald-400 to-green-500 text-white shadow-md">
                  {!dirty && !saving && (
                    <>
                      <span aria-hidden className="call-wave motion-reduce:hidden" />
                      <span aria-hidden className="call-wave motion-reduce:hidden" style={{ animationDelay: "0.7s" }} />
                      <span aria-hidden className="call-wave motion-reduce:hidden" style={{ animationDelay: "1.4s" }} />
                    </>
                  )}
                  <PhoneCall
                    className={cn(
                      "relative size-6",
                      nudgeTester && "animate-phone-ring motion-reduce:animate-none",
                    )}
                  />
                </span>
              </span>
            </span>
            <span className="text-center">
              <span className="block text-sm font-semibold text-indigo-950 dark:text-foreground">
                Test call
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Press to check audio quality
              </span>
            </span>
          </button>
        </aside>

        {/* Canvas */}
        <section className="min-w-0">
          {active === "identity" && <IdentitySection />}
          {active === "knowledge" && <KnowledgeSection />}
          {active === "rules" && <RulesSection />}
          {active === "advanced" && <AdvancedSection onNavigate={requestTab} />}
          {active === "automations" && <AutomationsSection />}
        </section>
      </div>

      {/* Unsaved-changes prompt — fires on tab switch and on leaving the page */}
      <Dialog open={promptOpen} onOpenChange={(open) => !open && cancelPrompt()}>
        <DialogContent className="max-w-md" hideClose>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-full bg-warning-tint text-warning">
                <AlertTriangle className="size-5" />
              </div>
              <DialogTitle>Save your changes?</DialogTitle>
            </div>
            <DialogDescription className="pt-1">
              You have unsaved changes that haven't been deployed to your live agent. Save them
              before you leave, or discard them to go back to the last saved version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={cancelPrompt} disabled={saving}>
              Cancel
            </Button>
            <Button variant="outline" onClick={discardThenProceed} disabled={saving}>
              Don't save
            </Button>
            <Button onClick={saveThenProceed} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" /> Save changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
