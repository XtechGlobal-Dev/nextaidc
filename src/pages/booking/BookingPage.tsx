import { useEffect, useState } from "react";
import { CalendarCheck, CalendarRange, LayoutDashboard, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { OverviewTab } from "./OverviewTab";
import { CalendarTab } from "./CalendarTab";
import { SettingsTab } from "./SettingsTab";

/**
 * Booking — the AI books appointments on the call when auto-booking is on and
 * Google Calendar is connected. Three tabs:
 *  • Overview  — connection + auto-book status, today's count, upcoming bookings.
 *  • Calendar  — the main working view (month/week/day) with reschedule + cancel.
 *  • Settings  — Google connect, auto-booking toggle, timezone, bookable hours.
 */
/** Roomier tab pill — the active one lifts off the rail with a soft shadow. */
const TAB_CLASS =
  "rounded-lg px-4 py-2 data-[state=active]:font-semibold data-[state=active]:shadow-[var(--shadow-soft)]";

export default function BookingPage() {
  // Land on the Settings tab when returning from the Google OAuth flow
  // (…/dashboard/booking?google=connected) so the SettingsTab mounts and shows
  // the connect result + refreshes the connection status.
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).has("google") ? "settings" : "overview",
  );
  // The owner's timezone drives every local time render in the Calendar tab.
  const [timezone, setTimezone] = useState("UTC");

  useEffect(() => {
    api.booking
      .overview()
      .then((o) => setTimezone(o.timezone || "UTC"))
      .catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-[0_6px_16px_-6px_hsl(217_84%_55%/0.7)]">
              <CalendarCheck className="size-5" />
            </span>
            Booking
          </span>
        }
        subtitle="Your AI books appointments during the call, straight onto your calendar."
      />

      <Tabs value={tab} onValueChange={setTab} className="mt-2">
        <TabsList className="gap-1 rounded-xl p-1.5">
          <TabsTrigger value="overview" className={TAB_CLASS}>
            <LayoutDashboard className="size-4" /> Overview
          </TabsTrigger>
          <TabsTrigger value="calendar" className={TAB_CLASS}>
            <CalendarRange className="size-4" /> Calendar
          </TabsTrigger>
          <TabsTrigger value="settings" className={TAB_CLASS}>
            <Settings2 className="size-4" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab onGoToSettings={() => setTab("settings")} />
        </TabsContent>
        <TabsContent value="calendar" className="mt-6">
          <CalendarTab timezone={timezone} />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
