import { useEffect, useState } from "react";
import { Loader2, Save, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";

/**
 * Admin editor for the gender-matched default assistant names. When a customer
 * finishes onboarding, an assistant they haven't named yet is called after its
 * picked voice's gender — a male voice gets the "male" name, a female voice the
 * "female" name. Owners can always rename it later in their AI Brain.
 */
export function AgentDefaultsSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [male, setMale] = useState("");
  const [female, setFemale] = useState("");

  useEffect(() => {
    let active = true;
    api.admin.agentDefaultNames
      .get()
      .then((r) => {
        if (!active) return;
        setMale(r.male);
        setFemale(r.female);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load default names"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (!male.trim() || !female.trim()) {
      toast.error("Both names are required.");
      return;
    }
    setSaving(true);
    try {
      const r = await api.admin.agentDefaultNames.set(male.trim(), female.trim());
      setMale(r.male);
      setFemale(r.female);
      toast.success("Default assistant names saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save names");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5 border-b border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
        <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
          <UserRound className="size-6" />
        </span>
        <div>
          <p className="text-lg font-semibold leading-tight tracking-tight">Default Assistant Names</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Chosen automatically at onboarding to match the customer's voice.
          </p>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          When a new customer finishes onboarding, an unnamed assistant is named after its picked
          voice's gender — a male voice gets the male name, a female voice the female name. Customers
          can rename it any time in their AI Brain.
        </p>

        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-male-name" className="text-xs text-muted-foreground">
                  Male voice → name
                </Label>
                <Input
                  id="agent-male-name"
                  value={male}
                  maxLength={40}
                  placeholder="Mark"
                  onChange={(e) => setMale(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-female-name" className="text-xs text-muted-foreground">
                  Female voice → name
                </Label>
                <Input
                  id="agent-female-name"
                  value={female}
                  maxLength={40}
                  placeholder="Jessica"
                  onChange={(e) => setFemale(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
