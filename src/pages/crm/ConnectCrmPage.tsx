import { useCallback, useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Crown,
  Database,
  Info,
  LifeBuoy,
  Link2,
  ListChecks,
  ScrollText,
  Sparkles,
  Webhook,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/misc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DataCard, DataCardHeader, DataCardGrid, CardField } from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { useCrmStore } from "@/stores/useCrmStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { api } from "@/lib/api";
import { PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import type { WebhookDelivery } from "@/types";
import { ProviderCard } from "./ProviderCard";
import { EmptyArt, ProviderFlowArt } from "./illustrations";
import { env } from "@/lib/env";

// Cache the last-known entitlement so the lock state doesn't flicker on reload.
const CUSTOM_CRM_CACHE_KEY = "hello22_custom_crm_allowed";

export default function ConnectCrmPage() {
  const crm = useCrmStore((s) => s.crm);
  const selectProvider = useCrmStore((s) => s.selectProvider);
  const setNexleon = useCrmStore((s) => s.setNexleon);
  const isAdmin = useAuthStore((s) => s.isAdmin);

  // Custom CRM (webhook) delivery is a per-plan entitlement. Optimistic default
  // (last-known value) while the real flag loads; the backend enforces anyway.
  const [customCrmAllowed, setCustomCrmAllowed] = useState<boolean>(
    () => localStorage.getItem(CUSTOM_CRM_CACHE_KEY) !== "0",
  );
  useEffect(() => {
    let active = true;
    api.notifications
      .channels()
      .then((c) => {
        if (!active) return;
        setCustomCrmAllowed(c.customCrm);
        localStorage.setItem(CUSTOM_CRM_CACHE_KEY, c.customCrm ? "1" : "0");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Google Calendar was removed as a provider — treat any previously-saved
  // selection of it as "nothing selected" so the picker prompt shows instead.
  const rawSelected = crm.connectedProvider === "google_calendar" ? null : crm.connectedProvider;
  // When the admin has set a company-default Nexleon CRM, default the view to it
  // so every user sees the active destination (they can still pick Custom).
  const hasCompanyDefault = Boolean(crm.defaultNexleonUrl && crm.defaultNexleonFormKey);
  const selected = rawSelected ?? (hasCompanyDefault ? "perfex" : null);

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          title="CRM Lead Delivery"
          subtitle="Send every qualified lead straight into your CRM."
          className="mb-4"
        />
        <span aria-hidden className="block h-1 w-14 rounded-full bg-primary" />
      </div>

      {/* Provider selector */}
      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <ProviderCard
          icon={Database}
          name="Nexleon CRM"
          description="Push leads directly into your Nexleon CRM."
          selected={selected === "perfex"}
          illustration={<ProviderFlowArt icon={Database} />}
          onSelect={() => selectProvider("perfex")}
        />
        <ProviderCard
          icon={Link2}
          name="Custom CRM"
          description={
            customCrmAllowed
              ? "Connect to any platform via webhook."
              : "Connect to any platform via webhook. Available on plans that include Custom CRM integration."
          }
          gated={!customCrmAllowed}
          eyebrow={customCrmAllowed ? undefined : "Premium"}
          selected={selected === "custom"}
          illustration={<ProviderFlowArt icon={Webhook} />}
          onSelect={() => selectProvider("custom")}
        />
      </section>

      {/* Selected provider content */}
      <section>
        {selected === "perfex" && (
          <NexleonPanel
            url={crm.nexleonUrl ?? ""}
            formKey={crm.nexleonFormKey ?? ""}
            defaultUrl={crm.defaultNexleonUrl ?? ""}
            defaultFormKey={crm.defaultNexleonFormKey ?? ""}
            onSave={(u, k) => setNexleon(u, k)}
            canEdit={isAdmin()}
          />
        )}
        {selected === "custom" &&
          (customCrmAllowed ? <CustomCrmPanel /> : <CustomCrmUpgradePanel />)}
        {selected === null && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Sparkles className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Select a provider above to set up lead delivery.
              </p>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Delivery log — admin-only; customers just see the success/error toast on Test */}
      {isAdmin() && (selected === "custom" || selected === "perfex") && <DeliveryLog />}
    </div>
  );
}

/* ------------------------------ Panel shell --------------------------- */

// Card header with a tinted icon badge, matching the provider cards so picker and panel read as one flow.
function PanelHeader({
  icon: Icon,
  title,
  description,
  tone = "primary",
  actions,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  description: ReactNode;
  tone?: "primary" | "success";
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <CardHeader className={cn("flex-row flex-wrap items-start gap-4", className)}>
      <span
        className={cn(
          "grid size-12 shrink-0 place-items-center rounded-2xl",
          tone === "success" ? "bg-success-tint text-success" : "bg-primary-tint text-primary",
        )}
      >
        <Icon className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="mt-1">{description}</CardDescription>
      </div>
      {actions}
    </CardHeader>
  );
}

/* ----------------------------- Nexleon CRM ---------------------------- */

function NexleonPanel({
  url,
  formKey,
  defaultUrl,
  defaultFormKey,
  onSave,
  canEdit,
}: {
  url: string;
  formKey: string;
  defaultUrl: string;
  defaultFormKey: string;
  onSave: (url: string, formKey: string) => void;
  canEdit: boolean;
}) {
  // The user has their own config only when both their own fields are set.
  // Otherwise we fall back to the admin-set company default.
  const hasOwn = url.trim().length > 0 && formKey.trim().length > 0;
  const hasDefault = defaultUrl.trim().length > 0 && defaultFormKey.trim().length > 0;
  const usingDefault = !hasOwn && hasDefault;

  // Pre-fill with the user's own values, falling back to the company default.
  const [urlValue, setUrlValue] = useState(url || defaultUrl);
  const [keyValue, setKeyValue] = useState(formKey || defaultFormKey);
  const [testing, setTesting] = useState(false);
  const saved = hasOwn || hasDefault;

  function handleReset() {
    // Clear the user's own override → leads fall back to the company default.
    setUrlValue(defaultUrl);
    setKeyValue(defaultFormKey);
    onSave("", "");
    toast.success("Reverted to your company's default CRM");
  }

  async function handleTest() {
    if (!urlValue.trim() || !keyValue.trim()) {
      toast.error("Enter both the Nexleon CRM URL and form key");
      return;
    }
    setTesting(true);
    try {
      onSave(urlValue.trim(), keyValue.trim());
      await api.crm.update({ nexleonUrl: urlValue.trim(), nexleonFormKey: keyValue.trim() });
      const r = await api.crm.testWebhook();
      if (r.success) {
        toast.success("Test lead created in Nexleon CRM", {
          description: `Nexleon responded with ${r.status} in ${r.durationMs}ms.`,
        });
      } else {
        toast.error("Nexleon lead delivery failed", {
          description: r.errorMessage || `Status ${r.status}`,
        });
      }
    } catch {
      toast.error("Failed to send test");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="relative overflow-hidden">
      <PanelHeader
        icon={Database}
        title="Nexleon CRM"
        description="Push every qualified lead directly into your Nexleon CRM using the built-in web-to-lead form."
        actions={
          saved ? (
            <StatusPill label={usingDefault ? "Company default" : "Connected"} tone="success" />
          ) : undefined
        }
      />
      <CardContent className="flex flex-col gap-3">
        {usingDefault && (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            Leads are being sent to Nexleon CRM.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="nexleon-url">Nexleon CRM URL</Label>
          <Input
            id="nexleon-url"
            type="url"
            placeholder="https://crm.nexleon.com"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            readOnly={!canEdit}
          />
          {canEdit && (
            <p className="text-xs text-muted-foreground">
              The base URL of your Nexleon CRM installation (without trailing slash).
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nexleon-form-key">Web-to-Lead Form Key</Label>
          <Input
            id="nexleon-form-key"
            type="text"
            placeholder="e.g. a1b2c3d4e5f6..."
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            readOnly={!canEdit}
          />

          {canEdit ? (
            <p className="text-xs text-muted-foreground">
              In Nexleon, go to <strong>Leads &rarr; Web To Lead</strong>, create a form with
              Name + Phone fields, then copy the form key from the form URL.
            </p>
          ) : (

            <p className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
              If you want to receive your call leads, please <strong>Contact Admin</strong>{" "}
              using the option below.
            </p>

          )}

        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!urlValue.trim() || !keyValue.trim()}
              onClick={() => {
                onSave(urlValue.trim(), keyValue.trim());
                toast.success("Nexleon CRM settings saved");
              }}
            >
              <ArrowRight />
              Save Settings
            </Button>
            <Button
              variant="outline"
              disabled={!urlValue.trim() || !keyValue.trim() || testing}
              onClick={handleTest}
            >
              <Webhook />
              {testing ? "Testing..." : "Test"}
            </Button>
            {hasOwn && hasDefault && (
              <Button variant="ghost" onClick={handleReset}>
                Use company default
              </Button>
            )}
          </div>
        ) : (
          <ContactAdmin idPrefix="nexleon" />
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------- Connect to admin ------------------------- */

function ContactAdmin({
  idPrefix,
  subject = "CRM connection request",
}: {
  idPrefix: string;
  subject?: string;
}) {
  const [method, setMethod] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-connect`}>Connect to admin</Label>
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger id={`${idPrefix}-connect`}>
            <SelectValue placeholder="Choose how to connect" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="contact-support">Contact Support</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-0.5 flex items-start gap-2 rounded-xl bg-primary-tint-soft px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0 text-primary" />
          <span>
            Your CRM connection is configured by our team. Pick an option above and
            we'll get you set up.
          </span>
        </p>
      </div>
      {method === "contact-support" && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              window.location.href = `mailto:${env.supportEmail}?subject=${encodeURIComponent(
                subject,
              )}`;
            }}
          >
            <LifeBuoy />
            Contact Support
          </Button>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Custom CRM ---------------------------- */

function CustomCrmPanel() {
  return (
    <Card className="relative overflow-hidden">
      <PanelHeader
        icon={Webhook}
        title="Custom CRM"
        description="Connect to any platform via webhook. Setup is handled by our team."
      />
      {/* Full width — the picker is the point of this panel, so nothing gets
          reserved on the right for decoration. */}
      <CardContent className="flex flex-col gap-3">
        <ContactAdmin idPrefix="custom" subject="Custom CRM connection request" />
      </CardContent>
    </Card>
  );
}

// Custom CRM was selected but the plan no longer includes it (downgrade). Server blocks delivery too — this is just the upsell.
function CustomCrmUpgradePanel() {
  const navigate = useNavigate();
  return (
    <Card className="relative overflow-hidden">
      <PanelHeader
        icon={Crown}
        title="Custom CRM"
        description="Custom CRM integration is a premium feature. Upgrade your plan to deliver leads to any platform via webhook."
      />
      <CardContent>
        <Button variant="primary" onClick={() => navigate("/dashboard/plans")}>
          <Crown className="size-4" />
          Upgrade plan
        </Button>
      </CardContent>
    </Card>
  );
}

/* --------------------------- Delivery Log ---------------------------- */

function DeliveryLog() {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // The endpoint pages server-side, so the chosen size travels with the request.
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [loading, setLoading] = useState(true);

  const load = useCallback((p: number, size: number) => {
    setLoading(true);
    api.crm
      .deliveries(p, size)
      .then((r) => {
        setDeliveries(r.deliveries);
        setTotal(r.total);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(page, pageSize);
  }, [page, pageSize, load]);

  const statusNode = (d: WebhookDelivery) =>
    d.success ? (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" /> OK
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-destructive">
        <XCircle className="size-3.5" /> Failed
      </span>
    );

  const providerLabel = (d: WebhookDelivery) =>
    d.provider?.toLowerCase() === "perfex" ? "Nexleon" : d.provider;

  return (
    <Card>
      <PanelHeader
        icon={ScrollText}
        tone="success"
        title="Delivery Log"
        description={`Recent webhook deliveries — ${total} total`}
      />
      <CardContent>
        {loading && deliveries.length === 0 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 border-b border-border pb-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-3.5 flex-1" />
              ))}
            </div>
            {Array.from({ length: 5 }).map((_, r) => (
              <div key={r} className="flex items-center gap-4">
                {Array.from({ length: 5 }).map((_, c) => (
                  <Skeleton key={c} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </div>
        ) : deliveries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-10 text-center sm:flex-row sm:text-left">
            <EmptyArt icon={ListChecks} />
            <div>
              <p className="text-sm font-semibold">No deliveries yet.</p>
              <p className="text-sm text-muted-foreground">
                Leads will appear here once calls come in.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop — table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Provider</th>
                    <th className="pb-2 pr-4 font-medium">HTTP</th>
                    <th className="pb-2 pr-4 font-medium">Time</th>
                    <th className="pb-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{statusNode(d)}</td>
                      <td className="py-2 pr-4 capitalize">{providerLabel(d)}</td>
                      <td className="py-2 pr-4 font-mono">{d.status || "—"}</td>
                      <td className="py-2 pr-4">{d.durationMs}ms</td>
                      <td className="py-2 text-muted-foreground">
                        {new Date(d.createdAt).toLocaleString("en-GB")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile — cards */}
            <div className="space-y-3 md:hidden">
              {deliveries.map((d) => (
                <DataCard key={d.id}>
                  <DataCardHeader
                    title={<span className="capitalize">{providerLabel(d)}</span>}
                    subtitle={new Date(d.createdAt).toLocaleString("en-GB")}
                    actions={statusNode(d)}
                  />
                  <DataCardGrid>
                    <CardField label="HTTP">
                      <span className="font-mono">{d.status || "—"}</span>
                    </CardField>
                    <CardField label="Time">{d.durationMs}ms</CardField>
                  </DataCardGrid>
                </DataCard>
              ))}
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              noun="deliveries"
              disabled={loading}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
