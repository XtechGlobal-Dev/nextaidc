import { useEffect, useState } from "react";
import { Code2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { api, ApiError, type SeoScripts } from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  Admin editor for custom scripts/tags (SEO & tracking). Paste any
 *  snippet a tool gives you — Google Analytics, Tag Manager, Meta
 *  Pixel, site-verification meta tags — pick the slot, Save, done.
 *  Injected on every page load by SeoManager; no code deploy needed.
 * ------------------------------------------------------------------ */

const EMPTY: SeoScripts = { head: "", body: "", footer: "" };

const SLOTS: { key: keyof SeoScripts; label: string; hint: string; placeholder: string }[] = [
  {
    key: "head",
    label: "Head",
    hint: "Inside <head> — analytics, GTM, meta/verification tags. Most snippets say “paste in the <head>”.",
    placeholder: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>\n<script>…</script>',
  },
  {
    key: "body",
    label: "Body (start)",
    hint: "Right after <body> opens — e.g. the GTM <noscript> iframe goes here.",
    placeholder: '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXX" …></iframe></noscript>',
  },
  {
    key: "footer",
    label: "Footer (end of body)",
    hint: "Before </body> — chat widgets and anything that should load last.",
    placeholder: "<script>/* loads after everything else */</script>",
  },
];

export function SeoSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scripts, setScripts] = useState<SeoScripts>(EMPTY);

  useEffect(() => {
    let active = true;
    api.admin.seo
      .get()
      .then((r) => active && setScripts(r.scripts))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load scripts"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const filled = SLOTS.filter((s) => scripts[s.key].trim()).length;

  async function save() {
    setSaving(true);
    try {
      const r = await api.admin.seo.set(scripts);
      setScripts(r.scripts);
      toast.success("Scripts saved", {
        description: "They load on every visitor's next page load — no deploy needed.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save scripts");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <Code2 className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">SEO & Tracking Scripts</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste Google Analytics, Tag Manager, Meta Pixel or any tag — no code deploy needed.
            </p>
          </div>
        </div>
        <Badge variant={filled ? "primary" : "outline"}>
          {filled ? `${filled} slot${filled === 1 ? "" : "s"} active` : "Empty"}
        </Badge>
      </div>

      <div className="space-y-5 p-6">
        <p className="text-sm text-muted-foreground">
          Whatever you paste here is injected into every page for every visitor, exactly where you
          choose. Changes go live on the next page load. Only paste snippets from tools you trust —
          these run as real scripts on your site.
        </p>

        {loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {SLOTS.map((slot) => (
              <div key={slot.key} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    {slot.label}
                  </label>
                  <span className="text-[11px] text-muted-foreground">{slot.hint}</span>
                </div>
                <Textarea
                  rows={4}
                  spellCheck={false}
                  placeholder={slot.placeholder}
                  value={scripts[slot.key]}
                  onChange={(e) => setScripts((prev) => ({ ...prev, [slot.key]: e.target.value }))}
                  className="bg-warm font-mono text-xs leading-relaxed"
                  maxLength={20000}
                />
              </div>
            ))}

            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
