import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  CornerUpLeft,
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Loader2,
  MessageSquareText,
  Paperclip,
  Pencil,
  Presentation,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import { cn, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmojiPicker } from "@/components/tickets/EmojiPicker";
import { CharacterCount } from "@/components/tickets/ticketUi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AttachmentDescriptor, TicketMessage } from "@/types/ticket";
import {
  FILE_ACCEPT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_VIDEO_BYTES,
  SUPPORTED_FILES_LABEL,
  fileKind,
  formatBytes,
  rejectionReason,
} from "@/lib/ticketFiles";

/* ------------------------------------------------------------------ *
 *  The message box.
 *
 *  Files upload the moment they are added — dropped, pasted or picked —
 *  and sit above the text as removable tiles with their own progress,
 *  so writing and uploading happen at the same time instead of one
 *  after the other. Send only goes live once every attachment has
 *  landed, which is why a slow upload never produces a message whose
 *  files quietly went missing.
 *
 *  Shared by every ticket surface: a requester's reply box, a handler's
 *  reply box (which adds the internal-note switch and saved replies),
 *  and the description field on a "new request" form.
 * ------------------------------------------------------------------ */

type PendingStatus = "uploading" | "done" | "error";

interface PendingFile {
  id: string;
  file: File;
  /** Object URL for an image thumbnail — revoked with the tile. */
  previewUrl?: string;
  progress: number;
  status: PendingStatus;
  error?: string;
  descriptor?: AttachmentDescriptor;
  controller: AbortController;
}

const KIND_ICON = {
  image: FileIcon,
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  media: Film,
  text: FileText,
} as const;

const KIND_TINT: Record<string, string> = {
  image: "text-primary",
  pdf: "text-danger",
  doc: "text-primary",
  sheet: "text-success",
  slides: "text-warning",
  archive: "text-muted-foreground",
  media: "text-premium",
  text: "text-muted-foreground",
};

/** "up to 5 files, 10 MB each (videos 40 MB)" — the attach tooltip and drop overlay. */
const FILE_LIMITS = `up to ${MAX_ATTACHMENTS_PER_MESSAGE} files, ${formatBytes(MAX_ATTACHMENT_BYTES)} each (videos ${formatBytes(MAX_VIDEO_BYTES)})`;

export interface ChatComposerProps {
  /** Send the message. Resolving clears the box; throwing keeps the draft. */
  onSend: (body: string, attachments: AttachmentDescriptor[]) => Promise<void>;
  /**
   * Chat mode: the box empties the instant Send is pressed, before
   * {@link onSend} has come back. Use it where the page shows the message as a
   * pending bubble and handles a failed send there (the outbox does). A form
   * leaves this off so its text survives a failed submit.
   */
  optimistic?: boolean;
  /** Stage one file and return its signed descriptor. */
  upload: (
    file: File,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ) => Promise<AttachmentDescriptor>;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * How tall the box starts, in px. A reply box wants one line (the default);
   * the description on a NEW request is the main input of the form, so it opens
   * at a size that invites a paragraph instead of a sentence.
   */
  minHeight?: number;
  /** Where growing stops and the box starts scrolling instead. */
  maxHeight?: number;
  /**
   * Enter sends (chat) vs Enter starts a new line (a description field, where
   * submitting mid-thought on a stray Enter loses what you were writing).
   */
  submitOnEnter?: boolean;
  /** Give the send button a visible label — worth it when it submits a form. */
  sendLabel?: string;
  /** Field label above the box, so a description reads like the inputs around it. */
  label?: string;
  required?: boolean;
  maxLength?: number;
  /** Handler side only — flips the reply between a real reply and a private note. */
  internal?: { value: boolean; onChange: (next: boolean) => void };
  /** The message being replied to. Shown as a quote above the box. */
  replyTo?: TicketMessage | null;
  onCancelReply?: () => void;
  /**
   * The message being edited: its text fills the box under an "Editing" banner,
   * Enter hands the new text to {@link onSaveEdit}, and Esc cancels. Whatever
   * was being typed before is parked and comes back when the edit ends. Files
   * can't change on an edit, so the tray steps aside while one is open.
   */
  editing?: TicketMessage | null;
  onSaveEdit?: (message: TicketMessage, body: string) => Promise<void>;
  onCancelEdit?: () => void;
  /**
   * Canned answers offered from a "Saved reply" menu. Bodies arrive ready to
   * insert — the page has already filled the blanks — and go in at the caret,
   * so one can be dropped into a half-written reply. Passing the list (even
   * empty) is what shows the menu.
   */
  savedReplies?: { id: string; title: string; body: string }[];
  onManageSavedReplies?: () => void;
  /** Called while someone is actually typing, at most once every few seconds. */
  onTyping?: () => void;
  /** Extra buttons beside Send, e.g. a Cancel when this is a form footer. */
  actions?: ReactNode;
  className?: string;
}

export function ChatComposer({
  onSend,
  optimistic = false,
  upload,
  disabled = false,
  disabledReason,
  placeholder = "Type a message",
  autoFocus = false,
  minHeight,
  maxHeight = 180,
  submitOnEnter = true,
  sendLabel,
  label,
  required = false,
  maxLength = MAX_MESSAGE_CHARS,
  internal,
  replyTo,
  onCancelReply,
  editing = null,
  onSaveEdit,
  onCancelEdit,
  savedReplies,
  onManageSavedReplies,
  onTyping,
  actions,
  className,
}: ChatComposerProps) {
  const textareaId = useId();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingPing = useRef(0);
  // Nested dragenter/dragleave events fire constantly as the pointer crosses
  // child elements; count them so the overlay doesn't flicker.
  const dragDepth = useRef(0);
  // Kept in a ref so unmount cleanup sees the current list without re-running.
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pending;
  /** The draft that was in the box when an edit began — restored when it ends. */
  const stashRef = useRef("");
  const wasEditing = useRef(false);

  // A description field (one with a minHeight) always has its controls under the
  // text. A reply box keeps them alongside.
  const stacked = Boolean(minHeight);

  // Entering edit mode swaps the draft for the message's text (the draft is
  // parked and comes back when the edit ends, saved or cancelled) and puts the
  // caret at the end, so a one-word fix is a couple of keystrokes.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editing) {
      if (!wasEditing.current) {
        setDraft((current) => {
          stashRef.current = current;
          return editing.body;
        });
      } else {
        setDraft(editing.body);
      }
      setNotice(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (wasEditing.current) {
      setDraft(stashRef.current);
      stashRef.current = "";
    }
    wasEditing.current = !!editing;
    // Keyed on the id: the body changing under us (someone else's edit) must not
    // wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Grow the box with its content, between the opening height and the ceiling.
  //
  // `height: auto` first is what makes it SHRINK again: scrollHeight can only
  // report content taller than the current box, so measuring without resetting
  // would let the textarea ratchet up and never come back down after a delete.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const grown = Math.max(el.scrollHeight, minHeight ?? 0);
    el.style.height = `${Math.min(grown, maxHeight)}px`;
    // Past the ceiling the content still has to be reachable, so hand scrolling
    // back to the textarea rather than clipping it.
    el.style.overflowY = grown > maxHeight ? "auto" : "hidden";
  }, [draft, minHeight, maxHeight]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Abort in-flight uploads and release preview URLs when the composer goes.
  useEffect(
    () => () => {
      for (const p of pendingRef.current) {
        if (p.status === "uploading") p.controller.abort();
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
    },
    [],
  );

  const patchPending = useCallback((id: string, next: Partial<PendingFile>) => {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)));
  }, []);

  const startUpload = useCallback(
    async (entry: PendingFile) => {
      try {
        const descriptor = await upload(
          entry.file,
          (percent) => patchPending(entry.id, { progress: percent }),
          entry.controller.signal,
        );
        patchPending(entry.id, { status: "done", progress: 100, descriptor, error: undefined });
      } catch (err) {
        if (entry.controller.signal.aborted) return; // removed on purpose
        patchPending(entry.id, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [patchPending, upload],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setNotice(null);

      const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingRef.current.length;
      if (room <= 0) {
        setNotice(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
        return;
      }

      const accepted: PendingFile[] = [];
      const rejected: string[] = [];
      for (const file of files.slice(0, room)) {
        const reason = rejectionReason(file);
        if (reason) {
          rejected.push(reason);
          continue;
        }
        accepted.push({
          id: uid("att"),
          file,
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          progress: 0,
          status: "uploading",
          controller: new AbortController(),
        });
      }
      if (files.length > room) {
        rejected.push(`Only ${room} more file${room === 1 ? "" : "s"} can be attached here.`);
      }
      if (rejected.length) setNotice(rejected[0]);
      if (accepted.length === 0) return;

      setPending((prev) => [...prev, ...accepted]);
      // Upload immediately — the person carries on typing while it goes.
      for (const entry of accepted) void startUpload(entry);
    },
    [startUpload],
  );

  function removePending(id: string) {
    setPending((prev) => {
      const entry = prev.find((p) => p.id === id);
      if (entry) {
        if (entry.status === "uploading") entry.controller.abort();
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      }
      return prev.filter((p) => p.id !== id);
    });
  }

  function retryPending(id: string) {
    const entry = pendingRef.current.find((p) => p.id === id);
    if (!entry) return;
    // A fresh controller: the old one may already be aborted.
    const retried: PendingFile = {
      ...entry,
      controller: new AbortController(),
      status: "uploading",
      progress: 0,
      error: undefined,
    };
    setPending((prev) => prev.map((p) => (p.id === id ? retried : p)));
    void startUpload(retried);
  }

  /** Drop text in at the caret, not at the end — an emoji, or a whole saved
   *  reply, belongs where you were. */
  function insertText(text: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    // The textarea's own maxLength only guards typing and pasting; anything
    // arriving through here has to respect the same ceiling.
    const room = maxLength - (draft.length - (end - start));
    if (room <= 0) {
      setNotice(`Messages can be up to ${maxLength.toLocaleString("en-US")} characters.`);
      return;
    }
    const inserted = text.length > room ? text.slice(0, room) : text;
    if (inserted !== text) {
      setNotice(`That was trimmed to fit ${maxLength.toLocaleString("en-US")} characters.`);
    }
    setDraft(draft.slice(0, start) + inserted + draft.slice(end));
    if (!el) return;
    // Put the caret after what was just inserted, once React has painted it.
    requestAnimationFrame(() => {
      el.focus();
      const at = start + inserted.length;
      el.setSelectionRange(at, at);
    });
  }

  /** At most one ping every few seconds, however fast someone types. */
  function pingTyping() {
    if (!onTyping) return;
    const now = Date.now();
    if (now - lastTypingPing.current < 3000) return;
    lastTypingPing.current = now;
    onTyping();
  }

  const uploading = pending.some((p) => p.status === "uploading");
  const failed = pending.some((p) => p.status === "error");
  const ready = pending.filter((p) => p.status === "done" && p.descriptor);
  // Only an old message opened for editing can be over: everything typed here
  // stops at the ceiling. It still has to be cut down before it can be saved.
  const overLimit = draft.length > maxLength;
  const canSend =
    !disabled &&
    !sending &&
    !uploading &&
    !overLimit &&
    (draft.trim().length > 0 || ready.length > 0);

  async function submit() {
    if (!canSend) return;
    if (editing) {
      const body = draft.trim();
      if (!body) return;
      setSending(true);
      setNotice(null);
      try {
        // Nothing changed — treat Enter as "done" rather than saving a no-op.
        if (body === editing.body) onCancelEdit?.();
        else await onSaveEdit?.(editing, body);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Couldn't save that edit.");
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    setNotice(null);
    const body = draft.trim();
    const attachments = ready.map((p) => p.descriptor!);
    const clearBox = () => {
      for (const p of pendingRef.current) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
      setDraft("");
      setPending([]);
      textareaRef.current?.focus();
    };
    // Chat: the box is empty before the request has even left. The message is
    // already on screen as a pending bubble, and that bubble — not this box —
    // is where a failure shows up. A form keeps its text until the send succeeds.
    if (optimistic) clearBox();
    try {
      await onSend(body, attachments);
      if (!optimistic) clearBox();
    } catch (err) {
      // Give the words back only if nothing new has been typed since — never
      // overwrite a message someone has started in the meantime.
      if (optimistic) setDraft((current) => current || draft);
      setNotice(err instanceof Error ? err.message : "Couldn't send your message.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      onCancelEdit?.();
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;

    if (submitOnEnter) {
      // Chat: Enter sends, Shift+Enter writes a new line.
      if (!e.shiftKey) {
        e.preventDefault();
        void submit();
      }
      return;
    }
    // Description field: Enter is a new line, and Ctrl/⌘+Enter is the shortcut
    // for people who expect one.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void submit();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    if (editing) {
      setNotice("Finish editing before attaching files.");
      return;
    }
    addFiles(files);
  }

  const attachButton = (
    <button
      type="button"
      onClick={() => fileInputRef.current?.click()}
      className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Attach files"
      title={`Attach files — ${SUPPORTED_FILES_LABEL} · ${FILE_LIMITS}`}
    >
      <Paperclip className="size-[18px]" />
    </button>
  );

  const emojiButton = <EmojiPicker onPick={insertText} disabled={disabled} className="shrink-0" />;

  // Hidden while editing: an edit is a correction, not the place to paste a template.
  const savedReplyButton =
    savedReplies && !editing ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Insert a saved reply"
            title="Insert a saved reply"
          >
            <MessageSquareText className="size-[18px]" />
            <span className="hidden sm:inline">Saved reply</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-80 overflow-y-auto">
          {savedReplies.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No saved replies for this request yet.
            </p>
          ) : (
            savedReplies.map((r) => (
              <DropdownMenuItem
                key={r.id}
                className="flex-col items-start gap-0.5"
                onSelect={() => insertText(r.body)}
              >
                <span className="text-sm font-medium">{r.title}</span>
                <span className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">
                  {r.body}
                </span>
              </DropdownMenuItem>
            ))
          )}
          {onManageSavedReplies && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onManageSavedReplies}>
                Manage saved replies…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const sendButton = (
    <Button
      type="button"
      size={sendLabel || !stacked ? "md" : "icon"}
      onClick={() => void submit()}
      disabled={!canSend}
      className={cn("shrink-0 gap-2", !stacked && "h-12 rounded-xl px-4 sm:px-5")}
      aria-label={editing ? "Save changes" : (sendLabel ?? "Send message")}
      title={
        editing
          ? "Save changes"
          : uploading
            ? "Waiting for attachments to finish"
            : (sendLabel ?? "Send")
      }
    >
      {sending || uploading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : editing ? (
        <Check className="size-4" />
      ) : (
        <Send className="size-4" />
      )}
      {sendLabel ?? (!stacked && <span className="hidden sm:inline">{editing ? "Save" : "Send"}</span>)}
    </Button>
  );

  return (
    <div
      className={cn("relative border-t border-border bg-background", className)}
      onDragEnter={(e) => {
        if (disabled) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (disabled) return;
        if (editing) {
          setNotice("Finish editing before attaching files.");
          return;
        }
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary-tint/90 text-sm font-semibold text-primary">
          <Paperclip className="mr-2 size-4" /> Drop files to attach — {FILE_LIMITS}
        </div>
      )}

      {disabled && disabledReason ? (
        <p className="px-4 py-3 text-center text-sm text-muted-foreground">{disabledReason}</p>
      ) : (
        <div className="p-3">
          {label && (
            <label htmlFor={textareaId} className="mb-1.5 block text-sm font-medium text-foreground">
              {label} {required && <span className="text-danger">*</span>}
            </label>
          )}

          {/* Editing — the message's text is in the box; what was being typed
              before comes back when the edit ends. */}
          {editing && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border-l-[3px] border-l-primary bg-muted/60 px-2.5 py-1.5">
              <Pencil className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-primary">Editing message</p>
                <p className="truncate text-[11px] text-muted-foreground">{editing.body}</p>
              </div>
              <button
                type="button"
                onClick={onCancelEdit}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Cancel edit"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* Replying to — the quote sits above the box, exactly where it will
              sit above the message once it's sent. */}
          {replyTo && !editing && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border-l-[3px] border-l-primary bg-muted/60 px-2.5 py-1.5">
              <CornerUpLeft className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-primary">
                  Replying to {replyTo.authorName}
                  {replyTo.internal && " · internal note"}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {replyTo.body ||
                    (replyTo.attachments.some((a) => a.mime.startsWith("image/"))
                      ? "Photo"
                      : replyTo.attachments.length > 0
                        ? "Attachment"
                        : "Message")}
                </p>
              </div>
              <button
                type="button"
                onClick={onCancelReply}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Cancel reply"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* Attachment tray */}
          {pending.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pending.map((p) => {
                const kind = fileKind(p.file.type, p.file.name);
                const Icon = KIND_ICON[kind];
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "group relative flex w-56 items-center gap-2.5 overflow-hidden rounded-lg border bg-card p-2",
                      p.status === "error" ? "border-danger/50" : "border-border",
                    )}
                  >
                    {p.previewUrl ? (
                      <img src={p.previewUrl} alt="" className="size-9 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="grid size-9 shrink-0 place-items-center rounded bg-muted">
                        <Icon className={cn("size-4", KIND_TINT[kind])} />
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={p.file.name}>
                        {p.file.name}
                      </p>
                      {p.status === "error" ? (
                        <p className="truncate text-[11px] text-danger" title={p.error}>
                          {p.error ?? "Upload failed"}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          {formatBytes(p.file.size)}
                          {p.status === "uploading" && ` · ${p.progress}%`}
                        </p>
                      )}
                      {p.status === "uploading" && (
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-150"
                            style={{ width: `${p.progress}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {p.status === "error" && (
                      <button
                        type="button"
                        onClick={() => retryPending(p.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`Retry uploading ${p.file.name}`}
                      >
                        <RotateCw className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removePending(p.id)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Remove ${p.file.name}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {notice && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-danger">
              <AlertCircle className="size-3.5 shrink-0" /> {notice}
            </p>
          )}

          <div className={cn(!stacked && "flex items-end gap-2")}>
            <div
              className={cn(
                "rounded-xl border border-border bg-card transition-colors focus-within:border-primary/60",
                // A one-line reply reads best with the controls flanking it. A tall
                // description must not be flanked: a full-height button column
                // beside it leaves a dead gutter and squeezes the text into a
                // narrow ribbon, so those controls move underneath instead.
                stacked
                  ? "px-3 py-2.5"
                  : "flex min-h-12 min-w-0 flex-1 items-end gap-1 px-2 py-1.5",
                internal?.value && !editing && "border-warning/60 bg-warning-tint/40",
                editing && "border-primary/60",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={FILE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  // Reset so picking the same file twice still fires a change.
                  e.target.value = "";
                }}
              />

              {!stacked && (
                <span className="flex shrink-0 items-center self-end pb-0.5">
                  {!editing && attachButton}
                  {emojiButton}
                  {savedReplyButton}
                  {/* A hairline between the tools and the words. */}
                  <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                </span>
              )}

              <textarea
                ref={textareaRef}
                id={textareaId}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (e.target.value.trim()) pingTyping();
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                maxLength={maxLength}
                rows={1}
                style={{ minHeight: minHeight ? `${minHeight}px` : undefined }}
                placeholder={
                  editing
                    ? "Edit your message…"
                    : internal?.value
                      ? "Write an internal note (the requester won't see this)"
                      : placeholder
                }
                className={cn(
                  "resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground",
                  stacked ? "block w-full" : "min-w-0 flex-1 py-2.5",
                )}
              />

              {stacked && (
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                  <span className="flex items-center gap-1">
                    {!editing && attachButton}
                    {emojiButton}
                    {savedReplyButton}
                  </span>
                  <span className="flex items-center gap-2">
                    {actions}
                    {sendButton}
                  </span>
                </div>
              )}
            </div>
            {!stacked && sendButton}
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-3 px-1">
            <p className="text-[11px] text-muted-foreground">
              <span className="hidden sm:inline">
                {editing
                  ? "Enter to save · Esc to cancel"
                  : submitOnEnter
                    ? "Enter to send · Shift+Enter for a new line · "
                    : "Enter for a new line · Ctrl+Enter to send · "}
              </span>
              {!editing && "Drop or paste files to attach"}
            </p>
            <span className="flex shrink-0 items-center gap-3">
              <CharacterCount value={draft.length} max={maxLength} />
              {internal && !editing && (
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[11px] font-medium text-muted-foreground">
                  Internal note
                  <Switch checked={internal.value} onCheckedChange={internal.onChange} />
                </label>
              )}
            </span>
          </div>
          {failed && !notice && (
            <p className="mt-1 px-1 text-[11px] text-danger">
              An attachment didn't upload. Retry or remove it to send.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
