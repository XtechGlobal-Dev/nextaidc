import { Sun, Moon, Monitor } from "lucide-react";
import { useUiStore } from "@/stores/useUiStore";

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_CYCLE = ["light", "dark", "system"] as const;

const iconButton =
  "flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** Theme (single cycle icon). Sits next to the bell. */
export function QuickControls() {
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);

  const ThemeIcon = THEME_ICONS[themeMode];
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themeMode);
    setThemeMode(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={cycleTheme}
        className={iconButton}
        title={`Theme: ${themeMode} mode (click to change)`}
        aria-label={`Theme: ${themeMode} mode. Click to switch.`}
      >
        <ThemeIcon className="size-5" />
      </button>
    </div>
  );
}
