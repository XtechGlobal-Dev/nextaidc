import { useCallback, useState, useSyncExternalStore } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  alertState,
  requestAlertPermission,
  showBrowserAlert,
  subscribeAlertState,
} from "@/lib/browserNotifications";

/** Browser alerts, in the notification panel's footer and on the notifications page.
 *
 *  Its only job is to open the browser's permission prompt — there is no in-app on/off, because the
 *  browser owns that answer. Not yet asked, it offers Allow; allowed, it says so; blocked, it says
 *  where to undo that. Both copies read one shared source, so they can never disagree on screen. */
export function BrowserAlertsRow({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribeAlertState, alertState, () => "unsupported" as const);
  const [asking, setAsking] = useState(false);

  const allow = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    const result = await requestAlertPermission();
    setAsking(false);
    if (result === "granted") {
      // Prove it works, so nobody is left wondering whether the button did anything.
      showBrowserAlert({
        id: "browser-alerts-enabled",
        title: "Browser alerts are on",
        message: "New notifications will appear here, even in a background tab.",
      });
    } else if (result === "denied") {
      toast.error("Notifications are blocked for this site", {
        description: "Allow them in your browser's site settings to get alerts here.",
      });
    }
    // "default" means the prompt was dismissed without an answer — the button simply stays.
  }, [asking]);

  // Nothing to offer on a browser without notifications (iOS Safari, most embedded webviews).
  if (state === "unsupported") return null;

  return (
    <div className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5", className)}>
      <BellRing
        className={cn("size-4 shrink-0", state === "on" ? "text-success" : "text-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground/90">Browser alerts</p>
        {/* Wraps rather than truncates: the slide-over is narrow and half the sentence says nothing. */}
        <p className="text-xs leading-snug text-muted-foreground">
          {state === "on"
            ? "Delivered by your browser, even in a background tab."
            : state === "blocked"
              ? "Your browser is blocking them for this site. Allow them in its site settings."
              : "Get notified by your browser, even in a background tab."}
        </p>
      </div>

      {state === "ask" ? (
        <Button type="button" size="sm" disabled={asking} onClick={() => void allow()}>
          {asking ? "Waiting…" : "Allow"}
        </Button>
      ) : (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            state === "on" ? "bg-success-tint text-success" : "bg-danger-tint text-danger",
          )}
        >
          {state === "on" ? "On" : "Blocked"}
        </span>
      )}
    </div>
  );
}
