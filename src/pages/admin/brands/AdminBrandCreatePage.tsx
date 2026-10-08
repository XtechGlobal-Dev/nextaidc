import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  Check,
  Clock,
  Globe,
  Globe2,
  Inbox,
  LifeBuoy,
  Loader2,
  Mail,
  MapPin,
  Moon,
  Phone,
  Sparkles,
  Upload,
  UserCog,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  ApiError,
  type BrandCreateResult,
  type BrandFontOption,
  type BrandInput,
  type BrandRequest,
  type BrandThemeCatalog,
  type SubscriptionPlan,
} from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { COUNTRIES } from "@/data/countries";
import { listTimeZones } from "@/lib/timezone";
import { cn, timeAgo } from "@/lib/utils";
import { BLANK_SETUP, planBlockedBy, plansOnSale, setupPayload, type SetupDraft } from "./brandSetupDraft";
import {
  BrandMark,
  CatalogSkeleton,
  ColoursChoice,
  LOGO_ACCEPT,
  LogosChoice,
  TypographyPicker,
  useCatalogFonts,
  useObjectUrl,
} from "@/components/brand/BrandLookPickers";
import { BrandModuleSwitches } from "./BrandAccessSection";

// "Complete Brand Setup" for a Brand Admin request (?request=<id>): pre-filled from what the applicant sent; the
// super admin picks the address, look, settings and permissions, and the applicant's OWN account becomes the
// Brand Admin. There is no creating a brand from nothing — a brand only ever comes from an approved request
// (docs/brand-as-customer-plan.md). Editing lives in AdminBrandDetailPage.

// Same subdomain rules as the server, so the field self-corrects instead of failing on save.
function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strip what a person naturally pastes into a domain field — a scheme, a
 *  trailing path, a stray "www." — down to the bare hostname the server wants. */
function cleanDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\s+/g, "");
}

const DESCRIPTION_MAX = 160; // server: brandBodySchema.tagline

interface Draft extends SetupDraft {
  name: string;
  slug: string;
  customDomain: string;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  live: boolean;
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  darkModeDefault: boolean;
}

const BLANK: Draft = {
  name: "",
  slug: "",
  customDomain: "",
  tagline: "",
  supportEmail: "",
  supportPhone: "",
  live: true,
  themePreset: "ocean",
  primaryColor: "#2C76ED",
  accentColor: "#7C5CFC",
  fontFamily: "inter",
  darkModeDefault: false,
  ...BLANK_SETUP,
};

type SlugState = { checking: boolean; available: boolean | null; reason: string; url: string };

/** The three marks a brand can carry. Collected here, uploaded the moment the
 *  brand exists — object storage needs something to attach them to. */
type AssetSlot = "logoLight" | "logoDark" | "favicon";

export default function AdminBrandCreatePage() {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request");
  // Only a request can become a brand: without one there's nothing to set up.
  if (!requestId) return <Navigate to="/dashboard/admin/brands?tab=requests" replace />;
  return <BrandRequestSetup requestId={requestId} />;
}

function BrandRequestSetup({ requestId }: { requestId: string }) {
  const navigate = useNavigate();
  /** The brand request being completed, once loaded. */
  const [request, setRequest] = useState<BrandRequest | null>(null);
  /** Tell the applicant their brand is live (request mode only). */
  const [notifyApplicant, setNotifyApplicant] = useState(true);

  const [catalog, setCatalog] = useState<BrandThemeCatalog | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  // Active platform plans, for the "plans this brand sells" pick.
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [saving, setSaving] = useState(false);

  const [files, setFiles] = useState<Record<AssetSlot, File | null>>({
    logoLight: null,
    logoDark: null,
    favicon: null,
  });
  /** Marks already uploaded — a brand request's logos. They carry over to the brand unless a new file
   *  replaces one or it's removed. */
  const [existingAssets, setExistingAssets] = useState<Record<AssetSlot, string>>({
    logoLight: "",
    logoDark: "",
    favicon: "",
  });
  /** Pick a mark (it replaces any uploaded one) or, with null, remove both. */
  const pickAsset = (slot: AssetSlot, file: File | null) => {
    setFiles((f) => ({ ...f, [slot]: file }));
    if (!file) setExistingAssets((a) => ({ ...a, [slot]: "" }));
  };

  const [slugState, setSlugState] = useState<SlugState>({
    checking: false,
    available: null,
    reason: "",
    url: "",
  });
  /** ".hello22.ai" — learned from the server rather than guessed, so the field's
   *  suffix is right in every environment (including a developer's loopback). */
  const [hostSuffix, setHostSuffix] = useState("");
  /** The operator has typed their own subdomain, so stop deriving it from the name. */
  const slugTouched = useRef(false);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  // Plans whose add-ons are all switched on are the only ones on sale; the rest leave the pick.
  const sellablePlans = plans.filter((p) => planBlockedBy(p, draft.modules).length === 0);
  const hiddenPlans = plans.filter((p) => planBlockedBy(p, draft.modules).length > 0);

  /** Switching a module off also unpicks the plans that include its add-on, and says which. */
  function setModules(modules: Draft["modules"]) {
    const dropped = plans.filter((p) => draft.planIds.includes(p.id) && planBlockedBy(p, modules).length > 0);
    patch({ modules, planIds: draft.planIds.filter((id) => !dropped.some((p) => p.id === id)) });
    if (dropped.length) {
      const names = dropped.map((p) => p.displayName).join(", ");
      toast.info(`Removed ${names} from the plans on sale — ${dropped.length === 1 ? "it includes" : "they include"} an add-on you switched off.`);
    }
  }

  useEffect(() => {
    let active = true;
    api.admin.plans
      .list()
      .then((rows) => active && setPlans(rows.filter((p) => p.active)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  /* ------------------------------ loading ----------------------------- */

  // Complete setup: start from what the applicant sent. Everything stays editable.
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    api.super.brandRequests
      .get(requestId)
      .then((r) => {
        if (!active) return;
        if (r.status === "approved" || r.status === "declined" || r.status === "awaiting_domain") {
          toast.info(
            r.status === "awaiting_domain"
              ? `${r.brandName} is approved — it becomes the brand once its domain is live.`
              : `${r.brandName} has already been ${r.status === "approved" ? "set up" : "declined"}.`,
          );
          navigate("/dashboard/admin/brands?tab=requests", { replace: true });
          return;
        }
        setRequest(r);
        slugTouched.current = true;
        setDraft((d) => ({
          ...d,
          name: r.brandName,
          slug: r.slug,
          tagline: r.tagline.slice(0, DESCRIPTION_MAX),
          supportEmail: r.email,
          supportPhone: r.phone,
          // Their own domain goes straight into Custom Domain; still editable here.
          customDomain: r.customDomain,
          defaultCountry: r.country,
          defaultTimezone: r.timezone,
          // The look they picked, when they picked one; otherwise the draft's defaults stand.
          ...(r.themePreset
            ? { themePreset: r.themePreset, primaryColor: r.primaryColor, accentColor: r.accentColor }
            : {}),
          ...(r.fontFamily ? { fontFamily: r.fontFamily } : {}),
        }));
        setExistingAssets({ logoLight: r.logoLightUrl, logoDark: r.logoDarkUrl, favicon: r.faviconUrl });
      })
      .catch((e) => {
        if (!active) return;
        toast.error(e instanceof ApiError ? e.message : "Failed to load the brand request");
        navigate("/dashboard/admin/brands?tab=requests", { replace: true });
      });
    return () => {
      active = false;
    };
  }, [requestId, navigate]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cat = await api.super.brands.catalog();
        if (!active) return;
        setCatalog(cat);
        // Completing a request keeps the applicant's look — this may land after it was filled in.
        if (requestId) return;
        const preset = cat.presets.find((p) => p.id === cat.defaults.preset);
        setDraft((d) => ({
          ...d,
          themePreset: cat.defaults.preset,
          fontFamily: cat.defaults.font,
          primaryColor: preset?.primary ?? d.primaryColor,
          accentColor: preset?.accent ?? d.accentColor,
        }));
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load the brand catalog");
      }
    })();
    return () => {
      active = false;
    };
  }, [requestId]);

  // One probe against a throwaway label, purely to learn what the platform's
  // wildcard host is — the field shows its suffix before anything is typed.
  useEffect(() => {
    let active = true;
    api.super.brands
      .checkSlug("example")
      .then((res) => {
        if (!active || !res.url) return;
        const host = res.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        setHostSuffix(host.startsWith("example") ? host.slice("example".length) : "");
      })
      .catch(() => {
        /* the suffix is decoration — the server is still the authority on save */
      });
    return () => {
      active = false;
    };
  }, []);

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
        const res = await api.super.brands.checkSlug(slug);
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
  }, [draft.slug]);

  useCatalogFonts(catalog);

  /* ------------------------------ derived ----------------------------- */

  const setName = (name: string) =>
    patch(slugTouched.current ? { name } : { name, slug: slugify(name) });

  const font = useMemo<BrandFontOption | null>(() => {
    if (!catalog) return null;
    return (
      catalog.fonts.find((f) => f.id === draft.fontFamily) ??
      catalog.fonts.find((f) => f.id === catalog.defaults.font) ??
      null
    );
  }, [catalog, draft.fontFamily]);

  const logoPreview = useObjectUrl(files.logoLight) || existingAssets.logoLight;

  const domainInvalid =
    !!draft.customDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(draft.customDomain);

  // Subdomain is the permanent address and always required; a custom domain only needs to be well-formed if typed.
  const addressReady = !!draft.slug && slugState.available !== false && !domainInvalid;

  const canSave = draft.name.trim().length >= 2 && addressReady && !!request;

  /* -------------------------------- save ------------------------------ */

  async function save() {
    if (!request) return;
    setSaving(true);
    try {
      const brandInput: BrandInput = {
        name: draft.name,
        slug: draft.slug,
        // Optional — only real once the client publishes DNS. Both addresses lock once set.
        customDomain: draft.customDomain || null,
        status: draft.live ? "active" : "suspended",
        tagline: draft.tagline,
        supportEmail: draft.supportEmail,
        supportPhone: draft.supportPhone,
        themePreset: draft.themePreset,
        primaryColor: draft.primaryColor,
        accentColor: draft.accentColor,
        fontFamily: draft.fontFamily,
        darkModeDefault: draft.darkModeDefault,
        ...setupPayload(draft),
        planIds: plansOnSale(draft.planIds, draft.modules, plans),
        // A request's logos carry over, unless replaced (the new file uploads below) or removed.
        logoLightUrl: files.logoLight ? "" : existingAssets.logoLight,
        logoDarkUrl: files.logoDark ? "" : existingAssets.logoDark,
        faviconUrl: files.favicon ? "" : existingAssets.favicon,
      };
      const res: BrandCreateResult = await api.super.brandRequests.approve(request.id, { ...brandInput, notifyApplicant });

      // The marks need a brand to hang off, so they go up now — a failed upload
      // is reported but never unwinds a brand that was created successfully.
      const pending = (Object.entries(files) as [AssetSlot, File | null][]).filter(
        (entry): entry is [AssetSlot, File] => !!entry[1],
      );
      for (const [slot, file] of pending) {
        try {
          await api.super.brands.uploadAsset(res.brand.id, slot, file);
        } catch (e) {
          toast.warning(
            `${res.brand.name} was created, but the ${slot === "favicon" ? "favicon" : "logo"} didn't upload — add it from the White-label tab. ${
              e instanceof ApiError ? e.message : ""
            }`.trim(),
          );
        }
      }

      if (res.adminError) toast.warning(res.adminError);
      if (res.state === "awaiting_domain") {
        toast.success(`${res.brand.name} is approved — it goes live once ${res.domain?.domain ?? "its domain"} is connected`);
      } else if (res.state === "brand") {
        toast.success(`${res.brand.name} is live — the applicant now signs in at ${res.loginUrl}`);
      } else toast.success(`${res.brand.name} is set up`);
      // A claimed domain is the one thing still waiting on somebody, so land the
      // operator on the records they now have to send the client.
      navigate(`/dashboard/admin/brands/${res.brand.id}${res.domain ? "?tab=domain" : ""}`, {
        replace: true,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't complete the setup");
    } finally {
      setSaving(false);
    }
  }

  /* ------------------------------- render ----------------------------- */

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate("/dashboard/admin/brands?tab=requests")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to Requests
      </button>

      <h1 className="text-2xl font-semibold tracking-tight">
        Complete Brand Setup
      </h1>

      {(
        <RequestSummary request={request} />
      )}

      {/* ------------------------- Form + live preview --------------------- */}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:gap-8">
        <div className="min-w-0 space-y-6">
          {/* ------------------------ 1 · Information ---------------------- */}
          <Section
            n={1}
            title="Brand Information"
            blurb="Tell us about your brand. This information will be visible in your dashboard and to your customers."
          >
            <div className="space-y-5">
              <Field
                id="b-name"
                label="Brand Name"
                required
                hint="This will be visible to your customers and in the dashboard."
              >
                <InputWithIcon icon={<Building2 className="size-4" />}>
                  <Input
                    id="b-name"
                    value={draft.name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter brand name"
                    className="pl-10"
                    maxLength={60}
                  />
                </InputWithIcon>
              </Field>

              <Field id="b-tagline" label="About / Description">
                <Textarea
                  id="b-tagline"
                  rows={4}
                  value={draft.tagline}
                  maxLength={DESCRIPTION_MAX}
                  onChange={(e) => patch({ tagline: e.target.value })}
                  placeholder="Tell us about your brand, what it does and what makes it unique…"
                  className="min-h-[6.5rem] resize-y"
                />
                <p className="mt-1 text-right text-xs text-muted-foreground">
                  {draft.tagline.length}/{DESCRIPTION_MAX}
                </p>
              </Field>

              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <Field label="Brand Logo">
                  <DropZone
                    file={files.logoLight}
                    existingUrl={existingAssets.logoLight}
                    accept={LOGO_ACCEPT}
                    hint="SVG, PNG, JPG (Max. 2MB)"
                    onPick={(file) => pickAsset("logoLight", file)}
                  />
                </Field>
                <div>
                  <Label className="text-sm font-medium">Preview</Label>
                  <div className="mt-2 flex h-[7.5rem] flex-col items-center justify-center gap-2 rounded-xl border border-border bg-warm px-3">
                    <BrandMark
                      logoUrl={logoPreview}
                      name={draft.name}
                      primary={draft.primaryColor}
                      accent={draft.accentColor}
                      className="size-11 rounded-xl text-base"
                    />
                    <span className="max-w-full truncate text-xs font-medium">
                      {draft.name || "Brand Name"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* ------------------ 2 · Subdomain & custom domain ---------------- */}
          <Section
            n={2}
            title="Subdomain & Custom Domain"
            blurb="Where this brand answers. Both are set here and locked once the brand exists."
          >
            <div className="space-y-6">
              {/* The platform subdomain — always claimed, live the moment the
                  brand exists, and the address everything falls back to. */}
              <div>
                <Label htmlFor="b-slug" className="text-sm font-medium">
                  Subdomain
                  <span className="ml-1 text-danger">*</span>
                </Label>

                <div className="mt-2 flex items-stretch">
                  <span className="inline-flex items-center rounded-l-xl border border-r-0 border-border bg-muted px-3 text-sm text-muted-foreground">
                    https://
                  </span>
                  <div className="relative min-w-0 flex-1">
                    <Input
                      id="b-slug"
                      value={draft.slug}
                      spellCheck={false}
                      onChange={(e) => {
                        slugTouched.current = true;
                        patch({ slug: slugify(e.target.value) });
                      }}
                      placeholder="brandname"
                      maxLength={40}
                      className="rounded-none border-x-0 pr-9 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2">
                      {slugState.checking ? (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      ) : slugState.available === true ? (
                        <Check className="size-4 text-success" />
                      ) : slugState.available === false ? (
                        <X className="size-4 text-danger" />
                      ) : null}
                    </span>
                  </div>
                  {/* Only the subdomain sits under our apex, so only it carries
                      the suffix — a custom domain IS the whole host. */}
                  <span className="inline-flex items-center rounded-r-xl border border-l-0 border-border bg-muted px-3 font-mono text-sm text-muted-foreground">
                    {hostSuffix || ".app"}
                  </span>
                </div>

                {slugState.available === false ? (
                  <p className="mt-1 text-xs text-danger">{slugState.reason}</p>
                ) : slugState.available === true && slugState.url ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-success">
                    <Globe className="size-3" /> {slugState.url} is available
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    This will be your brand's unique URL. It can't be changed after creation.
                  </p>
                )}
              </div>

              {/* The client's own hostname. Optional — a brand launches on its
                  subdomain, and the vanity domain goes live once DNS lands. */}
              <div className="border-t border-border pt-6">
                <Label htmlFor="b-domain" className="text-sm font-medium">
                  Custom Domain
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                </Label>

                <div className="mt-2 flex items-stretch">
                  <span className="inline-flex items-center rounded-l-xl border border-r-0 border-border bg-muted px-3 text-sm text-muted-foreground">
                    https://
                  </span>
                  <Input
                    id="b-domain"
                    value={draft.customDomain}
                    spellCheck={false}
                    maxLength={120}
                    onChange={(e) => patch({ customDomain: cleanDomain(e.target.value) })}
                    placeholder="app.brandname.com"
                    className="min-w-0 flex-1 rounded-l-none border-l-0 font-mono"
                  />
                </div>

                {domainInvalid ? (
                  <p className="mt-1 text-xs text-danger">
                    That doesn't look like a hostname — use something like app.brandname.com.
                  </p>
                ) : draft.customDomain ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    You'll get the two DNS records to send{" "}
                    <span className="font-medium text-foreground">{draft.customDomain}</span>
                    &rsquo;s owner as soon as the brand is created. Until they publish them, the
                    brand runs on its subdomain.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    A hostname the client owns. Leave empty to launch on the subdomain alone — a
                    domain can't be added from this form later.
                  </p>
                )}
              </div>
            </div>
          </Section>

          {/* ---------------------- 3 · Location & contact ------------------- */}
          <Section
            n={3}
            title="Location & Contact"
            blurb="Set your brand's location and contact details."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                id="b-support-email"
                label="Support Email"
                optional
                hint="Used for customer support and notifications."
              >
                <InputWithIcon icon={<Mail className="size-4" />}>
                  <Input
                    id="b-support-email"
                    type="email"
                    value={draft.supportEmail}
                    onChange={(e) => patch({ supportEmail: e.target.value })}
                    placeholder="support@brandname.com"
                    className="pl-10"
                  />
                </InputWithIcon>
              </Field>

              <Field
                id="b-support-phone"
                label="Support Phone"
                optional
                hint="Customer support phone number."
              >
                <InputWithIcon icon={<Phone className="size-4" />}>
                  <Input
                    id="b-support-phone"
                    value={draft.supportPhone}
                    onChange={(e) => patch({ supportPhone: e.target.value })}
                    placeholder="+61 2 8000 0000"
                    className="pl-10"
                  />
                </InputWithIcon>
              </Field>

              <Field
                id="b-address"
                label="Address"
                optional
                hint="Your business address."
              >
                <InputWithIcon icon={<MapPin className="size-4" />}>
                  <Input
                    id="b-address"
                    value={draft.legalAddress}
                    onChange={(e) => patch({ legalAddress: e.target.value })}
                    placeholder="123 Business Street, Sydney, Australia"
                    className="pl-10"
                  />
                </InputWithIcon>
              </Field>

              <Field
                id="b-timezone"
                label="Time Zone"
                hint="Default time zone for your brand."
              >
                <SearchableSelect
                  id="b-timezone"
                  value={draft.defaultTimezone}
                  onChange={(defaultTimezone) => patch({ defaultTimezone })}
                  options={TIME_ZONES}
                  placeholder="Platform default"
                  clearLabel="Platform default"
                />
              </Field>

              <Field
                id="b-country"
                label="Default Country"
                hint="Where this brand's customers usually are."
              >
                <Select
                  value={draft.defaultCountry || NONE}
                  onValueChange={(v) => patch({ defaultCountry: v === NONE ? "" : v })}
                >
                  <SelectTrigger id="b-country" className="h-10 rounded-xl">
                    <SelectValue placeholder="Platform default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Platform default</SelectItem>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code.toUpperCase()}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          {/* ------------------------ 4 · Brand settings -------------------- */}
          <Section
            n={4}
            title="Brand Settings"
            blurb={
              request
                ? "The settings and permissions this brand gets. Only you can change them — the brand's admin can't."
                : "Configure how your brand behaves and interacts with customers."
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleCard
                id="b-signup"
                icon={<Users className="size-4" />}
                title="Public sign-up"
                blurb="Anyone can create an account on this brand's door. Off closes the sign-up screen and the onboarding funnel."
                checked={draft.signupMode === "public"}
                onChange={(on) => patch({ signupMode: on ? "public" : "invite" })}
              />
              <ToggleCard
                id="b-dark"
                icon={<Moon className="size-4" />}
                title="Open in dark mode"
                blurb="First-time visitors start on the dark theme. They can still switch."
                checked={draft.darkModeDefault}
                onChange={(darkModeDefault) => patch({ darkModeDefault })}
              />
              <ToggleCard
                id="b-live"
                icon={<Sparkles className="size-4" />}
                title="Brand is live"
                blurb="Suspending keeps every record but stops the address resolving, so nobody can sign in."
                checked={draft.live}
                onChange={(live) => patch({ live })}
              />
            </div>
          </Section>

          {/* ----------------------- 5 · Modules & plans ------------------- */}
          <Section
            n={5}
            title="Modules & plans"
            blurb="Which optional modules this brand's customers get, then the plans it sells. Off hides a module from their navigation, and a plan that includes a switched-off module's add-on can't be sold here."
          >
            <BrandModuleSwitches value={draft} onChange={({ modules }) => modules && setModules(modules)} />

            <Field
              id="b-plans"
              label="Plans this brand sells"
              hint={
                hiddenPlans.length
                  ? `Only these show on the brand's plans and subscribe pages. Leave empty to offer every plan that fits the modules above. ${hiddenPlans.length} plan${hiddenPlans.length === 1 ? " is" : "s are"} hidden — ${hiddenPlans.length === 1 ? "it includes" : "they include"} an add-on that's switched off.`
                  : "Only these show on the brand's plans and subscribe pages. Leave empty to offer every active platform plan."
              }
              className="mt-4"
            >
              <MultiSelect
                id="b-plans"
                values={draft.planIds}
                onChange={(planIds) => patch({ planIds })}
                options={sellablePlans.map((p) => ({
                  value: p.id,
                  label: p.displayName,
                  hint: `${formatMoney(p.priceCents, p.currency)} / ${p.intervalCount > 1 ? `${p.intervalCount} ` : ""}${p.interval}`,
                }))}
                placeholder={hiddenPlans.length ? "Every plan that fits" : "Every active plan"}
                searchPlaceholder="Search plans…"
              />
            </Field>
          </Section>

          {/* ------------------------- 6 · Look & logos -------------------- */}
          <Section
            n={6}
            title="Look & Logos"
            blurb="Colours, typeface and marks — what this brand's customers see. Anything left empty falls back to the platform's own."
          >
            {/* Colours and logos each open their own dialog (same pieces as the public request form);
                the typeface and its live preview stay on the page. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <ColoursChoice
                presets={catalog?.presets ?? null}
                value={draft.themePreset}
                primary={draft.primaryColor}
                accent={draft.accentColor}
                brandName={draft.name}
                logoUrl={logoPreview}
                onPick={(p) => patch({ themePreset: p.id, primaryColor: p.primary, accentColor: p.accent })}
              />
              <LogosChoice
                files={files}
                existing={existingAssets}
                onPick={pickAsset}
                accept={LOGO_ACCEPT}
                lightHint="SVG, PNG, JPG (Max. 2MB)"
                description={
                  <>
                    Optional — these replace the platform&rsquo;s marks everywhere this brand&rsquo;s users
                    look. Uploaded the moment the brand is created; its own mail / SMS / WhatsApp senders
                    are set up afterwards, from its White-label tab.
                  </>
                }
              />
            </div>

            <div className="mt-6">
              {catalog ? (
                <TypographyPicker
                  fonts={catalog.fonts}
                  value={draft.fontFamily}
                  primary={draft.primaryColor}
                  accent={draft.accentColor}
                  onChange={(fontFamily) => patch({ fontFamily })}
                />
              ) : (
                <CatalogSkeleton />
              )}
            </div>
          </Section>

          {/* ------------------------ 7 · Brand administrator --------------- */}
          <Section
            n={7}
            title="Brand Administrator"
            blurb="Who runs this brand: the customer who asked. They get full control of their tenant — and no access to platform keys or any other brand."
          >
            {request ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3 rounded-xl border border-border p-4">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-tint text-primary">
                    <UserCog className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{request.contactName}</p>
                    <p className="truncate text-xs text-muted-foreground">{request.email}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {request.applicantBrandId
                        ? "Existing customer account — becomes the Brand Admin (keeps their password, assistant and number)."
                        : "Signs in with the password they chose when applying."}
                    </p>
                  </div>
                </div>
                <ToggleCard
                  id="b-notify-applicant"
                  icon={<Mail className="size-4" />}
                  title="Email them it's live"
                  blurb="Sends their sign-in address. No password is sent — they already have it."
                  checked={notifyApplicant}
                  onChange={setNotifyApplicant}
                />
              </div>
            ) : null}
          </Section>

          {/* ------------------------------- Actions ----------------------- */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => navigate("/dashboard/admin/brands?tab=requests")}
            >
              Cancel
            </Button>
            <Button
              size="lg"
              className="px-8"
              disabled={!canSave || saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              Complete Setup
            </Button>
          </div>
        </div>

        {/* ---------------------------- Live preview ----------------------- */}
        <aside className="space-y-5 lg:sticky lg:top-24">
          <Card className="p-5">
            <h3 className="text-sm font-semibold">Brand Preview</h3>

            <div className="mt-4 flex min-w-0 flex-col items-center gap-2 rounded-xl bg-warm p-5">
              <BrandMark
                logoUrl={logoPreview}
                name={draft.name}
                primary={draft.primaryColor}
                accent={draft.accentColor}
                className="size-16 rounded-2xl text-2xl"
              />
              <p
                className="mt-1 w-full truncate text-center text-base font-semibold"
                style={font ? { fontFamily: font.stack } : undefined}
              >
                {draft.name || "Brand Name"}
              </p>
              <p className="line-clamp-2 w-full break-words text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {draft.tagline || "Your brand tagline goes here"}
              </p>
            </div>

            <dl className="mt-4 space-y-3">
              <PreviewRow
                icon={<Globe className="size-3.5" />}
                label="Subdomain"
                value={`${draft.slug || "brandname"}${hostSuffix || ".app"}`}
                muted={!draft.slug}
                mono
              />
              <PreviewRow
                icon={<Globe className="size-3.5" />}
                label="Custom domain"
                value={draft.customDomain || "Not set"}
                muted={!draft.customDomain}
                mono
              />
              <PreviewRow
                icon={<Mail className="size-3.5" />}
                label="Support"
                value={draft.supportEmail || "support@brandname.com"}
                muted={!draft.supportEmail}
              />
              <PreviewRow
                icon={<Phone className="size-3.5" />}
                label="Phone"
                value={draft.supportPhone || "Not set"}
                muted={!draft.supportPhone}
              />
              <PreviewRow
                icon={<Clock className="size-3.5" />}
                label="Timezone"
                value={draft.defaultTimezone || "Platform default"}
                muted={!draft.defaultTimezone}
              />
              <PreviewRow
                icon={<Globe2 className="size-3.5" />}
                label="Country"
                value={
                  COUNTRIES.find((c) => c.code.toUpperCase() === draft.defaultCountry)?.name ||
                  "Platform default"
                }
                muted={!draft.defaultCountry}
              />
            </dl>
          </Card>

          <Card className="overflow-hidden bg-primary-tint-soft p-5">
            <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
              <LifeBuoy className="size-4" />
            </span>
            <h3 className="mt-3 text-sm font-semibold">Need help?</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Our team is here to assist you with brand setup and configuration.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 bg-card"
              onClick={() => navigate("/dashboard/admin/tickets")}
            >
              Contact Support
            </Button>
          </Card>

          <Card className="p-5">
            <h3 className="text-sm font-semibold">Why create a brand?</h3>
            <ul className="mt-3 space-y-2.5">
              {WHY_BRAND.map((line) => (
                <li key={line} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                  {line}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

// Pieces

/** Radix Select refuses an empty item value, so "use the platform's" needs a sentinel. */
const NONE = "__none__";
const TIME_ZONES = listTimeZones();

const WHY_BRAND = [
  "Multi-brand management",
  "Separate customer data",
  "Custom branding & domain",
  "Advanced analytics",
  "Dedicated support",
];

/** What the applicant sent, above the form — the context for every choice below. */
function RequestSummary({ request }: { request: BrandRequest | null }) {
  if (!request) {
    return <div className="mt-4 h-24 animate-pulse rounded-2xl bg-muted" />;
  }
  return (
    <Card className="mt-4 border-primary/30 bg-primary-tint-soft p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Inbox className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            Requested by {request.contactName}
            <span className="ml-2 font-normal text-muted-foreground">{timeAgo(request.createdAt)}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 break-all">
              <Mail className="size-3 shrink-0" /> {request.email}
            </span>
            {request.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="size-3 shrink-0" /> {request.phone}
              </span>
            )}
            {request.customDomain && (
              <span className="inline-flex min-w-0 items-center gap-1 break-all" title="Their own domain">
                <Globe className="size-3 shrink-0" /> {request.customDomain}
              </span>
            )}
          </p>
          {request.notes && (
            <p className="mt-2 whitespace-pre-line break-words rounded-lg bg-card/70 p-2.5 text-xs leading-relaxed">
              {request.notes}
            </p>
          )}
          {request.applicantBrandId && (
            <p className="mt-2 text-xs font-medium">
              Existing customer account — becomes the Brand Admin (keeps their password, assistant and number).
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Their details are filled in below. Review them, choose the brand&rsquo;s settings,
            permissions and plans, then complete the setup.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** One numbered step of the form. The badge straddles the card's left edge, as
 *  in the design, so the six steps read as one numbered column. */
function Section({
  n,
  title,
  blurb,
  action,
  children,
}: {
  n: number;
  title: string;
  blurb: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="relative p-5 sm:p-6">
      <span className="absolute -left-3 top-6 grid size-7 place-items-center rounded-full border border-border bg-card text-[11px] font-semibold text-muted-foreground shadow-sm">
        {n}
      </span>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Field({
  id,
  label,
  required,
  optional,
  hint,
  className,
  children,
}: {
  id?: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** An input with a leading glyph. The child input carries its own `pl-10`. */
function InputWithIcon({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        {icon}
      </span>
      {children}
    </div>
  );
}

function ToggleCard({
  id,
  icon,
  title,
  blurb,
  checked,
  onChange,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  blurb: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border p-4 transition-colors",
        checked ? "border-primary/40 bg-primary-tint-soft" : "border-border",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          checked ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {title}
        </Label>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}

/** The big click-or-drag logo target from the top of the form. */
function DropZone({
  file,
  existingUrl = "",
  accept,
  hint,
  onPick,
}: {
  file: File | null;
  /** An already-uploaded logo (a brand request's), shown until replaced or removed. */
  existingUrl?: string;
  accept: string;
  hint: string;
  onPick: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onPick(e.dataTransfer.files?.[0] ?? null);
      }}
      className={cn(
        "relative flex h-[7.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 text-center transition-colors",
        over ? "border-primary bg-primary-tint-soft" : "border-border hover:border-primary/50",
      )}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = ""; // let the same file be re-picked after a removal
        }}
      />
      {file || existingUrl ? (
        <>
          <p className="max-w-full truncate text-sm font-medium">{file ? file.name : "Logo from the request"}</p>
          <p className="text-xs text-muted-foreground">
            {file ? `${(file.size / 1024).toFixed(0)} KB` : "Kept unless you replace it"}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="text-xs font-medium text-primary hover:underline"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="text-xs font-medium text-danger hover:underline"
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex flex-col items-center gap-1 focus-visible:focus-ring"
        >
          <Upload className="mb-1 size-6 text-primary" />
          <span className="text-sm font-medium">Click to upload or drag and drop</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </button>
      )}
    </div>
  );
}

function PreviewRow({
  icon,
  label,
  value,
  mono,
  muted,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
        <dd
          className={cn(
            "truncate text-xs",
            mono && "font-mono",
            muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {value}
        </dd>
      </div>
    </div>
  );
}
