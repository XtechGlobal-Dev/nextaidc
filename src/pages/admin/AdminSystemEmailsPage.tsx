import { useEffect, useMemo, useRef, useState } from "react";
import { Mail, Pencil, Send, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import type { EmailTemplate, EmailBranding } from "@/types";
import { env } from "@/lib/env";

/** Representative values so the live preview mirrors what recipients see. */
const SAMPLE: Record<string, string> = {
  app_name: "Nexleon AI Voice",
  support_email: "support@nexleon.ai",
  user_name: "Sanant",
  user_email: "sanant@xtecglobal.com",
  code: "123456",
  expiry_minutes: "10",
  number: "+1 (555) 010-0100",
  business_suffix: " for Acme Plumbing",
  trial_minutes: "60",
  trial_days: "14",
  grace_days: "7",
  grace_until: "Jul 15, 2026",
  days_remaining: "3",
  window: "3 days",
  plan_name: "Premium",
  included_minutes: "Unlimited minutes",
  renewal_line: "Renews: Aug 1, 2026",
  threshold: "80",
  lead: "You've used 80% of your plan call minutes.",
  minutes_used: "48",
  minutes_allocated: "60",
  minutes_remaining: "12",
  cta: "Top up or upgrade your plan to keep your AI receptionist answering.",
  caller_name: "John Carter",
  summary_block: "AI summary\nCaller asked about weekend availability and left a callback number.",
  recording_block: `Recording: https://app.${env.appName}/recording/a1b2c3d4`,
  transcript_block: "Transcript\nAI: Thanks for calling. How can I help?\nCaller: I'd like to book a job.",
  password: "Temp1234!",
  permissions: "Customers (View, Edit), Calls (View)",
  old_role: "Support",
  new_role: "Manager",
  role_name: "Manager",
  login_url: `https://app.${env.appName}/login`,
  reason: "Reason: repeated policy violations",
};

function interpolate(text: string): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => SAMPLE[k] ?? "");
}

function bodyToHtml(text: string): string {
  return interpolate(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        // overflow-wrap keeps long unbroken tokens (recording URLs) inside the
        // preview pane instead of blowing the dialog out sideways.
        `<p style="margin:0 0 16px;line-height:1.6;color:#333;font-size:15px;overflow-wrap:anywhere">${p
          .split(/\n/)
          .join("<br/>")}</p>`,
    )
    .join("");
}

export default function AdminSystemEmailsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [branding, setBranding] = useState<EmailBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  // Denied controls are omitted from the DOM and handlers no-op; server enforces `emails.edit` too.
  const canEdit = useAuthStore((s) => s.hasPermission)("emails.edit");

  async function load() {
    setLoading(true);
    try {
      const r = await api.admin.emails.list();
      setTemplates(r.templates);
      setBranding(r.branding);
    } catch {
      toast.error("Couldn't load email templates");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (status === "on" && !t.enabled) return false;
      if (status === "off" && t.enabled) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.subject.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q) ||
        t.variables.join(" ").toLowerCase().includes(q)
      );
    });
  }, [templates, search, status]);

  const byCategory = useMemo(() => {
    const m = new Map<string, EmailTemplate[]>();
    for (const t of filtered) {
      if (!m.has(t.category)) m.set(t.category, []);
      m.get(t.category)!.push(t);
    }
    return [...m.entries()];
  }, [filtered]);

  async function toggle(t: EmailTemplate, enabled: boolean) {
    if (!canEdit) return;
    setTemplates((prev) => prev.map((x) => (x.key === t.key ? { ...x, enabled } : x)));
    try {
      await api.admin.emails.update(t.key, { enabled });
    } catch {
      toast.error("Couldn't update status");
      setTemplates((prev) => prev.map((x) => (x.key === t.key ? { ...x, enabled: !enabled } : x)));
    }
  }

  async function sendTest(t: EmailTemplate) {
    if (!canEdit) return;
    try {
      const r = await api.admin.emails.test(t.key);
      toast.success(`Test "${t.name}" sent to ${r.to}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send test email");
    }
  }

  return (
    <div>
      <PageHeader
        title="System Emails"
        subtitle="Platform lifecycle emails sent automatically on key events. App name and support email come from your branding settings."
      />

      {branding && <BrandingCard branding={branding} onSaved={setBranding} canEdit={canEdit} />}

      <Card className="mt-6">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search name, subject, body, variables…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="on">Enabled</SelectItem>
                <SelectItem value="off">Disabled</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">{filtered.length} emails</span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : byCategory.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No emails match.</p>
          ) : (
            byCategory.map(([category, items]) => (
              <div key={category}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {category}
                </p>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {items.map((t) => (
                    <div key={t.key} className="flex flex-wrap items-center gap-3 p-4">
                      <div className="min-w-[220px] flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{t.name}</span>
                          <Badge variant="neutral">{t.audience}</Badge>
                          {t.alwaysOn && (
                            <Badge variant="outline" className="gap-1">
                              <ShieldCheck className="size-3" /> Always on
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{t.description}</p>
                      </div>
                      <div className="hidden min-w-[220px] flex-1 md:block">
                        <p className="truncate text-sm font-medium">{interpolate(t.subject)}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {interpolate(t.body).replace(/\n+/g, " ")}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={t.enabled}
                          disabled={t.alwaysOn || !canEdit}
                          onCheckedChange={(v) => toggle(t, v)}
                        />
                        {canEdit && (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => setEditing(t)}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => sendTest(t)}>
                              <Send className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {editing && (
        <EditDialog
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setTemplates((prev) => prev.map((x) => (x.key === updated.key ? updated : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ Branding card ------------------------------ */

function BrandingCard({
  branding,
  onSaved,
  canEdit,
}: {
  branding: EmailBranding;
  onSaved: (b: EmailBranding) => void;
  canEdit: boolean;
}) {
  const [fromName, setFromName] = useState(branding.fromName);
  const [header, setHeader] = useState(branding.header);
  const [footer, setFooter] = useState(branding.footer);
  const [saving, setSaving] = useState(false);

  // `branding` is the server copy, so it's the dirty baseline.
  const dirty =
    fromName !== branding.fromName || header !== branding.header || footer !== branding.footer;

  async function save() {
    if (!canEdit) return;
    setSaving(true);
    try {
      const b = await api.admin.emails.saveBranding({ fromName, header, footer });
      onSaved(b);
      // Re-seed from the response: if the server normalised anything, the drafts would stay dirty forever.
      setFromName(b.fromName);
      setHeader(b.header);
      setFooter(b.footer);
      toast.success("Email branding saved");
    } catch {
      toast.error("Couldn't save branding");
    } finally {
      setSaving(false);
    }
  }

  // Sample unsubscribe line for the preview; the real per-recipient link is injected at send time.
  const footerPreview = footer.replace(
    /\{\{\s*unsubscribe\s*\}\}/g,
    `<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#aaa">You're receiving this because you have a ${
      fromName || env.appName
    } account. <a href="#" style="color:#888;text-decoration:underline">Unsubscribe from these emails</a>.</p>`,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" /> Header, footer &amp; from name
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="from-name">Email from name</Label>
            <Input id="from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email-header">Email header (HTML)</Label>
            <textarea
              id="email-header"
              className="min-h-24 rounded-lg border border-border bg-background p-2 font-mono text-xs"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email-footer">Email footer (HTML)</Label>
            <textarea
              id="email-footer"
              className="min-h-24 rounded-lg border border-border bg-background p-2 font-mono text-xs"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          </div>
          {canEdit && (
            <div>
              <Button variant="primary" onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save branding"}
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label>Preview</Label>
          <div className="overflow-hidden rounded-lg border border-border">
            <div dangerouslySetInnerHTML={{ __html: header }} />
            <div className="px-6 py-4 text-sm text-muted-foreground">Email content appears here…</div>
            <div dangerouslySetInnerHTML={{ __html: footerPreview }} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ Edit dialog ------------------------------ */

function EditDialog({
  template,
  onClose,
  onSaved,
}: {
  template: EmailTemplate;
  onClose: () => void;
  onSaved: (t: EmailTemplate) => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /* Same rule as the branding card: nothing to save until something differs
   * from the template this dialog was opened with. */
  const dirty = subject !== template.subject || body !== template.body;

  function insertVar(v: string) {
    const chip = `{{${v}}}`;
    const el = bodyRef.current;
    if (el && document.activeElement === el) {
      const start = el.selectionStart ?? body.length;
      const end = el.selectionEnd ?? body.length;
      setBody(body.slice(0, start) + chip + body.slice(end));
    } else {
      setSubject((s) => s + chip);
    }
  }

  async function save() {
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and body are required");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.admin.emails.update(template.key, { subject, body });
      toast.success("Template saved");
      onSaved(updated);
    } catch {
      toast.error("Couldn't save template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit “{template.name}”</DialogTitle>
          <DialogDescription>{template.description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Editor — min-w-0 lets each grid column shrink below its content's
              intrinsic width, so a long sample URL can't widen the dialog. */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tpl-body">Body</Label>
              <textarea
                id="tpl-body"
                ref={bodyRef}
                className="min-h-56 rounded-lg border border-border bg-background p-2 text-sm"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Insert variable</Label>
              <div className="flex flex-wrap gap-1.5">
                {template.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVar(v)}
                    className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs hover:bg-primary-tint hover:text-primary"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Live preview */}
          <div className="flex min-w-0 flex-col gap-2">
            <Label>Live preview (sample data)</Label>
            <div className="min-w-0 rounded-lg border border-border bg-white p-4 [overflow-wrap:anywhere]">
              <p className="mb-2 border-b border-border pb-2 text-sm font-semibold text-black">
                {interpolate(subject)}
              </p>
              <div
                className="text-black"
                dangerouslySetInnerHTML={{ __html: bodyToHtml(body) }}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
