import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { LockKeyhole, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/useAuthStore";
import { staffLandingPath, STAFF_NO_ACCESS_PATH } from "@/lib/onboardingRoute";

function firstName(name?: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first && !first.includes("@") ? first : "there";
}

/**
 * Shown to a STAFF member whose role grants no sections — or who has no role
 * assigned yet. Their sidebar is empty, so this explains *why* rather than
 * dropping them on a blank page. Thanks to the live permission sync (loadMe on a
 * short interval + on tab focus), the instant an admin assigns them a role this
 * screen redirects them straight to their first section — no manual refresh.
 */
export default function StaffNoAccessPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  // Pull a fresh session on mount so a role granted moments ago is picked up
  // immediately (the background sync would otherwise take up to its interval).
  useEffect(() => {
    void useAuthStore.getState().loadMe();
  }, []);

  // Anyone who *does* have somewhere to go leaves this screen: admins/customers
  // to their dashboard, and any staff member the moment they gain a section.
  useEffect(() => {
    if (!user) return;
    if (user.role !== "STAFF") {
      navigate("/dashboard", { replace: true });
      return;
    }
    const dest = staffLandingPath(user.permissions ?? []);
    if (dest !== STAFF_NO_ACCESS_PATH) navigate(dest, { replace: true });
  }, [user, navigate]);

  const handleSignOut = () => {
    logout();
    toast("Signed out", { description: "You have been logged out." });
    navigate("/login");
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-primary-tint text-primary">
          <LockKeyhole className="size-8" />
        </div>

        <h1 className="mt-6 text-xl font-semibold tracking-tight">
          Hi {firstName(user?.fullName)}, no access yet
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          Your account is all set up, but it hasn&apos;t been given any permissions yet. Once an
          administrator assigns you a role, the sections you can manage will appear here
          automatically — you won&apos;t need to refresh.
        </p>

        {/* Live affordance — the screen is actively waiting for access to be granted. */}
        <div className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-warm/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          Waiting for access…
        </div>

        <div className="mt-8 flex items-center justify-center">
          <Button variant="outline" onClick={handleSignOut}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>

        {user?.email && (
          <p className="mt-6 text-xs text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{user.email}</span>
          </p>
        )}
      </div>
    </div>
  );
}
