import { useEffect, useRef, useState } from "react";
import { Loader2, Briefcase, Check, X, Trash2, Clock } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, ApiError, type IndustryAdminView } from "@/lib/api";
import { formatDateDMY } from "@/lib/utils";
import { useLiveTick } from "@/hooks/useLiveData";

/**
 * Admin review for customer-proposed industries. New suggestions land in the
 * pending queue (usable on the submitter's own profile immediately, but not yet
 * shared); approving one adds it to the public list every customer sees, rejecting
 * drops it. Previously-approved customs can also be pruned. Built-ins aren't listed
 * here — they can't be removed.
 */
export function IndustrySuggestionsSettings() {
  const [data, setData] = useState<IndustryAdminView | null>(null);
  const [loading, setLoading] = useState(true);
  // Which value is mid-action, so only its buttons spin.
  const [busy, setBusy] = useState<string | null>(null);
  // Bumps when the server pushes an admin event (e.g. a new suggestion lands), so
  // the queue refreshes live — no page reload. First load shows a spinner + surfaces
  // errors; live-tick refreshes update silently in place.
  const liveTick = useLiveTick();
  const firstLoad = useRef(true);

  useEffect(() => {
    let active = true;
    api.admin.industries
      .list()
      .then((r) => active && setData(r))
      .catch((e) => {
        if (active && firstLoad.current)
          toast.error(e instanceof ApiError ? e.message : "Failed to load industries");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          firstLoad.current = false;
        }
      });
    return () => {
      active = false;
    };
  }, [liveTick]);

  async function run(
    label: string,
    action: () => Promise<IndustryAdminView>,
    okMsg: string,
  ) {
    setBusy(label);
    try {
      setData(await action());
      toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const pending = data?.pending ?? [];
  const approved = data?.approved ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5 border-b border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
        <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
          <Briefcase className="size-6" />
        </span>
        <div>
          <p className="text-lg font-semibold leading-tight tracking-tight">Industry Suggestions</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Custom industries customers proposed — approve to add them to everyone's list.
          </p>
        </div>
      </div>

      <div className="space-y-6 p-4 sm:p-6">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* Pending queue */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="size-4 text-warning" />
                Pending review
                {pending.length > 0 && (
                  <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-medium text-warning">
                    {pending.length}
                  </span>
                )}
              </div>
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>
              ) : (
                <ul className="divide-y divide-border rounded-[var(--radius-card)] border border-border">
                  {pending.map((p) => (
                    <li
                      key={p.value}
                      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{p.value}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          by {p.byEmail} · {formatDateDMY(p.at)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            run(
                              `approve:${p.value}`,
                              () => api.admin.industries.approve(p.value),
                              `"${p.value}" approved`,
                            )
                          }
                          disabled={busy !== null}
                        >
                          {busy === `approve:${p.value}` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Check className="size-4" />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-danger hover:bg-danger-tint hover:text-danger"
                          onClick={() =>
                            run(
                              `reject:${p.value}`,
                              () => api.admin.industries.reject(p.value),
                              `"${p.value}" rejected`,
                            )
                          }
                          disabled={busy !== null}
                        >
                          {busy === `reject:${p.value}` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <X className="size-4" />
                          )}
                          Reject
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Approved customs */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Check className="size-4 text-success" />
                Approved custom industries
                {approved.length > 0 && (
                  <span className="rounded-full bg-success-tint px-2 py-0.5 text-xs font-medium text-success">
                    {approved.length}
                  </span>
                )}
              </div>
              {approved.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No custom industries approved yet. Built-in industries aren't shown here.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {approved.map((v) => (
                    <span
                      key={v}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-3 pr-1.5 text-sm"
                    >
                      {v}
                      <button
                        type="button"
                        aria-label={`Remove ${v}`}
                        onClick={() =>
                          run(
                            `remove:${v}`,
                            () => api.admin.industries.remove(v),
                            `"${v}" removed`,
                          )
                        }
                        disabled={busy !== null}
                        className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-danger-tint hover:text-danger disabled:opacity-50"
                      >
                        {busy === `remove:${v}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
