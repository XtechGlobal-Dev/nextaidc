import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Clock, Globe, Loader2, XCircle } from "lucide-react";
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
import {
  api,
  ApiError,
  type BrandAdminRequestState,
  type BrandThemeCatalog,
} from "@/lib/api";
import {
  BrandMark,
  CatalogSkeleton,
  ColoursChoice,
  LogosChoice,
  PUBLIC_LOGO_ACCEPT,
  TypographyPicker,
  useCatalogFonts,
  useObjectUrl,
  type LogoSlot,
} from "@/components/brand/BrandLookPickers";
import { cn } from "@/lib/utils";

// "Become a Brand" (docs/brand-as-customer-plan.md): a main-domain customer asks for their own account to become a
// white-label brand. The platform reviews it; once approved — and once their own domain is live, if they named
// one — this same account becomes the Brand Admin and signs in on the brand's domain from then on.

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

export default function BrandAdminRequestPage() {
  const [state, setState] = useState<BrandAdminRequestState | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.brandAdminRequest.status());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load your brand request");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const request = state?.request ?? null;
  const canAsk = !!state?.eligible && (!request || request.status === "declined");

  return (
    <div>
      <PageHeader
        title="Become a Brand"
        subtitle="Resell the platform under your own name and domain. Your AI assistant, number and plan stay exactly as they are."
      />

      {!state ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            {request && <RequestStatus request={request} suffix={state.subdomainSuffix} />}

            {canAsk && (
              <Card className="flex flex-col gap-3 p-6">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-primary-tint text-primary">
                    <Building2 className="size-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{request ? "Ask again" : "Request Brand Admin"}</p>
                    <p className="text-sm text-muted-foreground">Tell us about your brand. Our team reviews every request.</p>
                  </div>
                </div>
                <div>
                  <Button onClick={() => setOpen(true)}>
                    <Building2 className="size-4" /> Request Brand Admin
                  </Button>
                </div>
              </Card>
            )}

            {!state.eligible && !request && (
              <Card className="flex flex-col gap-3 p-6">
                <p className="font-semibold">Start a plan first</p>
                <p className="text-sm text-muted-foreground">{state.reason}</p>
                <div>
                  <Button asChild variant="outline">
                    <Link to="/dashboard/plans">See plans</Link>
                  </Button>
                </div>
              </Card>
            )}
          </div>

          <Card className="h-fit p-5 text-sm">
            <p className="mb-3 font-semibold">How it works</p>
            <ol className="space-y-2 text-muted-foreground">
              <li>1. Send your brand's basics — name, address, your own domain if you have one.</li>
              <li>2. Our team reviews and sets your brand up.</li>
              <li>3. Your account becomes the Brand Admin. You sign in on your brand's domain from then on.</li>
              <li>4. Add your own customers. A brand keeps its status while it has at least one active customer.</li>
            </ol>
          </Card>
        </div>
      )}

      {state && (
        <RequestDialog
          open={open}
          onOpenChange={setOpen}
          suffix={state.subdomainSuffix}
          onFiled={async () => {
            setOpen(false);
            toast.success("Request sent — we'll email you when it's reviewed");
            await load();
          }}
        />
      )}
    </div>
  );
}

function RequestStatus({
  request,
  suffix,
}: {
  request: NonNullable<BrandAdminRequestState["request"]>;
  suffix: string;
}) {
  if (request.status === "awaiting_domain") {
    return (
      <Card className="space-y-3 p-6">
        <div className="flex items-center gap-2 font-semibold">
          <Globe className="size-5 text-primary" /> {request.brandName} is approved — connect {request.customDomain}
        </div>
        <p className="text-sm text-muted-foreground">
          Add these records with your domain provider. We check every few minutes; as soon as the domain is live your
          account becomes the Brand Admin and you'll sign in there.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {request.dns.map((r) => (
                <tr key={`${r.type}-${r.fqdn}`} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-mono">{r.type}</td>
                  <td className="break-all px-3 py-2 font-mono">{r.fqdn}</td>
                  <td className="break-all px-3 py-2 font-mono">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {request.domainError && <p className="text-xs text-muted-foreground">Last check: {request.domainError}</p>}
      </Card>
    );
  }
  if (request.status === "declined") {
    return (
      <Card className="space-y-2 p-6">
        <div className="flex items-center gap-2 font-semibold">
          <XCircle className="size-5 text-danger" /> Your request for {request.brandName} wasn't approved
        </div>
        {request.declineReason && <p className="text-sm text-muted-foreground">{request.declineReason}</p>}
        <p className="text-xs text-muted-foreground">Reviewed {fmtDate(request.reviewedAt)}</p>
      </Card>
    );
  }
  if (request.status === "approved") {
    return (
      <Card className="flex items-center gap-2 p-6 font-semibold">
        <CheckCircle2 className="size-5 text-success" /> {request.brandName} is live.
      </Card>
    );
  }
  return (
    <Card className="space-y-2 p-6">
      <div className="flex items-center gap-2 font-semibold">
        <Clock className="size-5 text-warning" /> {request.brandName} is in review
      </div>
      <p className="text-sm text-muted-foreground">
        Requested {fmtDate(request.createdAt)} ·{" "}
        {request.customDomain || `${request.slug}${suffix}`}. We'll email you as soon as it's reviewed.
      </p>
    </Card>
  );
}

const STEPS = ["Your brand", "Look & logo"] as const;

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FAVICON_TYPES = new Set([...LOGO_TYPES, "image/x-icon", "image/vnd.microsoft.icon"]);

/** The look as the dialog holds it: the platform's defaults until the catalog says otherwise. */
interface Look {
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
}

function RequestDialog({
  open,
  onOpenChange,
  suffix,
  onFiled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suffix: string;
  onFiled: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [brandName, setBrandName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [customDomain, setCustomDomain] = useState("");
  const [tagline, setTagline] = useState("");
  const [notes, setNotes] = useState("");
  const [slugState, setSlugState] = useState<{ available: boolean; reason: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [catalog, setCatalog] = useState<(BrandThemeCatalog & { uploadsEnabled: boolean }) | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [look, setLook] = useState<Look>({
    themePreset: "ocean",
    primaryColor: "#2C76ED",
    accentColor: "#7C5CFC",
    fontFamily: "inter",
  });
  const [logos, setLogos] = useState<Record<LogoSlot, File | null>>({ logoLight: null, logoDark: null, favicon: null });
  const logoPreview = useObjectUrl(logos.logoLight);
  useCatalogFonts(catalog);

  // The palettes and typefaces, fetched the first time the dialog opens; the defaults follow the catalog's.
  useEffect(() => {
    if (!open || catalog) return;
    api.brandAdminRequest
      .catalog()
      .then((c) => {
        setCatalog(c);
        setCatalogFailed(false);
        const preset = c.presets.find((p) => p.id === c.defaults.preset);
        setLook((l) =>
          l.themePreset === "ocean" && l.fontFamily === "inter" && preset
            ? { themePreset: preset.id, primaryColor: preset.primary, accentColor: preset.accent, fontFamily: c.defaults.font }
            : l,
        );
      })
      .catch(() => setCatalogFailed(true));
  }, [open, catalog]);

  // Every opening starts on the first step; what was typed is kept.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // The address follows the name until they edit it themselves.
  useEffect(() => {
    if (!slugEdited) setSlug(brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40));
  }, [brandName, slugEdited]);

  // Availability is checked once typing settles, not per keystroke.
  useEffect(() => {
    if (!slug) {
      setSlugState(null);
      return;
    }
    const t = setTimeout(() => {
      api.brandAdminRequest
        .checkSlug(slug)
        .then((r) => setSlugState({ available: r.available, reason: r.reason }))
        .catch(() => setSlugState(null));
    }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  /** Checked here as well as on the server, so a wrong file is caught before sending. */
  function pickLogo(slot: LogoSlot, file: File | null) {
    if (file) {
      const types = slot === "favicon" ? FAVICON_TYPES : LOGO_TYPES;
      if (!types.has(file.type)) {
        toast.error(`Use a PNG, JPG, WebP or GIF${slot === "favicon" ? " (or ICO)" : ""} image.`);
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        toast.error("That image is over 2 MB. Please use a smaller one.");
        return;
      }
    }
    setLogos((l) => ({ ...l, [slot]: file }));
  }

  const submit = async () => {
    setSaving(true);
    try {
      await api.brandAdminRequest.create(
        {
          brandName: brandName.trim(),
          slug,
          customDomain: customDomain.trim() || undefined,
          tagline: tagline.trim() || undefined,
          notes: notes.trim() || undefined,
          // Without the catalog nothing was really chosen — the team picks the look with them at setup.
          ...(catalog ? look : {}),
        },
        {
          logoLight: logos.logoLight ?? undefined,
          logoDark: logos.logoDark ?? undefined,
          favicon: logos.favicon ?? undefined,
        },
      );
      await onFiled();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send the request");
    } finally {
      setSaving(false);
    }
  };

  const basicsReady = brandName.trim().length >= 2 && !!slug && slugState?.available !== false;
  const last = step === STEPS.length - 1;
  const font = catalog?.fonts.find((f) => f.id === look.fontFamily);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className={cn(step === 1 ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <DialogHeader>
          <p className="text-xs font-medium text-muted-foreground">
            Step {step + 1} of {STEPS.length}
          </p>
          <DialogTitle>{step === 0 ? "Request Brand Admin" : STEPS[step]}</DialogTitle>
          {/* Step 2 says what it's for in its brand card, so the header only names it (still announced). */}
          <DialogDescription className={cn(step === 1 && "sr-only")}>
            {step === 0
              ? "The basics of your brand. Our team sets up the rest with you."
              : "How your brand looks to its customers. Our team can fine-tune it later."}
          </DialogDescription>
        </DialogHeader>

        <form
          id="bar-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!basicsReady || saving) return;
            if (last) void submit();
            else setStep(step + 1);
          }}
        >
          {step === 0 ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bar-name">Brand name</Label>
                <Input id="bar-name" value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={60} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bar-slug">Address</Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="bar-slug"
                    value={slug}
                    onChange={(e) => {
                      setSlugEdited(true);
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40));
                    }}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>
                </div>
                {slugState && !slugState.available && <p className="text-xs text-danger">{slugState.reason}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bar-domain">Your own domain (optional)</Label>
                <Input
                  id="bar-domain"
                  value={customDomain}
                  onChange={(e) => setCustomDomain(e.target.value)}
                  placeholder="app.yourbrand.com"
                  maxLength={253}
                />
                <p className="text-xs text-muted-foreground">
                  With your own domain, your account becomes the Brand Admin once that domain is connected.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bar-about">About your brand (optional)</Label>
                <Input id="bar-about" value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={500} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bar-notes">Anything else (optional)</Label>
                <Input id="bar-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
              </div>
            </>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
                <BrandMark
                  logoUrl={logoPreview}
                  name={brandName}
                  primary={look.primaryColor}
                  accent={look.accentColor}
                  className="size-11 rounded-xl text-base"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" style={{ fontFamily: font?.stack }}>
                    {brandName.trim() || "Your brand"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    How your brand looks to its customers. Our team can fine-tune it later.
                  </p>
                </div>
              </div>

              {/* Colours and logos each open their own dialog; the font and its live preview stay here,
                  where the colour choice shows up as soon as it's made. */}
              <div className="grid gap-3 sm:grid-cols-2">
                <ColoursChoice
                  presets={catalog?.presets ?? null}
                  value={look.themePreset}
                  primary={look.primaryColor}
                  accent={look.accentColor}
                  brandName={brandName}
                  logoUrl={logoPreview}
                  onPick={(p) => setLook((l) => ({ ...l, themePreset: p.id, primaryColor: p.primary, accentColor: p.accent }))}
                  pendingLabel={catalogFailed ? "Unavailable right now" : "Loading…"}
                />
                <LogosChoice
                  files={logos}
                  onPick={pickLogo}
                  accept={PUBLIC_LOGO_ACCEPT}
                  lightHint="For light backgrounds"
                  unavailable={catalog && !catalog.uploadsEnabled ? "Collected during setup" : undefined}
                  description={
                    <>
                      All optional — anything you skip shows your brand&rsquo;s initial on your colours. PNG, JPG,
                      WebP or GIF up to 2 MB. Have an SVG? Send it to our team and they&rsquo;ll add it during setup.
                    </>
                  }
                />
              </div>

              {catalog ? (
                <TypographyPicker
                  id="bar-font"
                  fonts={catalog.fonts}
                  value={look.fontFamily}
                  primary={look.primaryColor}
                  accent={look.accentColor}
                  onChange={(fontFamily) => setLook((l) => ({ ...l, fontFamily }))}
                />
              ) : catalogFailed ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  We couldn&rsquo;t load the colour and font choices right now. Send the request anyway — our team
                  will pick them with you during setup.
                </p>
              ) : (
                <CatalogSkeleton />
              )}
            </div>
          )}
        </form>

        <DialogFooter className="border-t border-border pt-4">
          {step > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={saving}>
              <ArrowLeft className="size-4" /> Back
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="submit" form="bar-form" disabled={!basicsReady || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {last ? "Send request" : "Continue"}
            {!last && <ArrowRight className="size-4" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
