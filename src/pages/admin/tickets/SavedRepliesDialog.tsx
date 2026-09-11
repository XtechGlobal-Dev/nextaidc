import { useEffect, useMemo, useState } from "react";
import { MessageSquareText, Pencil, Plus, Search, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SAVED_REPLY_VARIABLES } from "@/components/tickets/savedReplies";
import { CharacterCount } from "@/components/tickets/ticketUi";
import { api, ApiError } from "@/lib/api";
import { MAX_MESSAGE_CHARS } from "@/lib/ticketFiles";
import type { AdminTicketDepartment, TicketSavedReply } from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Saved replies — the canned answers offered in the reply box.
 *
 *  Everyone who can view requests can read the list; adding and
 *  changing follows the lane's `edit` capability. A staff member shapes
 *  the replies of the departments they work; one offered on "All
 *  departments" is the admin's, since it lands in every queue's
 *  composer. Which of those applies is decided server-side and arrives
 *  as `canEdit` per row — the UI just honours it.
 * ------------------------------------------------------------------ */

const ALL_DEPARTMENTS = "__all__";

interface Draft {
  /** Null while creating. */
  id: string | null;
  title: string;
  body: string;
  /** ALL_DEPARTMENTS or a department id. */
  departmentId: string;
}

export function SavedRepliesDialog({
  open,
  onOpenChange,
  departments,
  canEdit,
  isAdmin,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The queues this person works — where their replies can be filed. */
  departments: AdminTicketDepartment[];
  canEdit: boolean;
  isAdmin: boolean;
  /** Something was added, changed or removed — the page reloads its menu. */
  onChanged: () => void;
}) {
  const [replies, setReplies] = useState<TicketSavedReply[] | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<TicketSavedReply | null>(null);

  async function load() {
    try {
      setReplies(await api.admin.tickets.savedReplies.list());
    } catch (e) {
      setReplies([]);
      toast.error(e instanceof ApiError ? e.message : "Couldn't load the saved replies");
    }
  }

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setDraft(null);
    setError(null);
    void load();
  }, [open]);

  const filtered = useMemo(() => {
    if (!replies) return [];
    const q = search.trim().toLowerCase();
    if (!q) return replies;
    return replies.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q) ||
        (r.department?.name.toLowerCase().includes(q) ?? false),
    );
  }, [replies, search]);

  function startNew() {
    setError(null);
    setDraft({
      id: null,
      title: "",
      body: "",
      // An admin's default is the widest; a staff member's is their only queue
      // when they have just one, otherwise they choose.
      departmentId: isAdmin ? ALL_DEPARTMENTS : departments.length === 1 ? departments[0].id : "",
    });
  }

  function startEdit(r: TicketSavedReply) {
    setError(null);
    setDraft({
      id: r.id,
      title: r.title,
      body: r.body,
      departmentId: r.department?.id ?? ALL_DEPARTMENTS,
    });
  }

  async function saveDraft() {
    if (!draft) return;
    if (draft.title.trim().length < 2) {
      setError("Give the reply a short name.");
      return;
    }
    if (!draft.body.trim()) {
      setError("Write the reply itself.");
      return;
    }
    if (!draft.departmentId) {
      setError("Choose which department this reply is for.");
      return;
    }
    setSaving(true);
    setError(null);
    const data = {
      title: draft.title.trim(),
      body: draft.body.trim(),
      departmentId: draft.departmentId === ALL_DEPARTMENTS ? null : draft.departmentId,
    };
    try {
      if (draft.id) await api.admin.tickets.savedReplies.update(draft.id, data);
      else await api.admin.tickets.savedReplies.create(data);
      toast.success(draft.id ? "Saved reply updated" : "Saved reply added");
      setDraft(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save that reply");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    await api.admin.tickets.savedReplies.remove(toDelete.id);
    toast.success("Saved reply removed");
    setToDelete(null);
    await load();
    onChanged();
  }

  /** Append a blank to the body — the editor's way of saying what's available. */
  function insertVariable(token: string) {
    setDraft((d) => {
      if (!d) return d;
      const body = d.body ? `${d.body}${d.body.endsWith(" ") ? "" : " "}${token}` : token;
      // A half-inserted blank is worse than none: leave the body alone if it
      // wouldn't fit.
      return body.length > MAX_MESSAGE_CHARS ? d : { ...d, body };
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
        <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-6 sm:max-h-[90vh] sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary">
                <MessageSquareText className="size-5" />
              </span>
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Saved replies
              </DialogTitle>
            </div>
            <DialogDescription className="mt-2 text-sm leading-relaxed">
              Answers your team sends often. Pick one from the reply box and the blanks — who
              raised it, the request number — are filled in for that request.
            </DialogDescription>
          </DialogHeader>

          {draft ? (
            /* ------------------------------ Editor ---------------------------- */
            <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="saved-reply-title">
                    Name <span className="text-danger">*</span>
                  </Label>
                  <Input
                    id="saved-reply-title"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder="e.g. Looking into it"
                    maxLength={80}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Offered on</Label>
                  <Select
                    value={draft.departmentId}
                    onValueChange={(v) => setDraft({ ...draft, departmentId: v })}
                  >
                    <SelectTrigger aria-label="Department">
                      <SelectValue placeholder="Choose a department" />
                    </SelectTrigger>
                    <SelectContent>
                      {isAdmin && <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>}
                      {departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="saved-reply-body">
                  Reply <span className="text-danger">*</span>
                </Label>
                <textarea
                  id="saved-reply-body"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={7}
                  maxLength={MAX_MESSAGE_CHARS}
                  placeholder={
                    "Hi {{requester_first_name}}, thanks for getting in touch about {{subject}}. We're looking into it and will be back with you shortly.\n\n{{agent_name}}"
                  }
                  className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-muted-foreground">Insert a blank:</span>
                  {SAVED_REPLY_VARIABLES.map((v) => (
                    <button
                      key={v.token}
                      type="button"
                      onClick={() => insertVariable(v.token)}
                      title={v.hint}
                      className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-muted"
                    >
                      {v.token}
                    </button>
                  ))}
                  <CharacterCount
                    value={draft.body.length}
                    max={MAX_MESSAGE_CHARS}
                    className="ml-auto"
                  />
                </div>
              </div>

              {error && <p className="text-xs text-danger">{error}</p>}

              <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
                <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? "Saving…" : draft.id ? "Save changes" : "Add reply"}
                </Button>
              </div>
            </div>
          ) : (
            /* ------------------------------- List ----------------------------- */
            <>
              <div className="mt-4 flex shrink-0 items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search replies…"
                    className="pl-9"
                  />
                </div>
                {canEdit && (
                  <Button onClick={startNew} disabled={!isAdmin && departments.length === 0}>
                    <Plus className="size-4" /> New reply
                  </Button>
                )}
              </div>

              <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {replies === null ? (
                  <>
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-20 rounded-xl" />
                  </>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <MessageSquareText className="size-8 text-muted-foreground/60" />
                    <p className="text-sm font-medium">
                      {replies.length === 0
                        ? "No saved replies yet"
                        : "No replies match that search"}
                    </p>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      {replies.length === 0
                        ? "Add the answers your team types most often, and they'll be one click away in every reply box."
                        : "Try a word from the reply's name or text."}
                    </p>
                    {canEdit && replies.length === 0 && (
                      <Button size="sm" className="mt-2" onClick={startNew}>
                        <Plus className="size-4" /> New reply
                      </Button>
                    )}
                  </div>
                ) : (
                  filtered.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{r.title}</p>
                          <Badge
                            variant={r.department ? "outline" : "primary"}
                            className="text-[10px]"
                          >
                            {r.department?.name ?? "All departments"}
                          </Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">
                          {r.body}
                        </p>
                        {r.createdBy && (
                          <p className="mt-1 text-[11px] text-muted-foreground/80">
                            Added by {r.createdBy.name}
                          </p>
                        )}
                      </div>
                      {r.canEdit && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => startEdit(r)}
                            aria-label={`Edit ${r.title}`}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-danger hover:bg-danger-tint hover:text-danger"
                            onClick={() => setToDelete(r)}
                            aria-label={`Delete ${r.title}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="saved reply"
        resourceName={toDelete?.title ?? ""}
        onConfirm={confirmDelete}
        description="It disappears from every reply box straight away. Replies already sent are untouched."
      />
    </>
  );
}
