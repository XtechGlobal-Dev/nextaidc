import { useEffect, useState } from "react";
import { Toaster } from "sonner";

/** Toast host: top-center banner below 640px (like native notifications), compact top-right on desktop. */
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
