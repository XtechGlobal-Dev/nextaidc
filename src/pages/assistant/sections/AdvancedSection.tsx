import { useState } from "react";
import {
  Maximize2,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ArrowUpRight,
  Info,
  Lock,
} from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SectionShell, FieldGroup } from "../SectionShell";
import { sectionByKey, sectionByKey as meta } from "../sectionMeta";
import { compileBlocks } from "@/lib/compilePrompt";
import { cn } from "@/lib/utils";
import type { AgentSectionKey } from "@/types";
import { toast } from "sonner";

export function AdvancedSection({ onNavigate }: { onNavigate: (key: AgentSectionKey) => void }) {
  const config = useAgentStore((s) => s.config);
  const advanced = config.advanced;
  const setMasterPrompt = useAgentStore((s) => s.setMasterPrompt);
  const regenerate = useAgentStore((s) => s.regenerateMasterPrompt);
  const syncToTemplate = useAgentStore((s) => s.syncMasterPromptToTemplate);
  const promptTemplateIsLatest = useAgentStore((s) => s.promptTemplateIsLatest);
  const adoptLatestTemplate = useAgentStore((s) => s.adoptLatestTemplate);
  const user = useAuthStore((s) => s.user);
  const impersonating = useAuthStore((s) => !!s.impersonator);
  const [adopting, setAdopting] = useState(false);
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderText, setBuilderText] = useState("");
  const [syncing, setSyncing] = useState(false);

  /**
   * Who may still write the prompt by hand.
   *
   * MIRRORS THE SERVER RULE in `lockMasterPrompt` (`role !== "USER" || imp`) and
   * must keep mirroring it. The server is what actually enforces this — nothing
   * here is a security control, since the whole config round-trips through the
   * browser — so the only job of this flag is to stop the UI offering an edit
   * the save would silently discard.
   *
   * Impersonation is included because "Login as Customer" mints a token carrying
   * the CUSTOMER's role: checking the role alone would lock support out of the
   * account they were sent to fix, on both sides at once.
   */
  const canEditPrompt = !!user && (user.role !== "USER" || impersonating);

  async function syncTemplate() {
    setSyncing(true);
    const ok = await syncToTemplate();
    setSyncing(false);
    if (ok) {
      toast.success("Master prompt synced to the latest template", {
        description: "Review it below, then Save Changes to deploy it to your live agent.",
      });
    } else {
      toast.error("Couldn't fetch the latest template — try again in a moment.");
    }
  }

  function generateFromDescription() {
    const desc = builderText.trim();
    if (!desc) {
      toast.error("Tell us a little about your business first.");
      return;
    }
    const addition = [
      "\n## BUSINESS CONTEXT",
      desc,
      "\nUse the above context to answer caller questions accurately, stay on-brand, and route or capture leads appropriately.",
    ].join("\n");
    const next = `${advanced.masterPrompt.trimEnd()}\n${addition}`;
    setMasterPrompt(next);
    setBuilderOpen(false);
    setBuilderText("");
    toast.success("Added to your master prompt", {
      description: "Generated from your business description.",
    });
  }

  const blocks = compileBlocks(config);

  const promptCounter = (
    <div className="mt-2 flex justify-end text-xs">
      <span className="text-muted-foreground">{advanced.masterPrompt.length} characters</span>
    </div>
  );

  /**
   * The prompt editor, read-only for customers.
   *
   * The copy guards (no selection, no copy/cut/context-menu) are a speed bump,
   * NOT a control: the prompt is in the DOM and in the API response, so anyone
   * who opens devtools can still read it. They only stop it being lifted
   * casually. The edit lock does not depend on them — that lives on the server.
   */
  const promptEditor = (className: string) =>
    canEditPrompt ? (
      <Textarea
        className={className}
        value={advanced.masterPrompt}
        onChange={(e) => setMasterPrompt(e.target.value)}
      />
    ) : (
      <Textarea
        readOnly
        aria-readonly
        spellCheck={false}
        className={cn(className, "cursor-default select-none bg-muted/40")}
        value={advanced.masterPrompt}
        onCopy={(e) => e.preventDefault()}
        onCut={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      />
    );

  return (
    <SectionShell meta={sectionByKey("advanced")}>
      <FieldGroup
        title="Master Prompt"
        description={
          canEditPrompt
            ? "Auto-assembled from your settings. Edit freely, or regenerate from the sections."
            : "Assembled from your settings — read-only. Change it by editing the sections below."
        }
        action={
          <div className="flex flex-wrap gap-2">
            {/* Both of these write straight into the prompt, so for a customer
                they would be buttons the save silently discards. */}
            {canEditPrompt && (
              <>
                <Button size="sm" variant="outline" onClick={syncTemplate} disabled={syncing}>
                  <RefreshCw className={cn("size-4", syncing && "animate-spin")} /> Sync Template
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBuilderOpen(true)}>
                  <Sparkles className="size-4" /> Help Me Build My Agent
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => setFullscreen(true)}>
              <Maximize2 className="size-4" /> Full Screen
            </Button>
          </div>
        }
      >
        {!promptTemplateIsLatest && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary-tint-soft p-3 text-sm text-foreground/80">
            <span className="flex items-center gap-2">
              <Info className="size-4 text-primary" />
              A newer prompt template is available from your admin.
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={adopting}
              onClick={() => setConfirmAdopt(true)}
            >
              <RefreshCw className={`size-4${adopting ? " animate-spin" : ""}`} /> Update to Latest
            </Button>
          </div>
        )}
        {!canEditPrompt && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            This is your live prompt, built from the settings in the steps before this one. Edit
            those and it updates here.
          </div>
        )}
        {advanced.masterPromptDirty &&
          (canEditPrompt ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-tint p-3 text-sm text-foreground/80">
              <span className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-warning" />
                Manually edited — auto-sync from your settings is paused.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  regenerate();
                  toast.success("Master prompt regenerated from your settings");
                }}
              >
                <RefreshCw className="size-4" /> Regenerate
              </Button>
            </div>
          ) : (
            // Same fact, minus the Regenerate button the server would ignore. The
            // notice stays, because a customer whose settings no longer reach
            // their prompt deserves to know why.
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-warning-tint p-3 text-sm text-foreground/80">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              This prompt was customised for you, so it no longer updates automatically from your
              settings. Contact support if you need it changed.
            </div>
          ))}
        {promptEditor("min-h-[260px] font-mono text-xs leading-relaxed")}
        {promptCounter}
      </FieldGroup>

      <FieldGroup
        title="Preview blocks"
        description="These sections are compiled from your settings into the prompt above."
      >
        <div className="space-y-3">
          {blocks.map((b, i) => (
            <div key={`${b.label}-${i}`} className="rounded-lg border border-border bg-warm p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant="outline" className="uppercase tracking-wide">
                  {b.label}
                </Badge>
                <button
                  onClick={() => onNavigate(b.section)}
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Edit in {meta(b.section).label}
                  <ArrowUpRight className="size-3" />
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs text-foreground/80">{b.body}</pre>
            </div>
          ))}
        </div>
      </FieldGroup>

      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Help Me Build My Agent</DialogTitle>
            <DialogDescription>
              Describe your business and we'll add tailored context to your master prompt.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            className="min-h-[160px]"
            placeholder="Describe your business… e.g. We're a mobile mechanic in Sydney offering on-site servicing, brake repairs and pre-purchase inspections. We book jobs Mon–Sat and quote on site."
            value={builderText}
            onChange={(e) => setBuilderText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuilderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={generateFromDescription}>
              <Sparkles className="size-4" /> Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmAdopt} onOpenChange={setConfirmAdopt}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Prompt Template</DialogTitle>
            <DialogDescription>
              This will update your prompt scaffold to the latest version. Your services, FAQs, and rules will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAdopt(false)}>
              Cancel
            </Button>
            <Button
              disabled={adopting}
              onClick={async () => {
                setAdopting(true);
                await adoptLatestTemplate();
                setAdopting(false);
                setConfirmAdopt(false);
              }}
            >
              {adopting ? <RefreshCw className="size-4 animate-spin" /> : null}
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Master Prompt</DialogTitle>
          </DialogHeader>
          {/* The same editor, under the same rule — a second, always-editable
              textarea here was a way straight round the lock on the one above. */}
          {promptEditor("min-h-[60vh] font-mono text-xs leading-relaxed")}
          {promptCounter}
        </DialogContent>
      </Dialog>
    </SectionShell>
  );
}
