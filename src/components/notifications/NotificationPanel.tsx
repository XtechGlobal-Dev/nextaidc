import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCheck, X } from "lucide-react";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useT } from "@/lib/i18n";
import {
  NotificationFilterChips,
  NotificationList,
  NotificationListSkeleton,
  useOpenNotification,
} from "./NotificationList";
import { filterNotifications, type NotificationFilter } from "./notificationGroups";

export const NOTIFICATIONS_PATH = "/dashboard/notifications";

/** Notifications slide-over. Mounted once in AppLayout, not per bell: both bells are always in the DOM
 *  (one CSS-hidden), so a portalled panel per bell would open twice. */
export function NotificationPanel() {
  const open = useNotificationStore((s) => s.panelOpen);
  const setOpen = useNotificationStore((s) => s.setPanelOpen);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const hydrated = useNotificationStore((s) => s.hydrated);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const hydrate = useNotificationStore((s) => s.hydrate);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const openNotification = useOpenNotification();
  const navigate = useNavigate();
  const t = useT();

  // Live events already keep the list fresh; re-pull on open anyway so the
  // panel never shows a stale backlog after a dropped stream.
  useEffect(() => {
    if (open) void hydrate();
  }, [open, hydrate]);

  const visible = useMemo(() => filterNotifications(notifications, filter), [notifications, filter]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        hideClose
        // No description element — silence Radix's a11y warning explicitly.
        aria-describedby={undefined}
        className="max-w-100 bg-card sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-5 pb-3 pt-5">
          <SheetTitle className="text-base font-bold">{t("notifications.title")}</SheetTitle>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary transition-colors hover:bg-primary-tint disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <CheckCheck className="size-3.5" />
              {t("notifications.mark_all")}
            </button>
            <SheetClose asChild>
              <button
                type="button"
                aria-label="Close notifications"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </SheetClose>
          </div>
        </div>

        <NotificationFilterChips value={filter} onChange={setFilter} className="px-5 pb-3" />

        {/* Grouped list — the only part that scrolls */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
          {!hydrated && notifications.length === 0 ? (
            <NotificationListSkeleton />
          ) : (
            <NotificationList
              notifications={visible}
              filter={filter}
              emptyTitle={t("notifications.empty")}
              onSelect={(n) => {
                setOpen(false);
                openNotification(n);
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate(NOTIFICATIONS_PATH);
            }}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
          >
            View all notifications
            <ArrowRight className="size-4" />
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
