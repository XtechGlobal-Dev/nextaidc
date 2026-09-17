import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Mail,
  Palette,
  Power,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  UserCog,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError, type Brand, type BrandStatus, type BrandThemeCatalog } from "@/lib/api";
import { BrandDatabaseCard } from "./BrandDatabaseCard";
import { BrandThemeSection, type ThemeDraft } from "./BrandThemeSection";
import { BrandMessagingSection } from "./BrandMessagingSection";
import { BrandAssetsSection } from "./BrandAssetsSection";
import { BrandAdminsSection } from "./BrandAdminsSection";
import { BrandDepartmentsSection } from "./BrandDepartmentsSection";
import { BrandAccessSection, BrandLocaleFields } from "./BrandAccessSection";
import { BrandContentSection } from "./BrandContentSection";
import { BrandReadinessCard } from "./BrandReadinessCard";
import { BrandPricingTab } from "./BrandPricingTab";
import { BLANK_SETUP, setupFrom, setupPayload, type SetupDraft } from "./brandSetupDraft";
import { BrandDomainSection } from "./BrandDomainSection";
import { BrandInsideTab } from "./BrandInsideTab";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { brandStatusLabel, brandStatusVariant, formatDeletesAt } from "./brandStatus";

interface Draft extends ThemeDraft, SetupDraft {
  name: string;
  slug: string;
  customDomain: string;
  status: BrandStatus;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
}

const BLANK: Draft = {
  name: "",
  slug: "",
  customDomain: "",
  status: "active",
  tagline: "",
  supportEmail: "",
  supportPhone: "",
  themePreset: "ocean",
  primaryColor: "#2c76ed",
  accentColor: "#7c5cfc",
  fontFamily: "inter",
  darkModeDefault: false,
  ...BLANK_SETUP,
};

function draftFrom(b: Brand): Draft {
  return {
    name: b.name,
    slug: b.slug,
    customDomain: b.customDomain ?? "",
    status: b.status,
    tagline: b.tagline,
    supportEmail: b.supportEmail,
    supportPhone: b.supportPhone,
    themePreset: b.themePreset,
    primaryColor: b.primaryColor,
    accentColor: b.accentColor,
    fontFamily: b.fontFamily,
    darkModeDefault: b.darkModeDefault,
    ...setupFrom(b),
  };
}

type SlugState = { checking: boolean; available: boolean | null; reason: string; url: string };

/** Edit one white-label brand. Tabbed because the pieces move independently once it exists; creation is AdminBrandCreatePage. */
export default function AdminBrandDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [brand, setBrand] = useState<Brand | null>(null);
  const [catalog, setCatalog] = useState<BrandThemeCatalog | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Lifecycle: deactivate (off now, deleted in 30 days), reactivate, or delete now.
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A link may open a particular tab (the platform overview and the directory
  // send people straight to what is inside the brand).
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => searchParams.get("tab") || "brand");

  const [slugState, setSlugState] = useState<SlugState>({
    checking: false,
    available: null,
    reason: "",
    url: "",
  });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [cat, existing] = await Promise.all([
          api.super.brands.catalog(),
          id ? api.super.brands.get(id) : Promise.resolve(null),
        ]);
        if (!active) return;
        setCatalog(cat);
        if (existing) {
          setBrand(existing);
          setDraft(draftFrom(existing));
        } else {
          setDraft((d) => ({
            ...d,
            themePreset: cat.defaults.preset,
            fontFamily: cat.defaults.font,
            primaryColor:
              cat.presets.find((p) => p.id === cat.defaults.preset)?.primary ?? d.primaryColor,
            accentColor:
              cat.presets.find((p) => p.id === cat.defaults.preset)?.accent ?? d.accentColor,
          }));
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load brand");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  // Debounced availability check — the answer has to arrive while the operator
  // is still looking at the field, not after they've hit save.
  useEffect(() => {
    const slug = draft.slug;
    if (!slug) {
      setSlugState({ checking: false, available: null, reason: "", url: "" });
      return;
    }
    setSlugState((s) => ({ ...s, checking: true }));
    const timer = setTimeout(async () => {
      try {
        const res = await api.super.brands.checkSlug(slug, id);
        setSlugState({
          checking: false,
          available: res.available,
          reason: res.reason,
          url: res.url,
        });
      } catch {
        setSlugState({ checking: false, available: null, reason: "", url: "" });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [draft.slug, id]);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  const themeValue = useMemo<ThemeDraft>(
    () => ({
      themePreset: draft.themePreset,
      primaryColor: draft.primaryColor,
      accentColor: draft.accentColor,
      fontFamily: draft.fontFamily,
      darkModeDefault: draft.darkModeDefault,
    }),
    [draft],
  );

  const canSave = draft.name.trim().length >= 2 && !!draft.slug;

  async function save() {
    setSaving(true);
    try {
      // slug and customDomain are deliberately absent: both are locked once
      // the brand exists — the server rejects them from this endpoint outright.
      const next = await api.super.brands.update(id!, {
        name: draft.name,
        // A brand still in setup has no on/off to send; the server refuses it.
        status:
          draft.status === "active" || draft.status === "suspended" ? draft.status : undefined,
        tagline: draft.tagline,
        supportEmail: draft.supportEmail,
        supportPhone: draft.supportPhone,
        themePreset: draft.themePreset,
        primaryColor: draft.primaryColor,
        accentColor: draft.accentColor,
        fontFamily: draft.fontFamily,
        darkModeDefault: draft.darkModeDefault,
        ...setupPayload(draft),
      });
      setBrand(next);
      setDraft(draftFrom(next));
      toast.success("Brand saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save brand");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const identityCard = (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-base font-semibold">Brand</h3>
        <p className="text-sm text-muted-foreground">
          The name this tenant's customers see, and the address they reach it at.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="b-name">Brand name</Label>
          <Input
            id="b-name"
            className="mt-1.5"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Acme Voice"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Used across the UI and as the sender name on this brand's email.
          </p>
        </div>

        {/* One address, chosen once at creation and locked from then on — so
            here it is a plain read-out, never a field. */}
        <div className="sm:col-span-2">
          <Label>Address</Label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {brand?.customDomain ? (
                <>
                  <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
                    {brand.customDomain}
                  </code>
                  <Badge
                    variant={
                      brand.domainStatus === "verified"
                        ? "success"
                        : brand.domainStatus === "error"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {brand.domainStatus === "verified" ? "Verified" : "Awaiting DNS"}
                  </Badge>
                </>
              ) : (
                <>
                  <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
                    {draft.slug}
                  </code>
                  {slugState.url && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Globe className="size-3" /> {slugState.url}
                    </span>
                  )}
                </>
              )}
              <span className="text-xs text-muted-foreground">
                Set at creation and locked — it can&rsquo;t be changed afterward.
              </span>
              <button
                type="button"
                onClick={() => setTab("domain")}
                className="text-xs text-primary hover:underline"
              >
                View in Domain →
              </button>
          </div>
        </div>

        {/* The owner is the first admin account created with the brand. It lives
            in the brand's own database, so it's a read-out here; the Team tab is
            where accounts are managed. */}
        <div className="sm:col-span-2">
          <Label>Owner</Label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {brand?.owner ? (
              <>
                <span className="flex items-center gap-1.5 text-sm">
                  <UserRound className="size-4 text-muted-foreground" />
                  <span className="font-medium">{brand.owner.fullName || "—"}</span>
                </span>
                <a
                  href={`mailto:${brand.owner.email}`}
                  className="rounded bg-muted px-2 py-1 font-mono text-sm hover:underline"
                >
                  {brand.owner.email}
                </a>
                <span className="text-xs text-muted-foreground">
                  Admin since {new Date(brand.owner.createdAt).toLocaleDateString()}.
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                No admin account yet — this brand has no owner until one is added.
              </span>
            )}
            <button
              type="button"
              onClick={() => setTab("team")}
              className="text-xs text-primary hover:underline"
            >
              View in Team →
            </button>
          </div>
        </div>

        <div>
          <Label htmlFor="b-tagline">Tagline (optional)</Label>
          <Input
            id="b-tagline"
            className="mt-1.5"
            value={draft.tagline}
            onChange={(e) => patch({ tagline: e.target.value })}
            placeholder="Never miss a call"
          />
          <p className="mt-1 text-xs text-muted-foreground">Shown after the name in the tab title.</p>
        </div>

        <div>
          <Label htmlFor="b-support-email">Support email (optional)</Label>
          <Input
            id="b-support-email"
            type="email"
            className="mt-1.5"
            value={draft.supportEmail}
            onChange={(e) => patch({ supportEmail: e.target.value })}
            placeholder="help@acmevoice.com"
          />
        </div>

        <div>
          <Label htmlFor="b-support-phone">Support phone (optional)</Label>
          <Input
            id="b-support-phone"
            className="mt-1.5"
            value={draft.supportPhone}
            onChange={(e) => patch({ supportPhone: e.target.value })}
            placeholder="+61 2 8000 0000"
          />
        </div>
      </div>

      <BrandLocaleFields value={draft} onChange={patch} />

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div>
          <Label htmlFor="b-status" className="text-sm font-medium">
            Brand is live
          </Label>
          <p className="text-xs text-muted-foreground">
            Suspending keeps every record but stops the subdomain resolving, so nobody can reach or
            sign into the brand. To retire it, use Deactivate below.
          </p>
        </div>
        <Switch
          id="b-status"
          checked={draft.status === "active"}
          // Nothing to switch until the database is ready — see the Database card. A deactivated
          // brand is on a countdown; Reactivate (below) is its way back, not this switch.
          disabled={
            draft.status === "provisioning" ||
            draft.status === "failed" ||
            draft.status === "deactivated"
          }
          onCheckedChange={(checked) => patch({ status: checked ? "active" : "suspended" })}
        />
      </div>
    </Card>
  );

  const saveButton = (
    <Button disabled={!canSave || saving} onClick={() => void save()}>
      {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
      Save changes
    </Button>
  );

  // Only the status moves: unsaved edits in the form survive a lifecycle change.
  function applyLifecycle(next: Brand) {
    setBrand(next);
    setDraft((d) => ({ ...d, status: next.status }));
  }

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open.
  async function deactivate() {
    const next = await api.super.brands.deactivate(id!);
    applyLifecycle(next);
    toast.success(
      next.deletesAt
        ? `"${next.name}" deactivated — deleted for good on ${formatDeletesAt(next.deletesAt)} unless you reactivate it.`
        : `"${next.name}" deactivated`,
    );
  }

  async function reactivate() {
    setLifecycleBusy(true);
    try {
      const next = await api.super.brands.reactivate(id!);
      applyLifecycle(next);
      toast.success(`"${next.name}" is back online.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to reactivate brand");
    } finally {
      setLifecycleBusy(false);
    }
  }

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open.
  async function destroy() {
    const res = await api.super.brands.remove(id!);
    toast.success(
      res.accountsRemoved > 0
        ? `"${brand?.name}" deleted, along with its database and ${res.accountsRemoved} account${
            res.accountsRemoved === 1 ? "" : "s"
          }.`
        : `"${brand?.name}" deleted`,
    );
    navigate("/dashboard/admin/brands");
  }

  const deactivated = brand?.status === "deactivated";
  const inSetup = brand?.status === "provisioning" || brand?.status === "failed";
  const lifecycleCard = brand && (
    <Card className="space-y-4 border-danger/40 p-5">
      <h3 className="text-sm font-semibold">Deactivate or delete</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-sm">
          {deactivated ? (
            <>
              <p className="font-medium">
                Deactivated{brand.deactivatedAt ? ` on ${formatDeletesAt(brand.deactivatedAt)}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Offline now. Deleted for good, database and accounts included, on{" "}
                <strong>{brand.deletesAt ? formatDeletesAt(brand.deletesAt) : "its due date"}</strong>{" "}
                unless you reactivate it before then.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Deactivate</p>
              <p className="text-xs text-muted-foreground">
                Takes the brand offline now and deletes it, database and accounts included, after 30
                days. You can reactivate it any time before then.
              </p>
            </>
          )}
        </div>
        {deactivated ? (
          <Button variant="outline" disabled={lifecycleBusy} onClick={() => void reactivate()}>
            {lifecycleBusy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            Reactivate
          </Button>
        ) : (
          <Button
            variant="outline"
            // In setup there is nothing to switch off: Retry finishes it, Delete removes it.
            disabled={inSetup}
            onClick={() => setConfirmingDeactivate(true)}
          >
            <Power className="size-4" /> Deactivate
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-sm">
          <p className="font-medium">Delete now</p>
          <p className="text-xs text-muted-foreground">
            Immediate and permanent: the database and every account in it go with the brand.
          </p>
        </div>
        <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
          <Trash2 className="size-4" /> Delete brand
        </Button>
      </div>
    </Card>
  );

  return (
    <div>
      <button
        onClick={() => navigate("/dashboard/admin/brands")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to brands
      </button>

      <PageHeader
        title={brand?.name || "Brand"}
        subtitle={brand?.customDomain || slugState.url || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {brand && (
              <Badge variant={brandStatusVariant(brand)}>{brandStatusLabel(brand)}</Badge>
            )}
            {brand?.loginUrl && (
              <a
                href={brand.loginUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="size-3.5" /> Open
              </a>
            )}
            {saveButton}
          </div>
        }
      />

      <>
        {brand?.readiness && <BrandReadinessCard readiness={brand.readiness} onGo={setTab} />}
        {brand?.tenantDb && (
          <div className="mb-5">
            <BrandDatabaseCard
              brand={brand}
              tenantDb={brand.tenantDb}
              onChanged={({ brand: next, tenantDb }) => {
                setBrand({ ...next, tenantDb });
                setDraft(draftFrom(next));
              }}
            />
          </div>
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-5 flex-wrap">
            <TabsTrigger value="brand">
              <Building2 className="size-4" /> Brand
            </TabsTrigger>
            <TabsTrigger value="domain">
              <Globe className="size-4" /> Domain
            </TabsTrigger>
            <TabsTrigger value="theme">
              <Palette className="size-4" /> Theme
            </TabsTrigger>
            <TabsTrigger value="access">
              <ShieldCheck className="size-4" /> Access &amp; plans
            </TabsTrigger>
            <TabsTrigger value="content">
              <FileText className="size-4" /> Content
            </TabsTrigger>
            <TabsTrigger value="pricing">
              <Wallet className="size-4" /> Pricing &amp; wallet
            </TabsTrigger>
            <TabsTrigger value="whitelabel">
              <Mail className="size-4" /> White-label
            </TabsTrigger>
            <TabsTrigger value="team">
              <UserCog className="size-4" /> Team
            </TabsTrigger>
            {brand && (
              <TabsTrigger value="inside">
                <Users className="size-4" /> Inside
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="brand" className="space-y-5">
            {identityCard}
            <div className="flex justify-end">{saveButton}</div>
            {lifecycleCard}
          </TabsContent>

          <TabsContent value="domain" className="space-y-5">
            {brand && <BrandDomainSection brand={brand} />}
          </TabsContent>

          <TabsContent value="theme" className="space-y-5">
            <BrandThemeSection catalog={catalog} value={themeValue} onChange={patch} />
            <div className="flex justify-end">{saveButton}</div>
          </TabsContent>

          <TabsContent value="access" className="space-y-5">
            <BrandAccessSection value={draft} onChange={patch} />
            <div className="flex justify-end">{saveButton}</div>
          </TabsContent>

          <TabsContent value="content" className="space-y-5">
            <BrandContentSection value={draft} onChange={patch} />
            <div className="flex justify-end">{saveButton}</div>
          </TabsContent>

          <TabsContent value="pricing" className="space-y-5">
            {brand && (
              <BrandPricingTab
                brand={brand}
                value={{ addonEditable: draft.addonEditable, maxAddonCents: draft.maxAddonCents }}
                onChange={patch}
              />
            )}
            <div className="flex justify-end">{saveButton}</div>
          </TabsContent>

          <TabsContent value="whitelabel" className="space-y-5">
            {brand && <BrandAssetsSection brand={brand} onChange={setBrand} />}
            {brand && <BrandMessagingSection brandId={brand.id} />}
          </TabsContent>

          <TabsContent value="team" className="space-y-5">
            {brand && <BrandAdminsSection brand={brand} />}
            {brand && <BrandDepartmentsSection brand={brand} />}
          </TabsContent>

          <TabsContent value="inside" className="space-y-5">
            {brand && <BrandInsideTab brand={brand} />}
          </TabsContent>
        </Tabs>

        <ConfirmDeleteDialog
          open={confirmingDeactivate}
          onOpenChange={(open) => !open && setConfirmingDeactivate(false)}
          resourceType="brand"
          resourceName={brand?.name ?? ""}
          title="Deactivate brand"
          confirmLabel="Deactivate"
          onConfirm={deactivate}
          description={
            <>
              It goes offline now: nobody can reach or sign into it. In 30 days it is deleted for
              good, database and accounts included, unless you reactivate it first.
            </>
          }
        />
        <ConfirmDeleteDialog
          open={confirmingDelete}
          onOpenChange={(open) => !open && setConfirmingDelete(false)}
          resourceType="brand"
          resourceName={brand?.name ?? ""}
          onConfirm={destroy}
          description={
            <>
              This is immediate and permanent. Its database is dropped, and the{" "}
              <strong>{brand?.counts?.total ?? 0}</strong> account
              {(brand?.counts?.total ?? 0) === 1 ? "" : "s"} inside it{" "}
              {(brand?.counts?.total ?? 0) === 1 ? "is" : "are"} deleted with it. For a way back,
              deactivate instead.
            </>
          }
        />
      </>
    </div>
  );
}
