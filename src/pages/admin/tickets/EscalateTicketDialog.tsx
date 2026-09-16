import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import type { Ticket, TicketDepartment } from "@/types/ticket";

// Escalate to the platform: opens a NEW ticket in the brand admin's own name, linked to the customer's.
// The customer thread never leaves this inbox — the platform only sees the admin's account. One per ticket.

export function EscalateTicketDialog({
  open,
  onOpenChange,
  ticket,
  onEscalated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: Ticket;
  /** Both halves of the pair, fresh from the API. */
  onEscalated: (result: { ticket: Ticket; escalation: Ticket }) => void;
}) {
  const [departments, setDepartments] = useState<TicketDepartment[]>([]);
  const [loading, setLoading] = useState(false);
  const [departmentId, setDepartmentId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNote("");
    setDepartmentId("");
    setLoading(true);
    // Requester-side list of platform queues — an escalation is the admin asking the platform.
    api.tickets
      .departments()
      .then((rows) => {
        setDepartments(rows);
        if (rows.length === 1) setDepartmentId(rows[0].id);
      })
      .catch((e) =>
        toast.error(
          e instanceof ApiError ? e.message : "Couldn't load the platform's departments",
        ),
      )
      .finally(() => setLoading(false));
  }, [open]);

  async function confirm() {
    if (!departmentId) {
      toast.error("Choose a platform department");
      return;
    }
    setBusy(true);
    try {
      const result = await api.admin.tickets.escalate(ticket.id, {
        departmentId,
        note: note.trim(),
      });
      toast.success(`Escalated to the platform as ${result.escalation.reference}`);
      onEscalated(result);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't escalate this request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Escalate #{ticket.number} to the platform</DialogTitle>
          <DialogDescription>
            Opens a linked request with the platform in your name. {ticket.requester.name}
            &apos;s thread stays here with your team — the platform sees only what you write
            below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="escalate-department" className="text-sm font-medium">
              Platform department
            </Label>
            <Select value={departmentId} onValueChange={setDepartmentId} disabled={loading}>
              <SelectTrigger id="escalate-department" className="h-11">
                <SelectValue placeholder={loading ? "Loading…" : "Choose a department"} />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="escalate-note" className="text-sm font-medium">
              What the platform needs to know
            </label>
            <textarea
              id="escalate-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={4000}
              autoFocus
              placeholder="What the customer reported, what you've tried, and what you need from the platform…"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void confirm();
                }
              }}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
            <p className="text-xs text-muted-foreground">
              The ticket&apos;s reference and the customer&apos;s name go with it automatically. You
              can follow the platform&apos;s answer under Platform Support.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || loading}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUpRight className="size-4" />
            )}
            Escalate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
