import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Mic,
  Pencil,
  Trash2,
  Plus,
  Play,
  Pause,
  Check,
  X,
  Search,
  Library,
  AudioLines,
  Layers,
  AlertCircle,
  Package,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  api,
  ApiError,
  type VoiceCategory,
  type ProviderVoice,
  type AllVoicesResponse,
  type SubscriptionPlan,
} from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { VoiceGenderBadge } from "@/components/VoiceGenderBadge";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { useAuthStore } from "@/stores/useAuthStore";
import { cn } from "@/lib/utils";

type ProviderKey = "deepgram" | "elevenlabs";

/** Per-provider display meta — short tag + tinted colour used on every chip/badge. */
const PROVIDER: Record<
  ProviderKey,
  { label: string; short: string; badge: string; dot: string; hex: string }
> = {
  deepgram: {
    label: "Deepgram",
    short: "DG",
    badge: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    hex: "#0ea5e9",
  },
  elevenlabs: {
    label: "ElevenLabs",
    short: "11L",
    badge: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
    hex: "#8b5cf6",
  },
};

export default function AdminVoiceBankPage() {
  const [categories, setCategories] = useState<VoiceCategory[] | null>(null);
  const [catalogs, setCatalogs] = useState<AllVoicesResponse | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VoiceCategory | null>(null);
  const [title, setTitle] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  // Which provider's voices the picker is currently showing (tabbed, not stacked).
  const [activeProvider, setActiveProvider] = useState<ProviderKey>("deepgram");
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<VoiceCategory | null>(null);
  const { playingId, toggle, stop: stopPreview } = useVoicePreview();
  /** Preview a voice in its own language, surfacing why if it won't play (an id the
   *  ElevenLabs key can't reach is otherwise just silence). */
  const togglePreview = (
    v: { id: string; name: string; language?: string; gender?: "male" | "female" | null },
    provider?: "deepgram" | "elevenlabs",
  ) =>
    toggle(v.id, provider, {
      language: v.language,
      gender: v.gender,
      onError: (message) => toast.error(`${v.name}: ${message}`),
    });

  // Capability gates — ADMIN passes all; STAFF only where the role grants it.
  // Buttons are omitted from the DOM entirely (not just hidden) when denied, and
  // the mutating handlers below no-op as a defensive backstop.
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canCreate = hasPermission("voice_bank.create");
  const canEdit = hasPermission("voice_bank.edit");
  const canDelete = hasPermission("voice_bank.delete");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [cats, all, pls] = await Promise.all([
          api.admin.voiceCategories.list(),
          api.voices.listAll().catch(() => ({ deepgram: [], elevenlabs: [] })),
          api.admin.plans.list().catch(() => [] as SubscriptionPlan[]),
        ]);
        if (!active) return;
        setCategories(cats);
        setCatalogs(all);
        setPlans(pls);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load Voice Library");
        if (active) setCategories([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // All voices keyed by id (both providers) — for rendering a category's chips.
  const voiceById = useMemo(() => {
    const map = new Map<string, ProviderVoice & { provider: ProviderKey }>();
    for (const v of catalogs?.deepgram ?? []) map.set(v.id, { ...v, provider: "deepgram" });
    for (const v of catalogs?.elevenlabs ?? []) map.set(v.id, { ...v, provider: "elevenlabs" });
    return map;
  }, [catalogs]);

  // categoryId → plans that unlock it (so each card can show where it's used).
  const plansByCategory = useMemo(() => {
    const map = new Map<string, SubscriptionPlan[]>();
    for (const p of plans) {
      if (!p.voiceCategoryId) continue;
      (map.get(p.voiceCategoryId) ?? map.set(p.voiceCategoryId, []).get(p.voiceCategoryId)!).push(p);
    }
    return map;
  }, [plans]);

  const catalogCount = (catalogs?.deepgram.length ?? 0) + (catalogs?.elevenlabs.length ?? 0);
  const curatedCount = useMemo(
    () => (categories ?? []).reduce((n, c) => n + c.voiceIds.length, 0),
    [categories],
  );

  // Provider sections for the modal multi-select (grouped by accent/region),
  // filtered live by the search query (name / descriptor / region / gender).
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (v: ProviderVoice) =>
      !q ||
      v.name.toLowerCase().includes(q) ||
      v.descriptor.toLowerCase().includes(q) ||
      v.region.toLowerCase().includes(q) ||
      (v.gender ?? "").includes(q);
    const build = (provider: ProviderKey, list: ProviderVoice[]) => {
      const groups: Record<string, ProviderVoice[]> = {};
      for (const v of list.filter(match)) (groups[v.region] ??= []).push(v);
      const ids = Object.values(groups).flat().map((v) => v.id);
      return { provider, groups, ids, count: ids.length };
    };
    return {
      deepgram: build("deepgram", catalogs?.deepgram ?? []),
      elevenlabs: build("elevenlabs", catalogs?.elevenlabs ?? []),
    };
  }, [catalogs, query]);

  // Providers that actually have voices in the catalog — drives the picker tabs.
  const providersAvailable = useMemo(() => {
    const list: ProviderKey[] = [];
    if ((catalogs?.deepgram.length ?? 0) > 0) list.push("deepgram");
    if ((catalogs?.elevenlabs.length ?? 0) > 0) list.push("elevenlabs");
    return list;
  }, [catalogs]);

  // Fall back to the first available provider if the active one has no voices.
  const active = providersAvailable.includes(activeProvider)
    ? activeProvider
    : providersAvailable[0];
  const activeSection = active ? sections[active] : null;

  function openCreate() {
    if (!canCreate) return;
    setEditing(null);
    setTitle("");
    setSelectedIds([]);
    setQuery("");
    setDialogOpen(true);
  }

  function openEdit(cat: VoiceCategory) {
    if (!canEdit) return;
    setEditing(cat);
    setTitle(cat.title);
    setSelectedIds(cat.voiceIds);
    setQuery("");
    setDialogOpen(true);
  }

  function toggleVoice(id: string) {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]));
  }

  // Select / clear every (currently visible) voice for one provider at once.
  function toggleProvider(ids: string[], allSelected: boolean) {
    setSelectedIds((cur) =>
      allSelected ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])],
    );
  }

  async function save() {
    if (editing ? !canEdit : !canCreate) return;
    const t = title.trim();
    if (!t) {
      toast.error("Give the category a name");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await api.admin.voiceCategories.update(editing.id, t, selectedIds);
        setCategories((c) => (c ?? []).map((x) => (x.id === updated.id ? updated : x)));
        toast.success("Category updated");
      } else {
        const created = await api.admin.voiceCategories.create(t, selectedIds);
        setCategories((c) => [...(c ?? []), created]);
        toast.success("Category created");
      }
      stopPreview();
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save category");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!toDelete || !canDelete) return;
    await api.admin.voiceCategories.remove(toDelete.id);
    setCategories((c) => (c ?? []).filter((x) => x.id !== toDelete.id));
    toast.success("Category deleted");
  }

  if (categories === null) {
    return <VoiceLibrarySkeleton />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Voice Library"
        subtitle="Curate Deepgram + ElevenLabs voices into named categories, then unlock a category per plan."
        actions={
          canCreate ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" /> Add category
            </Button>
          ) : undefined
        }
      />

      {/* At-a-glance stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard icon={<Layers className="size-4" />} label="Categories" value={categories.length} />
        <StatCard icon={<AudioLines className="size-4" />} label="Voices curated" value={curatedCount} />
        <StatCard
          icon={<Library className="size-4" />}
          label="Available in catalog"
          value={catalogCount}
          hint={
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className={cn("size-1.5 rounded-full", PROVIDER.deepgram.dot)} />
                {catalogs?.deepgram.length ?? 0} DG
              </span>
              <span className="inline-flex items-center gap-1">
                <span className={cn("size-1.5 rounded-full", PROVIDER.elevenlabs.dot)} />
                {catalogs?.elevenlabs.length ?? 0} 11L
              </span>
            </span>
          }
        />
      </div>

      {categories.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-primary to-[#1d4ed8] text-primary-foreground shadow-[var(--shadow-soft)]">
            <Mic className="size-7" />
          </span>
          <div>
            <p className="text-base font-semibold">No voice categories yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Group your best Deepgram &amp; ElevenLabs voices into a category, then attach it to a
              plan so those customers can pick from it.
            </p>
          </div>
          {canCreate && (
            <Button onClick={openCreate} className="mt-1">
              <Plus className="size-4" /> Create your first category
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {categories.map((cat) => {
            const voices = cat.voiceIds
              .map((id) => voiceById.get(id))
              .filter((v): v is ProviderVoice & { provider: ProviderKey } => Boolean(v));
            const dg = voices.filter((v) => v.provider === "deepgram").length;
            const el = voices.filter((v) => v.provider === "elevenlabs").length;
            const total = dg + el;
            const assignedPlans = plansByCategory.get(cat.id) ?? [];
            return (
              <Card
                key={cat.id}
                className="group flex flex-col gap-4 p-5 transition-shadow hover:shadow-[var(--shadow-panel)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-[#1d4ed8] text-primary-foreground shadow-[var(--shadow-soft)]">
                      <Mic className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold leading-tight">{cat.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {cat.voiceIds.length} voice{cat.voiceIds.length === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                  {(canEdit || canDelete) && (
                    <div className="flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      {canEdit && (
                        <Button variant="ghost" size="icon" onClick={() => openEdit(cat)} aria-label="Edit">
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger hover:bg-danger-tint hover:text-danger"
                          onClick={() => setToDelete(cat)}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* Provider composition — a compact donut with the total in the
                    centre + a labelled legend. A thin ring (not a solid pie) so it
                    reads clearly even at 100% one provider without dominating the card. */}
                {total > 0 && (
                  <div className="flex items-center gap-4">
                    <VoiceDonut dg={dg} el={el} />
                    <div className="flex flex-col gap-2 text-xs">
                      {dg > 0 && (
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <span className={cn("size-2.5 rounded-full", PROVIDER.deepgram.dot)} />
                          Deepgram
                          <span className="font-semibold text-foreground">{dg}</span>
                          <span className="text-muted-foreground/60">
                            {Math.round((dg / total) * 100)}%
                          </span>
                        </span>
                      )}
                      {el > 0 && (
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <span className={cn("size-2.5 rounded-full", PROVIDER.elevenlabs.dot)} />
                          ElevenLabs
                          <span className="font-semibold text-foreground">{el}</span>
                          <span className="text-muted-foreground/60">
                            {Math.round((el / total) * 100)}%
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Voice chips — click to preview */}
                <div className="flex flex-wrap gap-1.5">
                  {voices.length === 0 ? (
                    <span className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                      No voices yet — edit to add some.
                    </span>
                  ) : (
                    cat.voiceIds.map((id) => {
                      const v = voiceById.get(id);
                      const meta = v ? PROVIDER[v.provider] : null;
                      const playing = playingId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => v && togglePreview(v, v.provider)}
                          disabled={!v}
                          title={v ? `Preview ${v.name}` : id}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs transition-colors",
                            playing
                              ? "border-primary bg-primary-tint text-primary"
                              : "border-border bg-card hover:border-primary/40 hover:bg-muted",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-5 place-items-center rounded-full transition-colors",
                              playing
                                ? cn(meta?.dot, "text-white")
                                : meta?.badge ?? "bg-muted text-muted-foreground",
                            )}
                          >
                            {playing ? <Pause className="size-2.5" /> : <Play className="size-2.5" />}
                          </span>
                          <span className="font-medium">{v?.name ?? id}</span>
                          <VoiceGenderBadge gender={v?.gender} />
                          {meta && (
                            <span
                              className={cn(
                                "rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide",
                                meta.badge,
                              )}
                            >
                              {meta.short}
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>

                {/* Where this category is used */}
                <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-xs">
                  {assignedPlans.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">Unlocked by</span>
                      {assignedPlans.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex items-center gap-1 rounded-full bg-success-tint px-2 py-0.5 font-medium text-success"
                        >
                          <Package className="size-3" />
                          {p.displayName || p.name}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-warning">
                      <AlertCircle className="size-3.5" />
                      Not attached to any plan yet
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (saving) return;
          if (!o) stopPreview();
          setDialogOpen(o);
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
            <DialogDescription>
              Name the category and pick the voices it includes — from either provider.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="vc-title">Category name</Label>
              <Input
                id="vc-title"
                placeholder="e.g. Premium voices"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Voices</Label>
                <span className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{selectedIds.length}</span> selected
                </span>
              </div>

              {/* Provider selector — pick a provider, then choose its voices */}
              {providersAvailable.length > 1 && (
                <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
                  {providersAvailable.map((p) => {
                    const meta = PROVIDER[p];
                    const isActive = active === p;
                    const catCount = catalogs?.[p].length ?? 0;
                    const selCount = (catalogs?.[p] ?? []).filter((v) =>
                      selectedIds.includes(v.id),
                    ).length;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setActiveProvider(p)}
                        className={cn(
                          "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground shadow-[var(--shadow-soft)]"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <span className={cn("size-2 rounded-full", meta.dot)} />
                        {meta.label}
                        {/* Both of these have to follow the tab's state. The
                            active tab paints itself `bg-primary`, so the muted
                            grey the count used unconditionally came out barely
                            legible on it — and the selected-count badge was
                            `text-primary` on that same blue, i.e. invisible,
                            reading as an empty gap beside the label. */}
                        <span className={cn(isActive ? "text-primary-foreground/70" : "text-muted-foreground")}>
                          ({catCount})
                        </span>
                        {selCount > 0 && (
                          <span
                            className={cn(
                              "ml-0.5 rounded-full px-1.5 text-[10px] font-semibold",
                              isActive
                                ? "bg-primary-foreground/20 text-primary-foreground"
                                : "bg-primary/15 text-primary",
                            )}
                          >
                            {selCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Search */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search voices…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/30 p-1.5">
                {!activeSection || activeSection.count === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {providersAvailable.length === 0
                      ? "No voices available. Configure the Deepgram or ElevenLabs API key in Admin → Settings."
                      : query.trim()
                        ? "No voices match your search."
                        : "No voices from this provider."}
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-2 pb-1.5 pt-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {activeSection.count} voice{activeSection.count === 1 ? "" : "s"}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          toggleProvider(
                            activeSection.ids,
                            activeSection.ids.every((id) => selectedIds.includes(id)),
                          )
                        }
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        {activeSection.ids.every((id) => selectedIds.includes(id))
                          ? "Clear all"
                          : "Select all"}
                      </button>
                    </div>
                    {Object.entries(activeSection.groups).map(([region, list]) => (
                      <div key={region} className="mb-1 last:mb-0">
                        <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {region}
                        </p>
                        <div className="space-y-1">
                        {list.map((v) => {
                          const selected = selectedIds.includes(v.id);
                          const playing = playingId === v.id;
                          return (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => toggleVoice(v.id)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                selected ? "bg-primary-tint" : "hover:bg-muted",
                              )}
                            >
                              <span
                                role="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePreview(v, active);
                                }}
                                className={cn(
                                  "grid size-6 shrink-0 place-items-center rounded-full transition-colors",
                                  playing
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-primary-tint text-primary hover:bg-primary hover:text-primary-foreground",
                                )}
                                aria-label={`Preview ${v.name}`}
                              >
                                {playing ? (
                                  <Pause className="size-3 animate-pulse" />
                                ) : (
                                  <Play className="size-3" />
                                )}
                              </span>
                              <span className="font-medium">{v.name}</span>
                              <span className="truncate text-muted-foreground">· {v.descriptor}</span>
                              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                <VoiceGenderBadge gender={v.gender} />
                                <span
                                  className={cn(
                                    "grid size-4 shrink-0 place-items-center rounded border",
                                    selected
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border",
                                  )}
                                >
                                  {selected && <Check className="size-3" />}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              <X className="size-4" /> Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {editing ? "Save changes" : "Create category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="voice category"
        resourceName={toDelete?.title ?? ""}
        onConfirm={remove}
        description="Plans using this category will fall back to the default voice."
      />
    </div>
  );
}

/** Loading placeholder that mirrors the real page: header, stat row, category cards. */
function VoiceLibrarySkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <Skeleton className="h-10 w-36 rounded-xl" />
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-10" />
              <Skeleton className="h-3 w-24" />
            </div>
          </Card>
        ))}
      </div>

      {/* Category cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 shrink-0 rounded-xl" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <div className="flex gap-1">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Skeleton className="size-14 shrink-0 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={j} className="h-7 w-24 rounded-full" />
              ))}
            </div>

            <div className="mt-auto border-t border-border pt-3">
              <Skeleton className="h-4 w-40" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * Compact donut of the Deepgram vs ElevenLabs split with the total voice count in
 * the centre. A thin ring (not a solid pie) so it stays legible even at 100% one
 * provider. The arcs sweep in on mount (Deepgram first, then ElevenLabs).
 */
function VoiceDonut({ dg, el, size = 56 }: { dg: number; el: number; size?: number }) {
  const total = dg + el;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // r chosen so the circumference ≈ 100 → dasharray lengths read as percentages.
  const R = 15.9155;
  const C = 2 * Math.PI * R;
  const dgPct = total ? (dg / total) * 100 : 0;
  const elPct = total ? (el / total) * 100 : 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90">
        <circle cx="18" cy="18" r={R} fill="none" stroke="var(--color-muted)" strokeWidth="3.5" />
        {dg > 0 && (
          <circle
            cx="18"
            cy="18"
            r={R}
            fill="none"
            stroke={PROVIDER.deepgram.hex}
            strokeWidth="3.5"
            strokeDasharray={`${shown ? dgPct : 0} ${C}`}
            style={{ transition: "stroke-dasharray 0.7s cubic-bezier(0.4,0,0.2,1)" }}
          />
        )}
        {el > 0 && (
          <circle
            cx="18"
            cy="18"
            r={R}
            fill="none"
            stroke={PROVIDER.elevenlabs.hex}
            strokeWidth="3.5"
            strokeDasharray={`${shown ? elPct : 0} ${C}`}
            strokeDashoffset={`${-dgPct}`}
            style={{ transition: "stroke-dasharray 0.7s cubic-bezier(0.4,0,0.2,1) 0.35s" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-sm font-bold leading-none">{total}</span>
      </div>
    </div>
  );
}

/** Compact metric tile for the header stat row. */
function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: React.ReactNode;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{label}</p>
        {hint}
      </div>
    </Card>
  );
}
