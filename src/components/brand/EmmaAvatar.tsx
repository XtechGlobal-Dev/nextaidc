import { useEffect, useState } from "react";
import { Headset } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The onboarding AI-receptionist persona avatar (gradient ring + icon). The
 * displayed name is dynamic (defaults to "Emma"); swap `img` for a real photo
 * URL later if desired.
 */
export function EmmaAvatar({
  size = 96,
  speaking = false,
  img,
  name = "Emma",
  className,
}: {
  size?: number;
  speaking?: boolean;
  img?: string;
  name?: string;
  className?: string;
}) {
  // Fall back to the gradient + icon if the photo URL fails to load (e.g. the
  // stock host is unreachable), so we never show a broken-image box.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [img]);
  const showImg = img && !broken;
  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      {/* Speaking indicator: expanding "sound wave" rings + a soft glow blink,
          shown only while the receptionist's voice is playing. */}
      {speaking && (
        <>
          <span className="animate-avatar-ripple pointer-events-none absolute inset-0 rounded-full border-2 border-primary/50" />
          <span
            className="animate-avatar-ripple pointer-events-none absolute inset-0 rounded-full border-2 border-primary/40"
            style={{ animationDelay: "0.8s" }}
          />
        </>
      )}
      <div
        className={cn(
          "relative flex items-center justify-center rounded-full ring-4 ring-primary/25",
          speaking && "animate-avatar-glow",
        )}
        style={{
          width: size,
          height: size,
          background: showImg
            ? undefined
            : "linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 55%, white))",
        }}
      >
        {showImg ? (
          <img
            src={img}
            alt={name}
            onError={() => setBroken(true)}
            className="size-full rounded-full object-cover"
          />
        ) : (
          <Headset className="text-white" style={{ width: size * 0.42, height: size * 0.42 }} />
        )}
      </div>
    </div>
  );
}
