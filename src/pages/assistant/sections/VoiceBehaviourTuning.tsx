import { PhoneOff, Volume2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn } from "@/lib/utils";
import { FieldGroup } from "../SectionShell";

function TuneSlider({
  label,
  leftHint,
  rightHint,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  leftHint: string;
  rightHint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant="primary">{display}</Badge>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{leftHint}</span>
        <span>{rightHint}</span>
      </div>
    </div>
  );
}

/**
 * How the assistant sounds and behaves on a call: creativity, voice stability,
 * speed, hang-up permission and background ambience.
 *
 * Lives with **Identity**, right under Voice Selection, because that is where
 * someone is already choosing how the agent sounds — it was previously buried
 * in Advanced next to the master prompt, which is a different job entirely.
 * Reads and writes `config.advanced` regardless, so the stored shape and the
 * compiled prompt are unchanged by where the controls are shown.
 */
export function VoiceBehaviourTuning() {
  const advanced = useAgentStore((s) => s.config.advanced);
  const updateSection = useAgentStore((s) => s.updateSection);
  const setAdv = (patch: Partial<typeof advanced>) => updateSection("advanced", patch);

  return (
    <FieldGroup title="Voice & Behaviour Tuning" description="Fine-tune how the assistant responds.">
      <div className="space-y-6">
        <TuneSlider
          label="Creativity Level"
          leftHint="Strictly Follow Rules"
          rightHint="Conversational"
          value={advanced.creativity}
          min={0}
          max={1}
          step={0.05}
          display={advanced.creativity.toFixed(2)}
          onChange={(v) => setAdv({ creativity: v })}
        />
        <TuneSlider
          label="Voice Stability"
          leftHint="Expressive"
          rightHint="Consistent"
          value={advanced.voiceStability}
          min={0}
          max={1}
          step={0.05}
          display={advanced.voiceStability.toFixed(2)}
          onChange={(v) => setAdv({ voiceStability: v })}
        />
        <TuneSlider
          label="Voice Speed"
          leftHint="Slower"
          rightHint="Faster"
          value={advanced.voiceSpeed}
          min={0.75}
          max={2}
          step={0.05}
          display={`${advanced.voiceSpeed.toFixed(2)}x`}
          onChange={(v) => setAdv({ voiceSpeed: v })}
        />
        <div className="flex items-center justify-between rounded-lg border border-border bg-warm px-3 py-2.5">
          <div className="flex items-center gap-2">
            <PhoneOff className="size-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Allow AI to Hang Up</p>
              <p className="text-xs text-muted-foreground">
                Let the assistant end calls when appropriate.
              </p>
            </div>
          </div>
          <Switch
            checked={advanced.allowHangUp}
            onCheckedChange={(c) => setAdv({ allowHangUp: c })}
          />
        </div>

        {/* Ambient call sound. "Default" lets the platform decide (gentle office
            ambience on a phone call); "Office" forces it; "Off" is silent. */}
        <div className="rounded-lg border border-border bg-warm px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Background Sound</p>
              <p className="text-xs text-muted-foreground">
                Subtle ambience callers hear under the call.
              </p>
            </div>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            {(
              [
                { value: "off", label: "Off" },
                { value: "office", label: "Office" },
                { value: "default", label: "Default" },
              ] as const
            ).map((opt) => {
              const active = (advanced.backgroundSound ?? "default") === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAdv({ backgroundSound: opt.value })}
                  aria-pressed={active}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </FieldGroup>
  );
}
