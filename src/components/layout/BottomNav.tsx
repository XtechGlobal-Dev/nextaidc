import { NavLink } from "react-router-dom";
import { LayoutDashboard, Inbox, BrainCircuit, Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn, titleCaseName } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { hasCustomerWorkspace } from "@/lib/roles";

interface BottomNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

// The four primary customer tabs; everything else lives in the side drawer opened from the profile item.
const ITEMS: BottomNavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/dashboard/calls", label: "Call Inbox", icon: Inbox },
  { to: "/dashboard/assistant", label: "AI Brain", icon: BrainCircuit },
  { to: "/dashboard/crm", label: "Connect CRM", icon: Plug },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Mobile bottom app bar. STAFF and SUPER_ADMIN have no customer tabs, so they get no bar; their drawer opens from the top header. */
export function BottomNav() {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const mobileSidebarOpen = useUiStore((s) => s.mobileSidebarOpen);
  // A brand that switched CRM off gets no CRM tab down here either.
  const crmOn = useBrandingStore((s) => s.brand?.modules?.crm !== false);

  const showTabs = hasCustomerWorkspace(role);
  // STAFF and the SUPER_ADMIN have no customer tabs, so there's nothing to show
  // down here — their menu lives in the top header. Skip the bar entirely.
  if (!showTabs) return null;
  // Admins/staff open the "Admin" panel; customers open their "Profile" panel.
  const profileLabel = role === "USER" ? "Profile" : "Admin";
  const displayName = user?.fullName || user?.email || "User";

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-warm/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md nav:hidden"
    >
      {showTabs &&
        ITEMS.filter((i) => crmOn || i.to !== "/dashboard/crm").map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "group flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors",
                isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "grid place-items-center rounded-full px-4 py-1 transition-colors",
                    isActive ? "bg-primary-tint" : "bg-transparent group-hover:bg-muted",
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <span className="max-w-full truncate leading-none">{label}</span>
              </>
            )}
          </NavLink>
        ))}

      {/* Profile / menu — opens the side drawer. Last item, far right. */}
      <button
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        aria-label={`Open ${profileLabel} menu`}
        aria-haspopup="dialog"
        aria-expanded={mobileSidebarOpen}
        className={cn(
          "group flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
          !showTabs && "flex-none px-6",
        )}
      >
        <span className="grid size-7 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
          {initials(titleCaseName(displayName))}
        </span>
        <span className="max-w-full truncate leading-none">{profileLabel}</span>
      </button>
    </nav>
  );
}
