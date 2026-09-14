import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/useAuthStore";
import { ImpersonationPinDialog } from "./ImpersonationPinDialog";
import { isAdminRole } from "@/lib/roles";

/** The customer whose detail page we're on, or null anywhere else. */
function customerIdFromPath(pathname: string): string | null {
  const m = /^\/dashboard\/admin\/customers\/([^/]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** The header 👋; on an admin's customer detail page it's the hidden door into "Login as Customer".
 *  Hidden on purpose (shoulder-surfing/screen shares), but it's not security: the impersonate endpoint verifies the PIN itself. */
export function ImpersonationEmojiTrigger() {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const impersonating = useAuthStore((s) => !!s.impersonator);
  const [open, setOpen] = useState(false);

  const customerId = customerIdFromPath(location.pathname);
  // Never stack impersonations: a second one would lose the original admin session held in the store.
  const armed = isAdminRole(user?.role) && !impersonating && !!customerId;

  if (!armed) return <span aria-hidden>👋</span>;

  return (
    <>
      <span
        role="button"
        tabIndex={-1}
        // No title/aria-label/hover styling and tabIndex -1: it's meant to stay undiscoverable.
        className="cursor-default select-none"
        onClick={() => setOpen(true)}
      >
        👋
      </span>
      {customerId && (
        <ImpersonationPinDialog open={open} onOpenChange={setOpen} customerId={customerId} />
      )}
    </>
  );
}
