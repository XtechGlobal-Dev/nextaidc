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
  Save,
  ShieldCheck,
  UserCog,
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

/**
 * Edit one white-label brand.
 *
 * Tabs, because by the time a brand exists its pieces — domain, theme, plans,
 * team — move independently. Creating one is a single scrolling form instead,
 * and lives in AdminBrandCreatePage.
 */
export default function AdminBrandDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [brand, setBrand] = useState<Brand | null>(null);
  const [catalog, setCatalog] = useState<BrandThemeCatalog | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
            sign into the brand.
          </p>
        </div>
        <Switch
          id="b-status"
          checked={draft.status === "active"}
          // Nothing to switch until the database is ready — see the Database card.
          disabled={draft.status === "provisioning" || draft.status === "failed"}
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
              <Badge
                variant={
                  brand.status === "active"
                    ? "success"
                    : brand.status === "provisioning"
                      ? "warning"
                      : brand.status === "failed"
                        ? "danger"
                        : "neutral"
                }
              >
                {brand.status === "active"
                  ? "Active"
                  : brand.status === "provisioning"
                    ? "Setting up"
                    : brand.status === "failed"
                      ? "Setup failed"
                      : "Suspended"}
              </Badge>
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
      </>
    </div>
  );
}
