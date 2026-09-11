import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Briefcase,
  Building2,
  Check,
  ChevronRight,
  Clock,
  Globe,
  Globe2,
  Image as ImageIcon,
  LifeBuoy,
  Loader2,
  Mail,
  MapPin,
  Moon,
  Phone,
  Save,
  Sparkles,
  Upload,
  UserCog,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError, type BrandFontOption, type BrandThemeCatalog } from "@/lib/api";
import { COUNTRIES } from "@/data/countries";
import { listTimeZones } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { BLANK_SETUP, setupPayload, type SetupDraft } from "./brandSetupDraft";

/* ------------------------------------------------------------------ *
 *  Create one white-label brand.
 *
 *  A single scrolling form rather than a wizard: a brand with no
 *  address, no look and no admin isn't usable, so everything that makes
 *  it usable is asked for in one pass, with a live preview alongside so
 *  the operator can see the tenant they are about to hand over.
 *
 *  Editing lives in AdminBrandDetailPage — by then the pieces (domain,
 *  theme, plans, team) move independently and belong in tabs.
 * ------------------------------------------------------------------ */

/** Turn what someone types into a legal subdomain label — the same rules the
 *  server applies, mirrored here so the field corrects itself as you type
 *  instead of failing on save. */
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
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState<BrandThemeCatalog | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [saving, setSaving] = useState(false);

  const [admin, setAdmin] = useState({
    email: "",
    fullName: "",
    password: "",
    sendWelcomeEmail: true,
  });
  const [withAdmin, setWithAdmin] = useState(true);

  const [files, setFiles] = useState<Record<AssetSlot, File | null>>({
    logoLight: null,
    logoDark: null,
    favicon: null,
  });

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
  const [showAllPalettes, setShowAllPalettes] = useState(false);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  /* ------------------------------ loading ----------------------------- */

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cat = await api.super.brands.catalog();
        if (!active) return;
        setCatalog(cat);
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
  }, []);

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

  // Load every catalog face so the typeface picker shows each option set in the
  // face it actually is. One stylesheet, removed when the page closes.
  useEffect(() => {
    if (!catalog) return;
    const families = catalog.fonts
      .map((f) => f.googleFamily)
      .filter(Boolean)
      .map((name) => `family=${name.replace(/ /g, "+")}:wght@400;600`);
    if (!families.length) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [catalog]);

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

  const logoPreview = useObjectUrl(files.logoLight);

  const adminReady =
    !withAdmin ||
    (admin.email.trim().length > 3 &&
      admin.fullName.trim().length > 1 &&
      admin.password.length >= 8);

  const domainInvalid =
    !!draft.customDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(draft.customDomain);

  // The subdomain is the brand's permanent address, so it is always required.
  // A custom domain is an extra front door on top of it, and only has to be
  // well-formed when one was typed at all.
  const addressReady = !!draft.slug && slugState.available !== false && !domainInvalid;

  const canSave = draft.name.trim().length >= 2 && addressReady && adminReady;

  /* -------------------------------- save ------------------------------ */

  async function save() {
    setSaving(true);
    try {
      const res = await api.super.brands.create({
        name: draft.name,
        slug: draft.slug,
        // Optional, unlike the subdomain: the brand is reachable the moment it
        // exists, and a vanity domain only becomes real once the client
        // publishes DNS. Both are locked once set.
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
        ...(withAdmin ? { admin } : {}),
      });

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
      toast.success(
        res.admin
          ? `${res.brand.name} created — ${res.admin.email} can sign in at ${res.loginUrl}`
          : `${res.brand.name} created`,
      );
      // A claimed domain is the one thing still waiting on somebody, so land the
      // operator on the records they now have to send the client.
      navigate(`/dashboard/admin/brands/${res.brand.id}${res.domain ? "?tab=domain" : ""}`, {
        replace: true,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create the brand");
    } finally {
      setSaving(false);
    }
  }

  /* ------------------------------- render ----------------------------- */

  const presets = catalog?.presets ?? [];
  const headline = presets.slice(0, 4);
  const extras = presets.slice(4);
  const visibleExtras = showAllPalettes ? extras : extras.slice(0, 4);

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate("/dashboard/admin/brands")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to Brands
      </button>

      <h1 className="text-2xl font-semibold tracking-tight">Create New Brand</h1>

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
                    accept={LOGO_ACCEPT}
                    hint="SVG, PNG, JPG (Max. 2MB)"
                    onPick={(file) => setFiles((f) => ({ ...f, logoLight: file }))}
                  />
                </Field>
                <div>
                  <Label className="text-sm font-medium">Preview</Label>
                  <div className="mt-1.5 flex h-[7.5rem] flex-col items-center justify-center gap-2 rounded-xl border border-border bg-warm px-3">
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

                <div className="mt-1.5 flex items-stretch">
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

                <div className="mt-1.5 flex items-stretch">
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
            blurb="Configure how your brand behaves and interacts with customers."
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
                id="b-addon"
                icon={<Wallet className="size-4" />}
                title="Admin sets plan add-ons"
                blurb="Lets this brand's own admin price their add-ons. Off keeps pricing with the platform."
                checked={draft.addonEditable}
                onChange={(addonEditable) => patch({ addonEditable })}
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

          {/* ------------------------ 5 · Colours & theme ------------------- */}
          <Section
            n={5}
            title="Colors & Theme"
            blurb="Choose your brand colors to define its visual identity."
          >
            {catalog ? (
              <div className="space-y-6">
                <div>
                  <Label className="text-sm font-medium">Primary Color</Label>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {headline.map((p) => (
                      <PaletteCard
                        key={p.id}
                        preset={p}
                        selected={draft.themePreset === p.id}
                        onSelect={() =>
                          patch({
                            themePreset: p.id,
                            primaryColor: p.primary,
                            accentColor: p.accent,
                          })
                        }
                      />
                    ))}
                  </div>
                </div>

                {!!extras.length && (
                  <div>
                    <Label className="text-sm font-medium">Additional Colors</Label>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {visibleExtras.map((p, i) => (
                        <PaletteCard
                          key={p.id}
                          preset={p}
                          selected={draft.themePreset === p.id}
                          // The last tile of the collapsed row carries the
                          // "there are more" affordance, as in the mock.
                          more={
                            !showAllPalettes &&
                            i === visibleExtras.length - 1 &&
                            extras.length > visibleExtras.length
                              ? () => setShowAllPalettes(true)
                              : undefined
                          }
                          onSelect={() =>
                            patch({
                              themePreset: p.id,
                              primaryColor: p.primary,
                              accentColor: p.accent,
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <CatalogSkeleton />
            )}
          </Section>

          {/* --------------------------- 6 · Typography --------------------- */}
          <Section
            n={6}
            title="Typography"
            blurb="Select the fonts for your brand's text and headings."
          >
            {catalog ? (
              <div className="space-y-5">
                <Field
                  id="b-font"
                  label="Font Family"
                  hint="One typeface per brand — used for both headings and body text. Business faces are geometric sans; Classic faces are serif."
                  className="max-w-sm"
                >
                  <Select
                    value={draft.fontFamily}
                    onValueChange={(fontFamily) => patch({ fontFamily })}
                  >
                    <SelectTrigger id="b-font" className="h-10 rounded-xl">
                      <SelectValue placeholder="Select a typeface" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.fonts.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          <span style={{ fontFamily: f.stack }}>{f.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {font && (
                  <TypeSpecimen font={font} primary={draft.primaryColor} accent={draft.accentColor} />
                )}
              </div>
            ) : (
              <CatalogSkeleton />
            )}
          </Section>

          {/* --------------------------- 7 · File uploads ------------------- */}
          <Section
            n={7}
            title="File Uploads"
            blurb="Add the marks for your brand (optional). These replace the platform's everywhere this brand's users look — anything left empty falls back to the platform's own asset."
          >
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              <AssetTile
                label="Light-mode logo"
                hint="SVG, PNG, JPG (Max. 2MB)"
                file={files.logoLight}
                onPick={(file) => setFiles((f) => ({ ...f, logoLight: file }))}
              />
              <AssetTile
                label="Dark-mode logo"
                hint="A light mark for dark backgrounds"
                file={files.logoDark}
                onPick={(file) => setFiles((f) => ({ ...f, logoDark: file }))}
                dark
              />
              <AssetTile
                label="Favicon"
                hint="Square PNG or ICO, 32×32"
                file={files.favicon}
                onPick={(file) => setFiles((f) => ({ ...f, favicon: file }))}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Uploaded the moment the brand is created. This brand's own mail / SMS / WhatsApp
              senders are set up afterwards, from its White-label tab.
            </p>
          </Section>

          {/* ------------------------ 8 · Brand administrator --------------- */}
          <Section
            n={8}
            title="Brand Administrator"
            blurb="Who runs this brand. They get full control of their tenant — and no access to platform keys or any other brand."
            action={
              <Switch checked={withAdmin} onCheckedChange={setWithAdmin} aria-label="Create an admin" />
            }
          >
            {withAdmin ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="b-admin-name" label="Full Name" required>
                  <InputWithIcon icon={<UserCog className="size-4" />}>
                    <Input
                      id="b-admin-name"
                      value={admin.fullName}
                      onChange={(e) => setAdmin((a) => ({ ...a, fullName: e.target.value }))}
                      placeholder="Jordan Blake"
                      className="pl-10"
                      maxLength={80}
                    />
                  </InputWithIcon>
                </Field>
                <Field id="b-admin-email" label="Email" required>
                  <InputWithIcon icon={<Mail className="size-4" />}>
                    <Input
                      id="b-admin-email"
                      type="email"
                      autoComplete="off"
                      value={admin.email}
                      onChange={(e) => setAdmin((a) => ({ ...a, email: e.target.value }))}
                      placeholder="admin@brandname.com"
                      className="pl-10"
                      maxLength={160}
                    />
                  </InputWithIcon>
                </Field>
                <Field
                  id="b-admin-password"
                  label="Temporary Password"
                  required
                  hint="At least 8 characters. They can change it once they're in."
                >
                  <PasswordInput
                    id="b-admin-password"
                    autoComplete="new-password"
                    value={admin.password}
                    onChange={(e) => setAdmin((a) => ({ ...a, password: e.target.value }))}
                    placeholder="At least 8 characters"
                  />
                </Field>
                <div className="sm:pt-6">
                  <ToggleCard
                    id="b-admin-mail"
                    icon={<Mail className="size-4" />}
                    title="Email their credentials"
                    blurb="Sends the address, the temporary password and their sign-in link."
                    checked={admin.sendWelcomeEmail}
                    onChange={(sendWelcomeEmail) => setAdmin((a) => ({ ...a, sendWelcomeEmail }))}
                  />
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                You can add the brand's admin later from its Team tab. Until then only you can
                manage it.
              </p>
            )}
          </Section>

          {/* ------------------------------- Actions ----------------------- */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => navigate("/dashboard/admin/brands")}
            >
              Cancel
            </Button>
            <Button
              size="lg"
              className="px-8"
              disabled={!canSave || saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save Brand
            </Button>
          </div>
        </div>

        {/* ---------------------------- Live preview ----------------------- */}
        <aside className="space-y-5 lg:sticky lg:top-24">
          <Card className="p-5">
            <h3 className="text-sm font-semibold">Brand Preview</h3>

            <div className="mt-4 flex flex-col items-center gap-2 rounded-xl bg-warm p-5">
              <BrandMark
                logoUrl={logoPreview}
                name={draft.name}
                primary={draft.primaryColor}
                accent={draft.accentColor}
                className="size-16 rounded-2xl text-2xl"
              />
              <p
                className="mt-1 max-w-full truncate text-base font-semibold"
                style={font ? { fontFamily: font.stack } : undefined}
              >
                {draft.name || "Brand Name"}
              </p>
              <p className="line-clamp-2 text-center text-xs text-muted-foreground">
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

/* ------------------------------------------------------------------ *
 *  Pieces
 * ------------------------------------------------------------------ */

/** Radix Select refuses an empty item value, so "use the platform's" needs a sentinel. */
const NONE = "__none__";
const TIME_ZONES = listTimeZones();
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

const WHY_BRAND = [
  "Multi-brand management",
  "Separate customer data",
  "Custom branding & domain",
  "Advanced analytics",
  "Dedicated support",
];

/** A blob URL for a picked file, revoked when it's replaced or the page closes. */
function useObjectUrl(file: File | null): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
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
      <div className="mt-1.5">{children}</div>
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

function PaletteCard({
  preset,
  selected,
  more,
  onSelect,
}: {
  preset: { id: string; label: string; primary: string; accent: string; note: string };
  selected: boolean;
  /** When set, the tile also offers to reveal the palettes still hidden. */
  more?: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center gap-3 rounded-xl border p-3 transition-all",
        selected ? "border-primary ring-2 ring-primary/25" : "border-border hover:border-primary/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:focus-ring"
      >
        <span
          className="size-6 shrink-0 rounded-full ring-1 ring-black/5"
          style={{ backgroundColor: preset.primary }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{preset.label}</span>
          <span className="block truncate font-mono text-[11px] uppercase text-muted-foreground">
            {preset.primary}
          </span>
        </span>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </button>
      {more && !selected && (
        <button
          type="button"
          onClick={more}
          aria-label="Show every palette"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}

const FONT_GROUP: Record<BrandFontOption["group"], { label: string; icon: typeof Briefcase }> = {
  business: { label: "Business", icon: Briefcase },
  classic: { label: "Classic", icon: BookOpen },
};

/** A real slice of app chrome set in the chosen face and painted with the
 *  chosen colours — so the choice is judged on how it reads together, not on
 *  the name of a font or the hex of a swatch in isolation. Every colour here
 *  comes from the draft, never a fixed hue, so it repaints the instant either
 *  picker in Colors & Theme changes.
 *
 *  Bleeds to the section card's own edges (cancelling its padding) rather
 *  than sitting boxed in — the same full-bleed treatment the page's hero
 *  uses, so the specimen reads as a real screen, not a swatch in a frame. */
function TypeSpecimen({
  font,
  primary,
  accent,
}: {
  font: BrandFontOption;
  primary: string;
  accent: string;
}) {
  const group = FONT_GROUP[font.group];
  const GroupIcon = group.icon;

  return (
    <div>
      <Label className="text-sm font-medium">Preview</Label>
      {/* Bleeds to the section card's left, right AND bottom edges — the
          bottom corners are rounded to match the card's own radius so the
          strip nests into it instead of leaving a dead gap below. */}
      <div className="relative -mx-5 -mb-5 mt-1.5 overflow-hidden rounded-b-[var(--radius-card)] border-t border-border sm:-mx-6 sm:-mb-6">
        {/* Colour wash — the brand's own hues, not the app's. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 140% at 100% 0%, ${primary}17 0%, transparent 55%),
              radial-gradient(90% 120% at 0% 100%, ${accent}14 0%, transparent 60%)`,
          }}
        />
        <SpecimenGlyphs primary={primary} accent={accent} font={font} />

        {/* Group badge — top-right corner, tinted with the brand's primary. */}
        <span
          className="absolute right-5 top-5 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold sm:right-8 sm:top-7"
          style={{ backgroundColor: `${primary}1a`, color: primary }}
        >
          <GroupIcon className="size-3.5" />
          {group.label}
        </span>

        <div className="relative z-10 px-5 py-7 sm:px-8 sm:py-8 lg:max-w-[62%]">
          <div className="flex items-center gap-3">
            <span
              className="grid size-11 shrink-0 place-items-center rounded-xl text-lg font-semibold text-white shadow-sm"
              style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}
            >
              <span style={{ fontFamily: font.stack }}>Aa</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold">{font.label}</p>
              <p className="truncate text-xs text-muted-foreground">{font.note}</p>
            </div>
          </div>

          <div className="mt-6" style={{ fontFamily: font.stack }}>
            <p className="text-3xl font-bold leading-[1.15] tracking-tight sm:text-[2.25rem]">
              Never miss another call
            </p>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Body text in {font.label} — roughly the density a customer reads on the dashboard.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <span
              className="inline-flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-medium text-white shadow-sm"
              style={{ backgroundColor: primary }}
            >
              Primary action
              <ArrowRight className="size-3.5" />
            </span>
            <span
              className="inline-flex h-10 items-center rounded-xl border-[1.5px] bg-card px-4 text-sm font-medium"
              style={{ borderColor: primary, color: primary }}
            >
              Secondary
            </span>
            <span
              className="inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: `${accent}22`, color: accent }}
            >
              Accent badge
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The decorative right-hand composition in the specimen — a floating "Aa"
 *  card over a tilted glass panel, entirely in the brand's own primary/accent
 *  hues. Purely ornamental (hidden from AT) and dropped below `lg`, where
 *  there's no room for it beside the text. */
function SpecimenGlyphs({
  primary,
  accent,
  font,
}: {
  primary: string;
  accent: string;
  font: BrandFontOption;
}) {
  return (
    // Inset from the strip's own top and bottom — not flush to `inset-0` —
    // so the panel (and its shadow) sit clear of the strip's border instead
    // of getting hard-clipped by the strip's overflow-hidden right at the
    // edge, which read as a stray rectangle rather than a soft shape.
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 inset-y-8 hidden lg:block xl:inset-y-10"
    >
      <div
        className="absolute -right-10 top-1/2 size-56 -translate-y-1/2 rotate-[14deg] rounded-[2rem]"
        style={{
          background: `linear-gradient(135deg, ${primary}33, ${accent}1f)`,
          boxShadow: `0 20px 40px -18px ${primary}40`,
        }}
      />
      <span
        className="absolute right-16 top-1/2 size-2.5 -translate-y-20 rounded-full"
        style={{ backgroundColor: accent }}
      />
      <span
        className="absolute right-28 top-1/2 size-20 -translate-y-6 rounded-full border-2"
        style={{ borderColor: `${primary}55` }}
      />
      <div
        className="absolute right-20 top-1/2 grid size-24 -translate-y-1/2 rotate-[-8deg] place-items-center rounded-2xl bg-card text-3xl font-bold shadow-[var(--shadow-panel)]"
        style={{ color: accent, fontFamily: font.stack }}
      >
        Aa
      </div>
    </div>
  );
}

/** The big click-or-drag logo target from the top of the form. */
function DropZone({
  file,
  accept,
  hint,
  onPick,
}: {
  file: File | null;
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
      {file ? (
        <>
          <p className="max-w-full truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
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

/** A compact file card — the asset row at the foot of the form. */
function AssetTile({
  label,
  hint,
  file,
  dark,
  onPick,
}: {
  label: string;
  hint: string;
  file: File | null;
  dark?: boolean;
  onPick: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const url = useObjectUrl(file);

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
        "group relative flex items-center gap-3 rounded-xl border p-3 transition-colors",
        over ? "border-primary bg-primary-tint-soft" : "border-border hover:border-primary/50",
      )}
    >
      <span
        className={cn(
          "grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border",
          dark ? "bg-foreground/90" : "bg-warm",
        )}
      >
        {url ? (
          <img src={url} alt="" className="max-h-9 max-w-9 object-contain" />
        ) : (
          <ImageIcon className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{file ? file.name : hint}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept={LOGO_ACCEPT + ",image/x-icon,.ico"}
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = ""; // let the same file be re-picked after a removal
        }}
      />
      {/* The whole card is the target. An overlay button rather than a wrapping
          one, because the Remove control below has to stay its own button —
          nesting them would be invalid, and the remove sits above this because
          it comes later in the DOM and is positioned. */}
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label={file ? `Replace ${label}` : `Upload ${label}`}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:focus-ring"
      />
      {file ? (
        <button
          type="button"
          onClick={() => onPick(null)}
          aria-label={`Remove ${label}`}
          className="relative grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-danger-tint hover:text-danger focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      ) : (
        // Decorative once the card itself is the button — it would otherwise be
        // a second tab stop onto the same action.
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors group-hover:text-primary"
        >
          <Upload className="size-4" />
        </span>
      )}
    </div>
  );
}

/** The brand's mark as it will appear — the uploaded logo, or its initial on the
 *  chosen palette until one is picked. */
function BrandMark({
  logoUrl,
  name,
  primary,
  accent,
  className,
}: {
  logoUrl: string;
  name: string;
  primary: string;
  accent: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden font-semibold text-white",
        className,
      )}
      style={
        logoUrl
          ? { background: "var(--color-card)", boxShadow: "inset 0 0 0 1px var(--color-border)" }
          : { background: `linear-gradient(135deg, ${primary}, ${accent})` }
      }
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="size-full object-contain p-1.5" />
      ) : (
        (name.trim()[0] ?? "B").toUpperCase()
      )}
    </span>
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

function CatalogSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}

