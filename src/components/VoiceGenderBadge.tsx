import { cn } from "@/lib/utils";

/** Tiny Male/Female pill shown next to a voice in the pickers (AI Brain + admin
 *  Voice Library). Renders nothing when the provider didn't label the voice. */
export function VoiceGenderBadge({
  gender,
  className,
}: {
  gender?: "male" | "female" | null;
  className?: string;
}) {
  if (gender !== "male" && gender !== "female") return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
        gender === "male" ? "bg-sky-100 text-sky-700" : "bg-pink-100 text-pink-700",
        className,
      )}
    >
      {gender === "male" ? "Male" : "Female"}
    </span>
  );
}
