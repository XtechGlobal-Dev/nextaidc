import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Optional note before a reassign/department move. Goes out with the email + bell and stays on the ticket as a handler-only line.

export function HandoffNoteDialog({
  open,
  onOpenChange,
  title,
  audience,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Assign #12 to Sam", "Move #12 to Billing", "Unassign #12"… */
  title: string;
  /** Who is told — so the writer knows who they are writing to. */
  audience: string;
  confirmLabel: string;
  onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // A fresh box for each change: a note written for Sam must not still be
  // sitting there when the next request goes to Billing.
  useEffect(() => {
    if (open) {
      setNote("");
      setBusy(false);
    }
  }, [open]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm(note.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{audience}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="handoff-note" className="text-sm font-medium">
            Message <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="handoff-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            maxLength={2000}
            autoFocus
            placeholder="What they need to know — what's been tried, what the requester is waiting on…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void confirm();
              }
            }}
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
          <p className="text-xs text-muted-foreground">
            Goes out with the email and notification, and stays on the request as a note only the
            team can see.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
