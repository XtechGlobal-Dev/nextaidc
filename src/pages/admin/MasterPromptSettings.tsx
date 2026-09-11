import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, RotateCcw, FileText, Eye, EyeOff, AlertTriangle, History } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/utils";

type TemplateVersion = {
  id: number;
  template: string;
  isDefault: boolean;
  chars: number;
  replacedAt: string;
  replacedBy: string;
};

/**
 * Admin editor for the global master-prompt scaffold. The text here wraps every
 * customer's assistant prompt; two placeholders are filled per customer at
 * compile time: {{businessName}} and {{sections}} (the customer's identity,
 * services, FAQs and rules). Saving affects each customer's live assistant the
 * next time their AI Brain is saved/synced (prompts they've manually edited are
 * left untouched).
 */
export function MasterPromptSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [serverDefault, setServerDefault] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setExpandedVersion(null);
    try {
      const r = await api.admin.promptTemplate.history();
      setVersions(r.versions);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to load version history");
    } finally {
      setHistoryLoading(false);
    }
  }

  function restoreVersion(v: TemplateVersion) {
    // Load into the editor only — the admin reviews it and presses Save to apply.
    setDraft(v.template.trim() ? v.template : serverDefault);
    setHistoryOpen(false);
    toast.success("Version loaded into the editor", {
      description: "Review it, then press Save to make it the live template.",
    });
  }

  useEffect(() => {
    let active = true;
    api.admin.promptTemplate
      .get()
      .then((r) => {
        if (!active) return;
        setServerDefault(r.default);
        setIsDefault(r.isDefault);
        setPreview(r.preview);
        // Show the effective template so the admin edits the real thing — fall
        // back to the built-in default text when no override is saved yet.
        setDraft(r.template.trim() ? r.template : r.default);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load prompt template"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // All three placeholders are mandatory in a custom template — without them a
  // customer's assistant name / business name / knowledge would vanish from every
  // prompt. The server rejects a save missing any; we mirror that here to block early.
  const missing = useMemo(() => {
    const m: string[] = [];
    if (!/\{\{\s*assistantName\s*\}\}/i.test(draft)) m.push("{{assistantName}}");
    if (!/\{\{\s*businessName\s*\}\}/i.test(draft)) m.push("{{businessName}}");
    if (!/\{\{\s*sections\s*\}\}/i.test(draft)) m.push("{{sections}}");
    return m;
  }, [draft]);
  // "Unchanged from default" → saving is a no-op; still allowed, but we badge it.
  const equalsDefault = draft.trim() === serverDefault.trim();

  async function save(template: string) {
    setSaving(true);
    try {
      const r = await api.admin.promptTemplate.set(template);
      setServerDefault(r.default);
      setIsDefault(r.isDefault);
      setPreview(r.preview);
      setDraft(r.template.trim() ? r.template : r.default);
      toast.success(
        r.isDefault ? "Reset to the built-in default template" : "Master prompt template saved",
        { description: "New saves/syncs of each customer's AI Brain will use it." },
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <FileText className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Master Prompt Template</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The scaffold wrapped around every assistant's prompt.
            </p>
          </div>
        </div>
        {isDefault ? (
          <Badge variant="outline">Using default</Badge>
        ) : (
          <Badge variant="primary">Custom</Badge>
        )}
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          Edit the shared prompt scaffold. Placeholders are filled in per customer when their
          assistant is built:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{"{{assistantName}}"}</code>,{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{"{{businessName}}"}</code> and{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{"{{sections}}"}</code> (the
          customer's identity, services, FAQs and rules). Changes reach a customer's live assistant
          the next time their AI Brain is saved or synced. Assistants whose prompt was manually
          edited are left untouched.
        </p>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {missing.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-danger-tint p-3 text-sm text-foreground/80">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                <span>
                  {missing.map((m, i) => (
                    <span key={m}>
                      {i > 0 && " and "}
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">{m}</code>
                    </span>
                  ))}{" "}
                  {missing.length > 1 ? "are" : "is"} required and must stay in the template —
                  {missing.length > 1 ? " they insert" : " it inserts"} each customer's business name
                  and knowledge. Add {missing.length > 1 ? "them" : "it"} back to save, or use{" "}
                  <strong>Reset to default</strong>.
                </span>
              </div>
            )}

            <Textarea
              className="min-h-[340px] font-mono text-xs leading-relaxed"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {draft.length} characters{equalsDefault && " · unchanged from default"}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={openHistory}>
                  <History className="size-4" /> History
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  {showPreview ? "Hide preview" : "Preview"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft(serverDefault)}
                  disabled={saving || equalsDefault}
                  title="Load the built-in default into the editor"
                >
                  <FileText className="size-4" /> Load default
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger-tint hover:text-danger"
                  onClick={() => save("")}
                  disabled={saving || isDefault}
                  title="Clear the override and revert to the built-in default"
                >
                  <RotateCcw className="size-4" /> Reset to default
                </Button>
                <Button
                  size="sm"
                  onClick={() => save(draft)}
                  disabled={saving || missing.length > 0}
                  title={missing.length > 0 ? `Add ${missing.join(" and ")} to save` : undefined}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save
                </Button>
              </div>
            </div>

            {showPreview && (
              <div className="rounded-lg border border-border bg-warm p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Preview (sample business "Acme Plumbing" with default sections)
                </p>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground/80">
                  {preview}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  Save to refresh this preview against your latest edits.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Template version history</DialogTitle>
            <DialogDescription>
              Every save or reset stores the version it replaced — restore any of them if a change
              was made by mistake. Restoring loads it into the editor; press Save to apply.
            </DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : versions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No previous versions yet — they'll appear here after the next save or reset.
            </p>
          ) : (
            <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
              {versions.map((v) => (
                <div key={v.id} className="rounded-lg border border-border bg-warm p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {formatDate(v.replacedAt)}
                        {v.isDefault && (
                          <Badge variant="outline" className="ml-2">
                            Built-in default
                          </Badge>
                        )}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {v.chars.toLocaleString()} characters
                        {v.replacedBy && <> · replaced by {v.replacedBy}</>}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setExpandedVersion(expandedVersion === v.id ? null : v.id)}
                      >
                        <Eye className="size-4" /> {expandedVersion === v.id ? "Hide" : "View"}
                      </Button>
                      <Button size="sm" onClick={() => restoreVersion(v)}>
                        <RotateCcw className="size-4" /> Restore
                      </Button>
                    </div>
                  </div>
                  {expandedVersion === v.id && (
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground/80">
                      {v.template.trim() || serverDefault}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
