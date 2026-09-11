import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Crown, MessageSquareText, Save } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/stores/useAgentStore";
import { api } from "@/lib/api";
import { ENTITLEMENTS_CACHE_KEY, cachedSmsToCallerEntitlement } from "@/lib/planFeatures";
import { CallerInfoSmsCard } from "./CallerInfoSmsCard";

/**
 * SMS to Caller — the details the AI may text a caller who asks for one
 * mid-call (website, email, address…).
 *
 * Its own module rather than a block inside AI Brain → Notifications: that
 * screen is about summaries sent to the OWNER after a call, while this is a
 * capability aimed at the CALLER during one. It sits with the other in-call
 * capabilities (Call Transfer, Booking) in the sidebar.
 *
 * The data has deliberately NOT moved — it still lives in
 * `config.automations.smsOnRequest`, saved through the shared agent store, so
 * this is a UI move with no migration and no new endpoint.
 *
 * Gated by its own plan flag (`smsToCallerEnabled`). The page stays reachable
 * when the plan doesn't include it — same call the plan cards make, where
 * excluded features are shown struck through rather than hidden — but it says
 * so plainly and offers the upgrade instead of just rendering a dead card.
 */
export default function SmsToCallerPage() {
  const navigate = useNavigate();
  const dirty = useAgentStore((s) => s.dirty);
  const save = useAgentStore((s) => s.save);
  const [saving, setSaving] = useState(false);

  // Seed from the cached entitlement so the card doesn't flash locked on
  // revisit, then confirm with the backend.
  const [included, setIncluded] = useState(cachedSmsToCallerEntitlement);
  useEffect(() => {
    let active = true;
    api.notifications
      .channels()
      .then((c) => {
        if (!active) return;
        // `?? c.sms`: the two features shared one flag until recently, so an API
        // that predates the split simply omits the field.
        setIncluded(Boolean(c.smsToCaller ?? c.sms));
        try {
          localStorage.setItem(ENTITLEMENTS_CACHE_KEY, JSON.stringify(c));
        } catch {
          /* ignore unavailable storage */
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    await save();
    setSaving(false);
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-[0_6px_16px_-6px_hsl(217_84%_55%/0.7)]">
              <MessageSquareText className="size-5" />
            </span>
            SMS to Caller
          </span>
        }
        subtitle="Text the person who called the details they ask for during the call."
        actions={
          included ? (
            <Button onClick={onSave} disabled={!dirty || saving} className="gap-2">
              <Save className="size-4" />
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          ) : undefined
        }
      />

      <div className="mt-6 flex flex-col gap-5">
        {!included && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-premium/40 bg-premium-tint px-4 py-3">
            <div className="flex items-center gap-2.5 text-premium">
              <Crown className="size-5 shrink-0" />
              <p className="text-sm font-medium">
                SMS to Caller is a premium feature — upgrade your plan to switch it on.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/dashboard/plans")}>
              <Crown className="size-4" /> Upgrade
            </Button>
          </div>
        )}
        <CallerInfoSmsCard locked={!included} />
      </div>
    </div>
  );
}
