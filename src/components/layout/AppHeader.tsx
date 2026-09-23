import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, LogOut, Search, Settings } from "lucide-react";
import { toast } from "sonner";
import { QuickControls } from "@/components/layout/QuickControls";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { NavbarJoinCall } from "@/components/tickets/NavbarJoinCall";
import { TrialDaysIndicator } from "@/components/trial/TrialIndicators";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { ImpersonationEmojiTrigger } from "@/components/admin/ImpersonationEmojiTrigger";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { titleCaseName } from "@/lib/utils";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] || name;
  // No real name set (fullName empty → falls back to the email) — greet with the
  // local part instead of the raw address, so it reads "admin" not "admin@x.com".
  if (first.includes("@")) {
    const local = first.split("@")[0];
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : first;
  }
  return first;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  STAFF: "Staff",
  USER: "Member",
  RESELLER: "Reseller",
};

/** A staff member sees their assigned role's name (e.g. "Support Agent"); every
 *  other account shows its generic role label. */
function roleLabel(user: { role?: string; staffRoleName?: string | null } | null): string {
  if (user?.role === "STAFF" && user.staffRoleName) return user.staffRoleName;
  return ROLE_LABEL[user?.role ?? "USER"];
}

export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  // Shared with the mobile top bar (AppLayout) — this header is hidden below the
  // `nav` breakpoint, so its search button can't be the only way in.
  const paletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const togglePalette = useUiStore((s) => s.toggleCommandPalette);

  const handleSignOut = () => {
    logout();
    toast("Signed out", { description: "You have been logged out." });
    navigate("/login");
  };

  // ⌘K / Ctrl+K toggles the command palette anywhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette]);

  const displayName = user?.fullName || user?.email || "User";

  // Show the platform-correct hint: ⌘K on macOS, Ctrl K elsewhere. Both key
  // combos toggle the palette (see the metaKey || ctrlKey handler above).
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  const shortcutHint = isMac ? "⌘K" : "Ctrl K";

  return (
    <>
      <header className="sticky top-[var(--chrome-top,0px)] z-40 hidden h-16 items-center gap-4 border-b border-border bg-card/80 px-6 backdrop-blur-md nav:flex">
        {/* Left — greeting */}
        <div className="hidden min-w-0 shrink-0 lg:block">
          <p className="truncate text-sm font-semibold leading-tight">
            {greeting()}, {titleCaseName(firstName(displayName))}{" "}
            <ImpersonationEmojiTrigger />
          </p>
          {/* Workspace label helps roles that switch contexts; noise for a customer, so hidden for USER. */}
          {user?.role && user.role !== "USER" && (
            <p className="text-xs text-muted-foreground">{roleLabel(user)} workspace</p>
          )}
        </div>

        {/* Center — command search trigger */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="group mx-auto flex h-10 w-full max-w-md items-center gap-2.5 rounded-xl border border-border bg-warm/60 px-3.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <Search className="size-4 shrink-0 transition-colors group-hover:text-primary" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="hidden items-center gap-0.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex">
            {shortcutHint}
          </kbd>
        </button>

        {/* A call this account was rung for and is not on in this window: Join from any page. */}
        <NavbarJoinCall />

        {/* Right — controls + user chip */}
        <div className="flex shrink-0 items-center gap-2">
          <TrialDaysIndicator />
          <QuickControls />
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hidden h-9 items-center gap-2.5 rounded-full border border-border bg-warm/60 py-1 pl-1 pr-2.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/30 xl:flex"
              >
                <span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {initials(displayName)}
                </span>
                <div className="leading-tight">
                  <p className="max-w-[120px] text-left truncate text-xs font-semibold">{titleCaseName(displayName)}</p>
                  <p className="text-[10px] text-left text-muted-foreground">{roleLabel(user)}</p>
                </div>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-50">
              <DropdownMenuItem onSelect={() => navigate("/dashboard/settings")}>
                <Settings className="text-muted-foreground" />
                Account Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleSignOut}
                className="text-danger focus:bg-danger-tint focus:text-danger"
              >
                <LogOut />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
