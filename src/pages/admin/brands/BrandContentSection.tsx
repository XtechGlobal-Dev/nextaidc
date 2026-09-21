import { Code2, FileText, Link2, Scale } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { SetupDraft } from "./brandSetupDraft";

// Customer-facing copy and links: sign-in text, sites, email legal identity, analytics snippets.

type ContentKeys =
  | "loginHeadline"
  | "loginBlurb"
  | "websiteUrl"
  | "helpUrl"
  | "legalName"
  | "legalAddress"
  | "termsUrl"
  | "privacyUrl";

export function BrandContentSection({
  value,
  onChange,
}: {
  value: SetupDraft;
  onChange: (patch: Partial<SetupDraft>) => void;
}) {
  const text = (key: ContentKeys, label: string, placeholder: string, hint?: string) => (
    <div>
      <Label htmlFor={`bc-${key}`}>{label}</Label>
      <Input
        id={`bc-${key}`}
        className="mt-2"
        value={value[key]}
        onChange={(e) => onChange({ [key]: e.target.value } as Partial<SetupDraft>)}
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  const year = new Date().getFullYear();

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <SectionHead
          icon={FileText}
          title="Sign-in screen"
          blurb="The first words a customer reads. Blank keeps the platform's lines."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {text("loginHeadline", "Headline", "Welcome back")}
          {text("loginBlurb", "Sub-line", "Sign in to your AI receptionist dashboard")}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <SectionHead
          icon={Link2}
          title="Links"
          blurb="Where the app's Help link and the email footer point. A bare domain is fine."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {text("websiteUrl", "Website", "acmevoice.com")}
          {text("helpUrl", "Help centre", "help.acmevoice.com")}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <SectionHead
          icon={Scale}
          title="Legal footer"
          blurb="Every email this brand sends is signed with these, not the platform's. Most jurisdictions require a sender's legal name and postal address on commercial email."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {text("legalName", "Legal entity", "Acme Voice Pty Ltd")}
          {text("legalAddress", "Postal address", "12 Example St, Sydney NSW 2000")}
          {text("termsUrl", "Terms of service", "acmevoice.com/terms")}
          {text("privacyUrl", "Privacy policy", "acmevoice.com/privacy")}
        </div>
        {/* A literal preview of the footer's legal lines — the operator sees
            what the client's customers will, without sending a test mail. */}
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p>
            © {year} {value.legalName.trim() || "the brand name"}. All rights reserved.
          </p>
          {value.legalAddress.trim() && <p>{value.legalAddress}</p>}
          {(value.websiteUrl.trim() || value.termsUrl.trim() || value.privacyUrl.trim()) && (
            <p>
              {[
                value.websiteUrl.trim() && "Website",
                value.termsUrl.trim() && "Terms",
                value.privacyUrl.trim() && "Privacy",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <SectionHead
          icon={Code2}
          title="Scripts"
          blurb="Analytics, tag managers, chat widgets. On this brand's pages these replace the platform's snippets entirely — a tenant's app never carries the platform's tracking."
        />
        <div className="grid gap-4">
          <ScriptField
            id="head"
            label="In <head>"
            value={value.scripts.head}
            onChange={(head) => onChange({ scripts: { ...value.scripts, head } })}
          />
          <ScriptField
            id="body"
            label="Start of <body>"
            value={value.scripts.body}
            onChange={(body) => onChange({ scripts: { ...value.scripts, body } })}
          />
          <ScriptField
            id="footer"
            label="End of <body>"
            value={value.scripts.footer}
            onChange={(footer) => onChange({ scripts: { ...value.scripts, footer } })}
          />
        </div>
      </Card>
    </div>
  );
}

function SectionHead({
  icon: Icon,
  title,
  blurb,
}: {
  icon: typeof FileText;
  title: string;
  blurb: string;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="size-4 text-primary" /> {title}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}

function ScriptField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={`bc-script-${id}`}>{label}</Label>
      <textarea
        id={`bc-script-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={4}
        placeholder="<script>…</script>"
        className={cn(
          "mt-2 flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      />
    </div>
  );
}
