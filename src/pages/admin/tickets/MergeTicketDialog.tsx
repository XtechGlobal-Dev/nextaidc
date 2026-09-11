import { useEffect, useMemo, useState } from "react";
import { GitMerge, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TicketStatusBadge } from "@/components/tickets/ticketUi";
import { api, ApiError } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import type { Ticket } from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Merge another of this requester's threads into the one that's open.
 *
 *  Only the same requester's are offered — merging exists for the
 *  question someone raised twice, and the server refuses anything else,
 *  since folding one person's thread into another's would show each of
 *  them the other's messages. The open request keeps its number and
 *  reference; the other's messages move in and it leaves the inbox.
 * ------------------------------------------------------------------ */

export function MergeTicketDialog({
  open,
  onOpenChange,
  ticket,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The request that stays — the other one is folded into it. */
  ticket: Ticket;
  onMerged: (merged: Ticket) => void;
}) {
  const [search, setSearch] = useState("");
  /** Null while loading; the requester's other threads once it lands. */
  const [candidates, setCandidates] = useState<Ticket[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSourceId(null);
    setCandidates(null);
    let cancelled = false;
    // The inbox search matches the requester's name and email, which is the
    // closest thing to "this person's requests" the list API offers; the id
    // check below drops anyone who merely shares a name.
    api.admin.tickets
      .list({ status: "all", q: ticket.requester.email || ticket.requester.name, pageSize: 50 })
      .then((page) => {
        if (cancelled) return;
        setCandidates(
          page.tickets.filter(
            (t) => t.id !== ticket.id && t.requester.id === ticket.requester.id,
          ),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setCandidates([]);
        toast.error(e instanceof ApiError ? e.message : "Couldn't load their other requests");
      });
    return () => {
      cancelled = true;
    };
  }, [open, ticket]);

  const filtered = useMemo(() => {
    if (!candidates) return [];
    const q = search.trim().toLowerCase().replace(/^#/, "");
    if (!q) return candidates;
    return candidates.filter(
      (t) =>
        String(t.number) === q ||
        t.subject.toLowerCase().includes(q) ||
        t.reference.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const source = candidates?.find((t) => t.id === sourceId) ?? null;

  async function confirm() {
    if (!source) return;
    setMerging(true);
    try {
      const merged = await api.admin.tickets.merge(ticket.id, source.id);
      toast.success(`Merged #${source.number} into #${ticket.number}`);
      onMerged(merged);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't merge those requests");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !merging && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5 text-primary" /> Merge into #{ticket.number}
          </DialogTitle>
          <DialogDescription className="mt-2 leading-relaxed">
            Pick another request from {ticket.requester.name}. Its messages and files move into{" "}
            <span className="font-medium text-foreground">
              #{ticket.number} “{ticket.subject}”
            </span>
            , and the one you pick is removed. This can't be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 px-6 pt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by number, subject or reference…"
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {candidates === null ? (
            <div className="space-y-2">
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {candidates.length === 0
                ? `${ticket.requester.name} has no other requests to merge.`
                : "No requests match that search."}
            </p>
          ) : (
            <ul role="radiogroup" aria-label="Request to merge in" className="space-y-1.5">
              {filtered.map((t) => {
                const selected = t.id === sourceId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSourceId(t.id)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                        selected
                          ? "border-primary bg-primary-tint"
                          : "border-border hover:bg-muted/60",
                      )}
                    >
                      <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                        #{t.number}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.subject}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {t.lastMessage || "No messages"}
                        </span>
                        <span className="mt-1.5 flex items-center gap-2">
                          <TicketStatusBadge status={t.status} staff />
                          <span className="text-[11px] text-muted-foreground">
                            {timeAgo(t.lastMessageAt)}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merging}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={!source || merging}>
            <GitMerge className="size-4" />
            {merging
              ? "Merging…"
              : source
                ? `Merge #${source.number} into #${ticket.number}`
                : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
