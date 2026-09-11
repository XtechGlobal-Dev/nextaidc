import { useEffect, useState } from "react";
import { Toaster } from "sonner";

/**
 * Responsive toast host.
 *
 * On phones/tablets (< 640px) toasts drop in as a centered, full-width banner
 * from the top — the way native OS notifications appear — with generous edge
 * insets and rounded, elevated cards. On desktop they return to the compact
 * top-right corner. `richColors` gives every type (success / info / warning /
 * error·failed / loading·pending) its own native-looking colour treatment.
 */
export function AppToaster() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <Toaster
      position={isMobile ? "top-center" : "top-right"}
      richColors
      closeButton
      expand={isMobile}
      gap={isMobile ? 10 : 14}
      offset={isMobile ? 12 : 20}
      toastOptions={{
        classNames: {
          toast:
            "rounded-2xl border border-border/60 shadow-[var(--shadow-panel)] backdrop-blur-md",
          title: "font-semibold",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}
