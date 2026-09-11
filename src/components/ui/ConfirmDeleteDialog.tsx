import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { confirmPhrase, isConfirmed } from "@/lib/confirmDelete";

export interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What's being deleted, in the phrase — e.g. "role", "web service", "customer". */
  resourceType: string;
  /** The specific resource's name — e.g. "Ops", "AgentLabs-AI-Dev-1". */
  resourceName: string;
  /**
   * Performs the actual deletion. Throw (or reject) to surface an error and keep
   * the dialog open; a clean resolve closes it. Success toasts / list updates
   * belong here, matching the existing per-page delete handlers.
   */
  onConfirm: () => Promise<void> | void;
  /** Overrides the "Delete {resourceType}" title. */
  title?: string;
  /** Extra context shown under the standard irreversibility warning. */
  description?: ReactNode;
  /** Label for the destructive button (default "Delete"). */
  confirmLabel?: string;
}

/**
 * A destructive-delete confirmation that requires typing an exact phrase
 * (`delete <resourceType> <resourceName>`) before the Delete button enables —
 * the same double-confirmation cloud consoles use for irreversible actions.
 * Owns the input, loading and error state; the caller supplies `onConfirm`.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  resourceType,
  resourceName,
  onConfirm,
  title,
  description,
  confirmLabel = "Delete",
}: ConfirmDeleteDialogProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const phrase = confirmPhrase(resourceType, resourceName);
  const confirmed = isConfirmed(input, resourceType, resourceName);

  // Reset the field + error each time the dialog opens (possibly for a different
  // resource), so a previous attempt never leaks into the next one.
  useEffect(() => {
    if (open) {
      setInput("");
      setError(null);
    }
  }, [open, resourceType, resourceName]);

  const close = () => {
    if (!loading) onOpenChange(false);
  };

  async function handleConfirm() {
    if (!confirmed || loading) return; // defence-in-depth; button is also disabled
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Something went wrong. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? `Delete ${resourceType}`}</DialogTitle>
          <DialogDescription>
            This action is{" "}
            <span className="font-medium text-foreground">permanent and cannot be undone</span>. It
            permanently deletes{" "}
            <span className="font-medium text-foreground">{resourceName}</span> and every resource
            associated with it.
          </DialogDescription>
        </DialogHeader>

        {description && <div className="text-sm text-muted-foreground">{description}</div>}

        <div className="flex items-start gap-2 rounded-[var(--radius-card)] border border-danger/30 bg-danger-tint p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Deleting {resourceType} <span className="font-semibold">{resourceName}</span> is
            irreversible. All associated data will be lost.
          </p>
        </div>

        <div className="space-y-2.5">
          <Label htmlFor={inputId} className="box-border inline-block">
            To confirm, type{" "}
            <code className="rounded border border-danger/30 bg-danger-tint px-1.5 py-0.5 font-mono text-xs font-semibold text-danger">
              {phrase}
            </code>
          </Label>
          <Input
            id={inputId}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={phrase}
            disabled={loading}
            aria-invalid={input.length > 0 && !confirmed}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={!confirmed || loading}>
            {loading && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
