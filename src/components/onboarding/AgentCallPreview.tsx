import type { ReactNode } from "react";
import { Check, Loader2, Mail, MessageSquare, Phone } from "lucide-react";
import { EmmaAvatar } from "@/components/brand/EmmaAvatar";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { avatarForVoice, voiceNameFor } from "@/data/voices";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { env } from "@/lib/env";

type Scenario = "training" | "intro" | "services" | "sms" | "email";

type Line = { from: "agent" | "caller"; node: ReactNode };

const CHIPS = ["Books jobs", "Captures leads", "Answers 24/7"];

/**
 * A contextual preview of the AI receptionist, shown beside each onboarding
 * step so the right-hand space reinforces what that step sets up:
 *  - training: the agent learning your business (analysis step)
 *  - intro:    how it greets callers using your business name
 *  - services: a caller asking about one of your services
 *  - sms:      the call-summary text sent to the mobile you enter
 *  - email:    the call-summary email sent to the address you verify
 * All populated live from the onboarding data.
 */
export function AgentCallPreview({ scenario = "intro" }: { scenario?: Scenario }) {
  const businessName = useOnboardingStore((s) => s.data.businessName).trim() || "your business";
  const services = useOnboardingStore((s) => s.data.services);
  const email = useOnboardingStore((s) => s.data.email).trim();
  const mobile = useOnboardingStore((s) => s.data.mobile).trim();
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const agentName = voiceNameFor(voiceId);
  // Keep the service's original casing — many are brand/proper nouns (e.g. "Adobe",
  // "ADDA 247") that look wrong lower-cased ("we handle adobe").
  const service = services[0]?.trim();

  if (scenario === "training") return <TrainingCard businessName={businessName} agentName={agentName} />;
  if (scenario === "sms")
    return <SmsCard businessName={businessName} mobile={mobile} service={service} />;
  if (scenario === "email")
    return <EmailCard businessName={businessName} agentName={agentName} email={email} service={service} />;

  const business = <span className="font-semibold">{businessName}</span>;
  const lines: Line[] =
    scenario === "services"
      ? service
        ? [
            { from: "caller", node: `Hi! Do you offer ${service}?` },
            { from: "agent", node: `Absolutely — we handle ${service}. Can I grab your name for a quick quote?` },
          ]
        : [
            { from: "agent", node: <>Thanks for calling {business}. What can I help you with?</> },
            { from: "caller", node: "I wanted to ask about your services." },
            { from: "agent", node: "Happy to help — which one are you interested in?" },
          ]
      : [
          { from: "agent", node: <>Thanks for calling {business}. How can I help you today?</> },
          { from: "caller", node: "Hi, I had a quick question." },
          { from: "agent", node: "Of course! I can help — may I take your name and number?" },
        ];

  return (
    <Card>
      <PreviewHeader agentName={agentName} />
      <div className="mt-4 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Phone className="size-3" /> Incoming call
      </div>
      <div className="mt-3 space-y-2.5">
        {lines.map((l, i) => (
          <Bubble key={i} side={l.from === "agent" ? "left" : "right"}>
            {l.node}
          </Bubble>
        ))}
      </div>
      <Chips />
    </Card>
  );
}

/* ----------------------------- sub-views ----------------------------- */

function SmsCard({ businessName, mobile, service }: { businessName: string; mobile: string; service?: string }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary-tint text-primary">
            <MessageSquare className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight text-foreground">Text summary</p>
            <p className="truncate text-[11px] text-muted-foreground">to {mobile || "your mobile"}</p>
          </div>
        </div>
        <ExamplePill />
      </div>

      <div className="mt-4 flex">
        <p className="max-w-[88%] rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          <span className="font-semibold">{env.appName}</span> · 📞 New call for {businessName}. Caller asked about{" "}
          {service ?? "your services"} — I saved their name &amp; number. Tap to view.
        </p>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">📱 Texted to your mobile after every call.</p>
    </Card>
  );
}

function EmailCard({
  businessName,
  agentName,
  email,
  service,
}: {
  businessName: string;
  agentName: string;
  email: string;
  service?: string;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-border pb-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
          <Mail className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight text-foreground">
            Call summary — {businessName}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            from {agentName} · to {email || "your inbox"}
          </p>
        </div>
        <ExamplePill />
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row label="Caller">New caller</Row>
        <Row label="Outcome">
          <span className="rounded-full bg-success-tint px-2 py-0.5 text-xs font-medium text-success">
            Lead captured
          </span>
        </Row>
      </dl>

      <p className="mt-3 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-foreground">
        {service ? `Asked about ${service} and wants a quote.` : "Asked about your services and wants a callback."}{" "}
        I saved their details for follow-up.
      </p>

      <p className="mt-3 text-[11px] text-muted-foreground">
        📧 Emailed after every call to the address you're verifying.
      </p>
    </Card>
  );
}

function TrainingCard({ businessName, agentName }: { businessName: string; agentName: string }) {
  const steps: { label: string; done: boolean }[] = [
    { label: "Reading your website", done: true },
    { label: "Learning your services", done: true },
    { label: `Tuning ${agentName}'s voice`, done: false },
  ];
  return (
    <Card>
      <PreviewHeader agentName={agentName} />
      <p className="mt-4 text-sm text-muted-foreground">
        Training on <span className="font-semibold text-foreground">{businessName}</span>…
      </p>
      <ul className="mt-3 space-y-2.5">
        {steps.map(({ label, done }) => (
          <li key={label} className="flex items-center gap-2.5 text-sm">
            <span
              className={
                done
                  ? "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  : "flex size-5 items-center justify-center rounded-full bg-primary-tint text-primary"
              }
            >
              {done ? <Check className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
            </span>
            <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
          </li>
        ))}
      </ul>
      <Chips />
    </Card>
  );
}

/* ----------------------------- primitives ----------------------------- */

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
      {children}
    </div>
  );
}

function PreviewHeader({ agentName }: { agentName: string }) {
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const brandingAssets = useBrandingStore((s) => s.assets);
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <EmmaAvatar size={36} speaking name={agentName} img={avatarForVoice(voiceId, brandingAssets)} />
        <div>
          <p className="text-sm font-semibold leading-tight text-foreground">{agentName}</p>
          <p className="text-[11px] text-muted-foreground">AI receptionist</p>
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success-tint px-2 py-0.5 text-xs font-medium text-success">
        <span className="size-1.5 rounded-full bg-success animate-live" /> Live
      </span>
    </div>
  );
}

function ExamplePill() {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      Example
    </span>
  );
}

function Chips() {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {CHIPS.map((c) => (
        <span
          key={c}
          className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function Bubble({ side, children }: { side: "left" | "right"; children: ReactNode }) {
  if (side === "right") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[82%] rounded-2xl rounded-tr-sm bg-muted px-3.5 py-2 text-sm text-foreground">
          {children}
        </p>
      </div>
    );
  }
  return (
    <div className="flex">
      <p className="max-w-[82%] rounded-2xl rounded-tl-sm bg-primary-tint px-3.5 py-2 text-sm text-foreground">
        {children}
      </p>
    </div>
  );
}
