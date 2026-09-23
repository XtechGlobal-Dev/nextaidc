import { useCallback, useState, useSyncExternalStore } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  alertState,
  requestAlertPermission,
  setAlertsPreferred,
  showBrowserAlert,
  subscribeAlertState,
} from "@/lib/browserNotifications";

/** Browser alerts, in the notification panel's footer and on the notifications page.
 *
 *  One switch. Off → on opens the browser's permission prompt the first time, and simply turns
 *  delivery back on after that (the permission stays granted, so no second prompt). On → off stops
 *  delivery here without touching the browser — the only thing the viewer can undo themselves.
 *  Blocked in the browser, the switch is out of our hands and the row says where to fix it. Both
 *  copies read one shared source, so they can never disagree on screen. */
export function BrowserAlertsRow({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribeAlertState, alertState, () => "unsupported" as const);
  const [asking, setAsking] = useState(false);

  const turnOn = useCallback(async () => {
    if (asking) return;
    // Already granted: nothing to ask, just flip the switch and prove it works.
    if (state === "off") {
      setAlertsPreferred(true);
      showBrowserAlert({
        id: "browser-alerts-enabled",
        title: "Browser alerts are on",
        message: "New notifications will appear here, even in a background tab.",
      });
      return;
    }
    setAsking(true);
    const result = await requestAlertPermission();
    setAsking(false);
    if (result === "granted") {
      setAlertsPreferred(true);
      // Prove it works, so nobody is left wondering whether the switch did anything.
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
    // "default" means the prompt was dismissed without an answer — the switch simply stays off.
  }, [asking, state]);

  const turnOff = useCallback(() => {
    setAlertsPreferred(false);
    toast("Browser alerts are off", {
      description: "New notifications will still show in the app.",
    });
  }, []);

  // Nothing to offer on a browser without notifications (iOS Safari, most embedded webviews).
  if (state === "unsupported") return null;

  const on = state === "on";
  const blocked = state === "blocked";

  return (
    <div className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5", className)}>
      <BellRing className={cn("size-4 shrink-0", on ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground/90">Browser alerts</p>
        {/* Wraps rather than truncates: the slide-over is narrow and half the sentence says nothing. */}
        <p className="text-xs leading-snug text-muted-foreground">
          {on
            ? "Delivered by your browser, even in a background tab."
            : blocked
              ? "Your browser is blocking them for this site. Allow them in its site settings."
              : asking
                ? "Waiting for your browser's answer…"
                : "Get notified by your browser, even in a background tab."}
        </p>
      </div>

      {blocked ? (
        <span className="shrink-0 rounded-full bg-danger-tint px-2 py-0.5 text-[11px] font-semibold text-danger">
          Blocked
        </span>
      ) : (
        <Switch
          aria-label="Browser alerts"
          checked={on}
          disabled={asking}
          onCheckedChange={(next) => {
            if (next) void turnOn();
            else turnOff();
          }}
        />
      )}
    </div>
  );
}
