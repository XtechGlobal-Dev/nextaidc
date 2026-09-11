import { Fragment, useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/useChatStore";

/** Assistant replies sometimes slip into markdown — render the common bits
 *  (**bold**, line breaks) instead of showing raw asterisks to the user. */
function renderAssistantText(text: string) {
  return text.split("\n").map((line, li) => (
    <Fragment key={li}>
      {li > 0 && <br />}
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, pi) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={pi}>{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={pi}>{part}</Fragment>
        ),
      )}
    </Fragment>
  ));
}

export function ChatWidget() {
  const open = useChatStore((s) => s.open);
  const toggle = useChatStore((s) => s.toggle);
  const messages = useChatStore((s) => s.messages);
  const send = useChatStore((s) => s.send);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    send(draft);
    setDraft("");
  }

  return (
    <>
      {/* Launcher */}
      <button
        onClick={() => toggle()}
        className={cn(
          "fixed bottom-20 right-5 z-40 hidden size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-panel)] transition-transform hover:scale-105 md:bottom-5",
          open && "scale-0",
        )}
        aria-label="Open support chat"
      >
        <MessageCircle className="size-6" />
      </button>

      {/* Panel */}
      <div
        className={cn(
          "fixed bottom-20 right-5 z-40 flex h-[480px] max-h-[calc(100dvh-7rem)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-panel)] transition-all md:bottom-5 md:max-h-[480px]",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none translate-y-4 opacity-0",
        )}
      >
        <header className="flex items-center justify-between bg-primary px-4 py-3 text-primary-foreground">
          <div className="flex items-center gap-2">
            <Headset className="size-5" />
            <div>
              <p className="text-sm font-semibold leading-tight">Support</p>
              <p className="text-xs opacity-80">Typically replies in a few minutes</p>
            </div>
          </div>
          <button onClick={() => toggle(false)} aria-label="Close chat">
            <X className="size-5" />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-warm p-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                  m.role === "user"
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm border border-border bg-background",
                )}
              >
                {m.role === "user" ? m.content : renderAssistantText(m.content)}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="flex items-center gap-2 border-t border-border p-3">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a message…"
            className="h-9"
          />
          <Button type="submit" size="icon" className="size-9 shrink-0" disabled={!draft.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </>
  );
}
