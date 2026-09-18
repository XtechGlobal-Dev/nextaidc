import { useEffect, useMemo, useState } from "react";
import { CheckCheck, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { BrowserAlertsRow } from "@/components/notifications/BrowserAlertsRow";
import { Button } from "@/components/ui/button";
import {
  NotificationFilterChips,
  NotificationList,
  NotificationListSkeleton,
  useOpenNotification,
} from "@/components/notifications/NotificationList";
import {
  filterNotifications,
  type NotificationFilter,
} from "@/components/notifications/notificationGroups";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useT } from "@/lib/i18n";

/** "View all notifications" — the full-page view behind the header bell.
 *  Same grouping and filters as the slide-over, plus the destructive Clear. */
export default function NotificationsPage() {
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const hydrated = useNotificationStore((s) => s.hydrated);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const hydrate = useNotificationStore((s) => s.hydrate);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const openNotification = useOpenNotification();
  const t = useT();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const visible = useMemo(() => filterNotifications(notifications, filter), [notifications, filter]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t("notifications.title")}
        subtitle="Everything that's happened on your account, newest first."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
              <CheckCheck />
              {t("notifications.mark_all")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
              disabled={notifications.length === 0}
              className="text-danger hover:bg-danger-tint hover:text-danger"
            >
              <Trash2 />
              Clear all
            </Button>
          </>
        }
      />

      {/* Same switch as the panel's footer — whichever screen a viewer is on when they want alerts. */}
      <BrowserAlertsRow className="mb-4 border border-border bg-card" />

      <NotificationFilterChips value={filter} onChange={setFilter} className="mb-4" />

      <div className="rounded-[var(--radius-card)] border border-border bg-card p-3 shadow-[var(--shadow-soft)] sm:p-4">
        {!hydrated && notifications.length === 0 ? (
          <NotificationListSkeleton rows={6} />
        ) : (
          <NotificationList
            notifications={visible}
            filter={filter}
            emptyTitle={t("notifications.empty")}
            onSelect={openNotification}
          />
        )}
      </div>
    </div>
  );
}
