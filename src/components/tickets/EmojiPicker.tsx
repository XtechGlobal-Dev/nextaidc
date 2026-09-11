import { useState } from "react";
import { Smile } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ------------------------------------------------------------------ *
 *  A small emoji keyboard for the composer.
 *
 *  Deliberately a fixed, hand-picked set rather than a full picker: the
 *  complete Unicode set means a search index and a dependency, and a
 *  support chat needs the twenty faces people actually use. Anything
 *  else can still be typed or pasted straight into the box.
 * ------------------------------------------------------------------ */

const GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: "Smileys",
    emoji: [
      "😀", "😁", "😄", "😊", "🙂", "😉", "😍", "😘",
      "😎", "🤓", "🙃", "😅", "🤔", "😐", "😴", "😇",
      "😌", "😔", "😢", "😭", "😤", "😡", "😱", "🤯",
    ],
  },
  {
    label: "Gestures",
    emoji: ["👍", "👎", "👏", "🙌", "🙏", "👌", "💪", "🤝", "👋", "☝️", "🤞", "✌️"],
  },
  {
    label: "Objects",
    emoji: [
      "❤️", "🔥", "✨", "⭐", "🎉", "🎯", "✅", "❌",
      "⚠️", "❓", "❗", "💡", "📎", "📌", "🔧", "🔒",
      "💰", "🧾", "📞", "📅", "📈", "🛠️", "⏳", "🚀",
    ],
  },
];

export function EmojiPicker({
  onPick,
  disabled,
  className,
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
            open && "bg-muted text-foreground",
            className,
          )}
          aria-label="Insert emoji"
          title="Emoji"
        >
          <Smile className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-72 w-[17.5rem] overflow-y-auto p-2"
        // Put the caret back in the message box when the grid closes, so typing
        // carries straight on after picking one.
        onCloseAutoFocus={(e: Event) => e.preventDefault()}
      >
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-1.5 last:mb-0">
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {group.emoji.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    onPick(e);
                    setOpen(false);
                  }}
                  className="grid size-8 place-items-center rounded-md text-lg leading-none transition-colors hover:bg-muted"
                  aria-label={e}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
