import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ⌥N on macOS, Alt+N elsewhere — matches the global notifications shortcut.
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const NOTIF_SHORTCUT = isMac ? "⌥N" : "Alt+N";

/** Header bell with unread badge. The panel is mounted once in AppLayout, so this is safe in both headers. */
export function NotificationBell() {
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setPanelOpen(!panelOpen)}
          aria-label="Notifications"
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          className={cn(
            "relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            panelOpen && "bg-muted text-foreground ring-1 ring-border",
          )}
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-4.5 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-1.5">
        Notifications
        <kbd className="rounded border border-background/30 px-1 py-px text-[10px] font-medium">
          {NOTIF_SHORTCUT}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}
