import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCallStore } from "@/stores/useCallStore";

// Wraps a ticket page's thread and composer. While the call window for this ticket has its Chat
// panel open, they are rendered into that panel instead of in place — the same components, the
// same state, just a different spot on screen. The page keeps owning messages, replies and uploads.

export function CallChatSlot({ ticketId, children }: { ticketId: string | null | undefined; children: ReactNode }) {
  const host = useCallStore((s) => s.chatHost);
  const callTicket = useCallStore((s) => s.call?.ticketId ?? null);
  const setChatSlot = useCallStore((s) => s.setChatSlot);

  useEffect(() => {
    if (!ticketId) return;
    setChatSlot(ticketId);
    return () => {
      if (useCallStore.getState().chatSlot === ticketId) setChatSlot(null);
    };
  }, [ticketId, setChatSlot]);

  if (host && ticketId && callTicket === ticketId) return createPortal(children, host);
  return <>{children}</>;
}
