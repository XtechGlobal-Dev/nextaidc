import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, type Brand, type BrandDnsRecord, type BrandDomain } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The brand's two front doors.
 *
 * The subdomain half is deliberately presented as already finished, because it
 * is: the `*.<platform domain>` wildcard record and its wildcard certificate
 * cover every brand ever created, so there is nothing to configure and nothing
 * that can be got wrong. Showing it as a task would invent work that doesn't
 * exist.
 *
 * The vanity-domain half is the only part with real steps, and every one of
 * them that CAN be ours already is — minting the proof token, registering the
 * hostname with the edge, issuing the certificate. What is left is the one
 * thing only the client can do: publish two records in DNS we don't control.
 *
 * So the panel is written for the person who will actually type those records
 * — usually someone at the client who has never opened a DNS panel — and for
 * the operator who has to hand them over: a numbered checklist, each record
 * laid out the way a registrar's form is, what the record TYPE is in plain
 * words, what is currently there instead when it is wrong, and a ready-to-send
 * message so nothing has to be retyped into an email.
 */
export function BrandDomainSection({ brand }: { brand: Brand }) {
  const [state, setState] = useState<BrandDomain | null>(null);
  // Only reachable for a brand created before the custom domain became
  // required — every brand made since always has one already on file.
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  // Opening the tab on a pending claim asks for a LIVE check: only the verdict
  // is stored, not which record produced it, so stored state would paint both
  // records as outstanding even after the client has added one.
  const load = useCallback(async () => {
    try {
      setState(await api.super.brands.domain(brand.id, { live: true }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load the domain settings.");
    } finally {
      setLoading(false);
    }
  }, [brand.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Claims the domain once, for a legacy brand that has none yet. There is no
  // replace or clear — the server locks the field the moment it is set.
  async function claim() {
    setSaving(true);
    try {
      const res = await api.super.brands.setDomain(brand.id, draft);
      setState(res);
      setDraft(res.domain);
      if (res.edgeMessage && res.edgeAutomated) toast.warning(res.edgeMessage);
      else toast.success("Domain claimed. Send the client the records below.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the domain.");
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setChecking(true);
    try {
      const res = await api.super.brands.verifyDomain(brand.id);
      setState(res);
      if (res.status === "verified") toast.success(`${res.domain} is live.`);
      else toast.warning(res.message || "Not ready yet — DNS may still be propagating.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The check couldn't run.");
    } finally {
      setChecking(false);
    }
  }

  const handoff = useMemo(
    () => (state?.domain ? handoffText(state, brand.name) : ""),
    [state, brand.name],
  );

  async function copyHandoff() {
    try {
      await navigator.clipboard.writeText(handoff);
      toast.success("Instructions copied — paste them into an email to the client.");
    } catch {
      toast.error("Couldn't copy. Open the preview below and copy it by hand.");
    }
  }

  if (loading) {
    return (
      <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading the domain and checking its DNS…
      </Card>
    );
  }

  const draftDomain = cleanDomain(draft);
  const draftIsApex = Boolean(draftDomain) && looksLikeApex(draftDomain);
  const verified = state?.status === "verified";
  const apiHost = state?.apiOrigin?.replace(/^https?:\/\//, "") || "";

  return (
    <div className="space-y-5">
      {/* ---------------------- The subdomain: already done ------------------- */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="size-4 text-primary" /> Platform subdomain
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Covered by the wildcard DNS record and its wildcard certificate, so it started
              working the moment this brand was created. Nothing to configure.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
                {state?.platformHost}
              </code>
              <CopyButton value={state?.platformUrl ?? ""} label="subdomain" />
              <a
                href={state?.platformUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3" /> Open
              </a>
            </div>
            {state?.pathUrl && (
              <p className="mt-2 text-xs text-muted-foreground">
                Needs no DNS at all:{" "}
                <code className="font-mono">{state.pathUrl}</code> — the address that still works
                while a record propagates or on a preview deployment.
              </p>
            )}
          </div>
          <Badge variant="success" className="shrink-0">
            Live
          </Badge>
        </div>
      </Card>

      {/* -------------------- The vanity domain: the real work ---------------- */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="size-4 text-primary" /> Brand&rsquo;s own domain
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Once verified, every link this brand sends — login emails, unsubscribe footers, the
              &ldquo;more info&rdquo; link in a call-summary SMS — switches to it automatically.
            </p>
          </div>
          <DomainBadge status={state?.status ?? "none"} />
        </div>

        {state?.domain ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{state.domain}</code>
            <span className="text-xs text-muted-foreground">
              Set at creation and locked — it can&rsquo;t be replaced or removed here.
            </span>
          </div>
        ) : (
          <>
            {/* Only a brand created before the custom domain became required
                lands here — every brand made since has one on file already,
                and this claim is a one-time, unrepeatable action. */}
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1">
                <Label htmlFor="vanity-domain">Domain</Label>
                <Input
                  id="vanity-domain"
                  className="mt-1.5 font-mono"
                  spellCheck={false}
                  autoCapitalize="none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="app.acmevoice.com"
                />
              </div>
              <Button onClick={() => void claim()} disabled={saving || !draftDomain}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Claim domain
              </Button>
            </div>

            {/* A root domain is where nearly every setup goes wrong, and the
                moment to say so is while it is being typed — before the claim
                locks in for good. */}
            {draftIsApex ? (
              <Notice tone="warn">
                <strong className="font-mono">{draftDomain}</strong> is a{" "}
                <strong>root domain</strong>. Pointing it here replaces whatever website is at that
                address today, and it needs an A record instead of a simple CNAME. Unless the
                client wants exactly that, ask for a subdomain:{" "}
                <button
                  type="button"
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                  onClick={() => setDraft(`app.${draftDomain}`)}
                >
                  use app.{draftDomain}
                </button>
              </Notice>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Ask the client for a <strong>subdomain</strong> like <code>app.</code> or{" "}
                <code>voice.</code> rather than the root. A subdomain is one simple CNAME record
                and leaves their existing website untouched. This claim is permanent once saved.
              </p>
            )}
          </>
        )}

        {/* The split, stated where the operator is looking: the client's domain
            carries the app and nothing else. Everything a provider calls back
            into — and the public call pages — stays on the platform's API host,
            so there is no second record to hand over and nothing to register. */}
        <Notice tone="info">
          Only the <strong>app</strong> is served from this domain. The API, the call webhooks,
          the public call pages and the Google sign-in callback stay on{" "}
          <code className="font-mono">{apiHost || "the platform API"}</code> for every brand
          &mdash; nothing to configure there.
        </Notice>
      </Card>

      {/* ------------- The checklist: two records for the client, one for us --- */}
      {state?.domain && (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-[18rem] flex-1">
              <h3 className="text-sm font-semibold">What the client needs to do</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Add the two records below wherever DNS for{" "}
                <code className="font-mono">{zoneOf(state.domain)}</code> is managed — GoDaddy,
                Cloudflare, Namecheap, Squarespace, Google Domains… That is their whole job. We
                issue the certificate and switch the brand over on our own once the records
                appear; nobody has to report back.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copyHandoff()} disabled={verified}>
                <ClipboardCopy className="size-4" /> Copy instructions
              </Button>
              <Button variant="outline" onClick={() => void verify()} disabled={checking}>
                {checking ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Check now
              </Button>
            </div>
          </div>

          <ol className="mt-4 space-y-3">
            {state.records.map((r) => (
              <RecordStep key={`${r.type}-${r.fqdn}`} record={r} checked={Boolean(state.checkedAt)} />
            ))}
            <EdgeStep state={state} />
          </ol>

          {verified ? (
            <Notice tone="ok">
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>
                  Live at <code className="font-mono">{state.origin}</code> — this brand&rsquo;s
                  links now use it.
                </span>
                <CopyButton value={state.origin ?? ""} label="URL" />
              </span>
            </Notice>
          ) : state.message ? (
            <Notice tone="warn">
              <strong>Next:</strong> {state.message}
            </Notice>
          ) : (
            <Notice tone="info">
              Not checked yet. Records usually show up within a few minutes, occasionally up to an
              hour. We re-check every 5 minutes on our own; &ldquo;Check now&rdquo; just skips the
              wait.
            </Notice>
          )}

          <details className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground">
              Tips for whoever adds the records
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
              <li>
                <strong>Where:</strong> the DNS panel of the company the domain is registered with
                — or, if the nameservers were moved, at Cloudflare or the web host.
              </li>
              <li>
                <strong>Name column:</strong> most providers add{" "}
                <code className="font-mono">.{zoneOf(state.domain)}</code> themselves, so enter the
                short name shown. If the saved record shows the domain twice, that is why.
              </li>
              <li>
                <strong>Value column</strong> may be called <em>Points to</em>, <em>Target</em>,{" "}
                <em>Content</em> or <em>Data</em>. Same thing.
              </li>
              <li>
                <strong>Cloudflare:</strong> the {state.records.find((r) => r.step === 2)?.type}{" "}
                record must be &ldquo;DNS only&rdquo; (grey cloud), not &ldquo;Proxied&rdquo;.
              </li>
              <li>
                <strong>Don&rsquo;t remove anything.</strong> Existing records (email, the main
                website) stay as they are — only add the two above.
              </li>
            </ul>
          </details>

          {!verified && (
            <details className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground">
                Preview the message &ldquo;Copy instructions&rdquo; puts on the clipboard
              </summary>
              <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap wrap-break-word rounded bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                {handoff}
              </pre>
            </details>
          )}

          {state.checkedAt && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Last checked {new Date(state.checkedAt).toLocaleString()}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/* --------------------------------- Helpers -------------------------------- */

/** What someone typed, reduced to a bare hostname — tolerant of a pasted URL. */
function cleanDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
}

/** Same heuristic the server uses to pick A over CNAME: two labels is a root. */
function looksLikeApex(domain: string): boolean {
  return domain.split(".").length <= 2;
}

/** The zone the client administers — the registrable domain behind the host. */
function zoneOf(domain: string): string {
  const parts = domain.split(".");
  return parts.length <= 2 ? domain : parts.slice(-2).join(".");
}

type RecordState = "unchecked" | "found" | "wrong" | "missing";

function recordState(r: BrandDnsRecord, checked: boolean): RecordState {
  if (!r.required) return "found";
  if (!checked) return "unchecked";
  return r.seen.length ? "wrong" : "missing";
}

function nameHint(r: BrandDnsRecord): string {
  if (r.name === "@") {
    return `"@" means the root domain itself (${r.fqdn}). Some panels want it left blank instead.`;
  }
  return `If the panel wants the full name: ${r.fqdn}`;
}

/**
 * The message the operator forwards to the client, built from the same records
 * the panel shows so the two can never drift. Plain text on purpose: it is
 * going into an email or a chat, and the person reading it is not looking at
 * this screen.
 */
function handoffText(state: BrandDomain, brandName: string): string {
  const zone = zoneOf(state.domain);
  const lines: string[] = [
    `DNS setup for ${state.domain} (${brandName})`,
    "",
    `Please add the ${state.records.length} records below wherever DNS for ${zone} is managed (GoDaddy, Cloudflare, Namecheap, Squarespace, Google Domains, etc.). That is everything: we issue the certificate and switch the app over automatically once the records appear. Do not remove any existing records.`,
  ];
  for (const r of state.records) {
    const article = r.type === "A" ? "an" : "a";
    lines.push("", `${r.step}) ${r.title} — ${article} ${r.type} record`, `   ${r.what}`, `   Type:  ${r.type}`);
    lines.push(
      r.name === "@"
        ? `   Name:  @   ("@" is the root domain itself, ${r.fqdn}; some panels want it left blank)`
        : `   Name:  ${r.name}   (full name, if the panel asks for it: ${r.fqdn})`,
    );
    lines.push(`   Value: ${r.value}`, `   TTL:   ${r.ttl}`);
    for (const n of r.notes) lines.push(`   Note:  ${n}`);
  }
  lines.push(
    "",
    "Tips",
    `- Most providers add ".${zone}" to the Name automatically, so enter the short name shown.`,
    "- The Value column may be called Points to, Target, Content or Data.",
    "- Changes usually show within a few minutes, occasionally up to an hour. Nothing to send back — we check automatically.",
  );
  return lines.join("\n");
}

/* ------------------------------- Sub-parts -------------------------------- */

function DomainBadge({ status }: { status: BrandDomain["status"] }) {
  if (status === "verified") return <Badge variant="success">Verified</Badge>;
  if (status === "pending") return <Badge variant="warning">Awaiting DNS</Badge>;
  if (status === "error") return <Badge variant="danger">Failed</Badge>;
  return <Badge variant="neutral">Not set</Badge>;
}

/**
 * One step of the client's checklist: what it achieves, what the record type
 * is, the four registrar fields, and — after a check — whether DNS agrees.
 */
function RecordStep({ record, checked }: { record: BrandDnsRecord; checked: boolean }) {
  const st = recordState(record, checked);
  const done = st === "found";
  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        done && "border-success/40 bg-success/5",
        st === "wrong" && "border-warning/40 bg-warning/5",
        (st === "missing" || st === "unchecked") && "border-border bg-muted/30",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-[16rem] flex-1 items-start gap-3">
          <StepNumber n={record.step} done={done} />
          <div className="min-w-0">
            <div className="text-sm font-semibold">{record.title}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{record.type} record.</span>{" "}
              {record.what}
            </p>
          </div>
        </div>
        <RecordStatus state={st} record={record} />
      </div>

      <div className="mt-3 grid gap-3 rounded-md border border-border/60 bg-background p-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.6fr)_7.5rem]">
        <Field label="Type" value={record.type} copy={false} />
        <Field label="Name / Host" value={record.name} hint={nameHint(record)} />
        <Field label="Value" value={record.value} />
        <Field label="TTL" value={record.ttl} copy={false} />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        <strong>Why:</strong> {record.why}
      </p>
      {record.notes.map((n) => (
        <p
          key={n}
          className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
          <span>{n}</span>
        </p>
      ))}
    </li>
  );
}

/**
 * Step 3 is ours, and says so — the certificate and go-live happen without the
 * client. The one case where it becomes somebody's task is a deployment with no
 * hosting API token, where the operator has to register the hostname by hand.
 */
function EdgeStep({ state }: { state: BrandDomain }) {
  const dnsDone = state.ownershipOk && state.routingOk;
  const live = state.status === "verified";

  let tone: "ok" | "warn" | "wait" = "wait";
  let label = "Waits for 1 and 2";
  let body: React.ReactNode = (
    <>
      Nothing for the client here. Once both records resolve, our edge issues the certificate
      on its own — usually within a few minutes.
    </>
  );

  if (live) {
    tone = "ok";
    label = "Live";
    body = (
      <>
        Certificate issued. <code className="font-mono">{state.domain}</code> is serving this
        brand.
      </>
    );
  } else if (!state.edgeAutomated) {
    tone = "warn";
    label = "Needs you";
    body = (
      <>
        No hosting API token is configured, so <code className="font-mono">{state.domain}</code>{" "}
        was not registered with the edge automatically. Add it to the hosting project by hand —
        until then the address shows the host&rsquo;s error page even once DNS is right. The DNS
        checks above don&rsquo;t depend on this.
      </>
    );
  } else if (state.edgeMessage) {
    tone = "warn";
    label = "Attention";
    body = <>{state.edgeMessage}</>;
  } else if (dnsDone && !state.edgeOk) {
    tone = "warn";
    label = "In progress";
    body = (
      <>
        {state.message ||
          "The edge hasn't issued the certificate yet — this usually clears on the next check."}
      </>
    );
  }

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        tone === "ok" && "border-success/40 bg-success/5",
        tone === "warn" && "border-warning/40 bg-warning/5",
        tone === "wait" && "border-dashed border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-[16rem] flex-1 items-start gap-3">
          <StepNumber n={3} done={live} />
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              Certificate and go-live{" "}
              <span className="font-normal text-muted-foreground">— our side</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
          </div>
        </div>
        <Badge variant={tone === "ok" ? "success" : tone === "warn" ? "warning" : "neutral"}>
          {tone === "ok" && <Check className="size-3" />}
          {label}
        </Badge>
      </div>
    </li>
  );
}

function StepNumber({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        done
          ? "border-success/40 bg-success-tint text-success"
          : "border-border bg-background text-muted-foreground",
      )}
      aria-label={done ? `Step ${n} done` : `Step ${n}`}
    >
      {done ? <Check className="size-3.5" /> : n}
    </span>
  );
}

/** Found / not yet / wrong — and, when wrong, what is there instead. */
function RecordStatus({ state, record }: { state: RecordState; record: BrandDnsRecord }) {
  if (state === "found") {
    return (
      <Badge variant="success">
        <Check className="size-3" /> Found in DNS
      </Badge>
    );
  }
  if (state === "wrong") {
    return (
      <div className="flex max-w-xs flex-col items-end gap-1">
        <Badge variant="warning">
          <AlertTriangle className="size-3" />
          {record.type === "TXT" ? "Old value in place" : "Points somewhere else"}
        </Badge>
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={record.seen.join(", ")}>
          currently: {record.seen.join(", ")}
        </span>
      </div>
    );
  }
  return <Badge variant="neutral">{state === "missing" ? "Not found yet" : "Not checked yet"}</Badge>;
}

function Field({
  label,
  value,
  hint,
  copy = true,
}: {
  label: string;
  value: string;
  hint?: string;
  copy?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {value}
        </code>
        {copy && <CopyButton value={value} label={label} />}
      </div>
      {hint && (
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "info"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-2 rounded-lg border p-3 text-xs",
        tone === "ok" && "border-success/40 bg-success/5 text-success",
        tone === "warn" && "border-warning/40 bg-warning/5 text-warning",
        tone === "info" && "border-border bg-muted/30 text-muted-foreground",
      )}
    >
      {tone === "ok" ? (
        <Check className="mt-0.5 size-3.5 shrink-0" />
      ) : tone === "warn" ? (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
