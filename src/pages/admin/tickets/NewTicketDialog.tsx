import { useEffect, useState } from "react";
import { Building2, Check, Flag, Info, Loader2, MessageCircle, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChatComposer } from "@/components/tickets/ChatComposer";
import { PRIORITY_LABEL } from "@/components/tickets/ticketUi";
import { api, type TicketRequesterOption } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AdminTicketDepartment,
  AttachmentDescriptor,
  Ticket,
  TicketLaneInfo,
  TicketPriority,
} from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Raise a request on someone's behalf — one that arrived by phone, or
 *  a conversation that started elsewhere and needs a thread to live in.
 *
 *  Who "someone" is depends on the lane, and the server decides that
 *  from the caller's role: a brand admin picks one of their own
 *  customers, the platform owner picks a brand admin. The picker just
 *  asks /requesters and shows what comes back.
 * ------------------------------------------------------------------ */

const PRIORITY_TINT: Record<TicketPriority, string> = {
  low: "text-muted-foreground",
  normal: "text-primary",
  high: "text-warning",
  urgent: "text-danger",
};

/** Shared look for the tall, icon-prefixed fields on this form. */
const FIELD = "h-12 rounded-xl bg-background pl-11 text-[15px]";
const FIELD_ICON =
  "pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground";

export function NewTicketDialog({
  open,
  onOpenChange,
  lane,
  departments,
  onCreated,
  onManageDepartments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: TicketLaneInfo;
  departments: AdminTicketDepartment[];
  onCreated: (ticket: Ticket) => void;
  /** Where "Go to settings" leads when there is no queue to file into. */
  onManageDepartments?: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TicketRequesterOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<TicketRequesterOption | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectable = departments.filter((d) => d.enabled);
  const noDepartments = selectable.length === 0;
  const forBrandLane = lane.lane === "brand";

  useEffect(() => {
    if (open) return;
    setSubject("");
    setDepartmentId("");
    setPriority("normal");
    setQuery("");
    setResults([]);
    setSelected(null);
    setError(null);
  }, [open]);

  // Debounced requester lookup. Runs on an empty query too, so the picker opens
  // with a usable shortlist rather than a blank box you have to guess at.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setSearching(true);
    const id = window.setTimeout(() => {
      api.admin.tickets
        .requesters(query.trim())
        .then((rows) => {
          if (active) setResults(rows);
        })
        .catch(() => {
          if (active) setResults([]);
        })
        .finally(() => active && setSearching(false));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [query, open]);

  async function create(message: string, attachments: AttachmentDescriptor[]) {
    const fail = (msg: string) => {
      setError(msg);
      throw new Error(msg);
    };
    if (subject.trim().length < 3) fail("Give the request a short subject.");
    if (!departmentId) fail("Choose the department that owns this.");
    if (!selected) {
      fail(forBrandLane ? "Pick the brand admin this is for." : "Pick the customer this is for.");
    }
    setError(null);

    const ticket = await api.admin.tickets.create({
      subject: subject.trim(),
      departmentId,
      priority,
      message,
      attachments,
      requesterId: selected!.id,
    });
    toast.success(`Request ${ticket.reference} created`);
    onCreated(ticket);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column: header and composer keep their height, the form body takes
          whatever is left and scrolls — so the footer is never clipped. */}
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-h-[90vh] sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-6 pt-6 sm:px-8 sm:pt-8">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-tint">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Plus className="size-4" strokeWidth={2.5} />
              </span>
            </div>
            <DialogTitle className="text-2xl font-semibold tracking-tight">New request</DialogTitle>
          </div>
          <DialogDescription className="mt-3 max-w-xl text-[15px] leading-relaxed">
            Log a request that came in another way. The{" "}
            {forBrandLane ? "brand admin" : "customer"} gets an email with a link to the
            conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 pt-6 sm:px-8">
          <div className="space-y-2">
            <Label htmlFor="admin-ticket-subject" className="text-[15px]">
              Subject <span className="text-danger">*</span>
            </Label>
            <div className="relative">
              <MessageCircle className={FIELD_ICON} />
              <Input
                id="admin-ticket-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What is this about?"
                maxLength={140}
                autoFocus
                className={FIELD}
              />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 sm:gap-6">
            <div className="space-y-2">
              <Label className="text-[15px]">
                Department <span className="text-danger">*</span>
              </Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger className={cn(FIELD, "pl-4")} aria-label="Department">
                  <div className="flex min-w-0 items-center gap-3">
                    <Building2 className="size-[18px] shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="Choose a department" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {selectable.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-[15px]">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
                <SelectTrigger className={cn(FIELD, "pl-4")} aria-label="Priority">
                  <div className="flex min-w-0 items-center gap-3">
                    <Flag className={cn("size-[18px] shrink-0", PRIORITY_TINT[priority])} />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-[15px]">
              {forBrandLane ? "Brand admin" : "Customer"} <span className="text-danger">*</span>
            </Label>
            <div className="relative">
              <Search className={FIELD_ICON} />
              <Input
                value={
                  selected
                    ? `${selected.name} · ${selected.email}${selected.brand ? ` · ${selected.brand.name}` : ""}`
                    : query
                }
                onChange={(e) => {
                  setSelected(null);
                  setQuery(e.target.value);
                }}
                placeholder={
                  forBrandLane ? "Search by name, email or brand…" : "Search by name or email…"
                }
                aria-label={forBrandLane ? "Search brand admins" : "Search customers"}
                className={cn(FIELD, selected && "border-primary/40 bg-primary-tint-soft")}
              />
              {searching ? (
                <Loader2 className="absolute right-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : selected ? (
                <Check className="absolute right-4 top-1/2 size-4 -translate-y-1/2 text-primary" />
              ) : null}
            </div>
            {!selected && results.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded-xl border border-border bg-background shadow-sm">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(r);
                        setResults([]);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{r.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {r.email}
                          {r.brand && ` · ${r.brand.name}`}
                        </span>
                      </span>
                      <Check className="size-4 shrink-0 text-muted-foreground/40" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!selected && !searching && results.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {query
                  ? "Nobody matches that."
                  : forBrandLane
                    ? "No brand admins yet."
                    : "No customers yet."}
              </p>
            )}
          </div>

          {noDepartments && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary-tint-soft px-4 py-3 text-[15px]">
              <Info className="size-5 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 text-foreground">
                Create a department first — requests are routed by department.
              </p>
              {onManageDepartments && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 border-primary/40 bg-background px-4 text-sm text-primary hover:bg-primary-tint"
                  onClick={onManageDepartments}
                >
                  Go to settings
                </Button>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        {/* The composer owns the submit path, so Create lives in its toolbar and
            Cancel sits beside it. */}
        <ChatComposer
          onSend={create}
          upload={(file, onProgress, signal) =>
            api.admin.tickets.upload(file, onProgress, signal)
          }
          disabled={noDepartments}
          placeholder="Describe the request — what they reported and anything you've already checked…"
          minHeight={72}
          maxHeight={240}
          submitOnEnter={false}
          sendLabel="Create request"
          label="Description"
          required
          className="shrink-0 bg-muted/30 px-3 sm:px-5"
          actions={
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
