import { useEffect, useState } from "react";
import { Check, Loader2, Power, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, type Brand } from "@/lib/api";
import { cn } from "@/lib/utils";

// Retiring a brand comes in two kinds (docs/brand-as-customer-plan.md): hand it back to its owner as a platform
// customer — the database untouched — or the permanent route (deactivate with a 30-day countdown, or delete now).
// The permanent route still goes through its typed confirmation; this only picks which one.

type Choice = "downgrade" | "permanent";

export function BrandRetireDialog({
  action,
  brand,
  onOpenChange,
  onPermanent,
  onDowngrade,
}: {
  /** Which button opened it; null = closed. */
  action: "deactivate" | "delete" | null;
  brand: Brand;
  onOpenChange: (open: boolean) => void;
  /** Continue to the permanent action's own typed confirmation. */
  onPermanent: () => void;
  /** Throws on failure — the dialog shows it and stays open. */
  onDowngrade: () => Promise<void>;
}) {
  const inSetup = brand.status === "provisioning" || brand.status === "failed";
  const downgradeBlocked = inSetup
    ? "Still being set up — there's no live brand to hand back."
    : !brand.owner
      ? "No admin account to hand it back to."
      : "";
  const [choice, setChoice] = useState<Choice>("downgrade");
  const [busy, setBusy] = useState(false);

  // Each opening starts on the option that keeps everything, when it's possible.
  useEffect(() => {
    if (action) setChoice(downgradeBlocked ? "permanent" : "downgrade");
  }, [action, downgradeBlocked]);

  const others = Math.max((brand.counts?.total ?? 0) - 1, 0);
  const ownerName = brand.owner?.fullName || brand.owner?.email || "the owner";
  const deleting = action === "delete";

  const options: {
    id: Choice;
    icon: typeof UserRound;
    title: string;
    body: string;
    blocked?: string;
    danger?: boolean;
  }[] = [
    {
      id: "downgrade",
      icon: UserRound,
      title: "Downgrade to platform customer",
      body: `The brand closes and ${ownerName} goes back to being a platform customer on the main domain — their assistant, number, calls and plan stay. The database isn't touched: ${
        others ? `the brand's ${others} other account${others === 1 ? " is" : "s are"} closed, not deleted` : "nothing in it is deleted"
      }.`,
      blocked: downgradeBlocked,
    },
    {
      id: "permanent",
      icon: deleting ? Trash2 : Power,
      title: deleting ? "Delete permanently" : "Deactivate permanently",
      body: deleting
        ? "Now and for good: the database and every account in it go with the brand."
        : "Offline now, then deleted with its database and every account after 30 days. You can reactivate it before then.",
      danger: true,
    },
  ];

  async function confirm() {
    if (choice === "permanent") {
      onPermanent();
      return;
    }
    setBusy(true);
    try {
      await onDowngrade();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't downgrade the brand");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={action !== null} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deleting ? "Delete" : "Deactivate"} {brand.name}
          </DialogTitle>
          <DialogDescription>Choose what happens to the brand.</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="What happens to the brand" className="space-y-2.5">
          {options.map(({ id, icon: Icon, title, body, blocked, danger }) => {
            const selected = choice === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!!blocked || busy}
                onClick={() => setChoice(id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:focus-ring",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? danger
                      ? "border-danger bg-danger-tint/40 ring-2 ring-danger/20"
                      : "border-primary bg-primary-tint-soft ring-2 ring-primary/20"
                    : "border-border hover:border-primary/40",
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-lg",
                    danger ? "bg-danger-tint text-danger" : "bg-primary-tint text-primary",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {blocked || body}
                  </span>
                </span>
                {selected && <Check className={cn("size-4 shrink-0", danger ? "text-danger" : "text-primary")} />}
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={choice === "permanent" ? "danger" : "primary"}
            disabled={busy || (choice === "downgrade" && !!downgradeBlocked)}
            onClick={() => void confirm()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {choice === "downgrade" ? "Downgrade to customer" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
