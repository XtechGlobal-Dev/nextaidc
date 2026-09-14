import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeMode = "light" | "dark" | "system";

interface UiState {
  sidebarCollapsed: boolean;
  assistantTesterOpen: boolean;
  themeMode: ThemeMode;
  mobileSidebarOpen: boolean;
  /** Command palette. Lives here, not in AppHeader, because the mobile top bar in AppLayout
   *  must open the same palette while the desktop header is hidden. */
  commandPaletteOpen: boolean;
  toggleSidebar: () => void;
  setAssistantTester: (open: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
}

export function applyThemeClass(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = mode === "dark" || (mode === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      assistantTesterOpen: false,
      themeMode: "light" as ThemeMode,
      mobileSidebarOpen: false,
      commandPaletteOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setAssistantTester: (open) => set({ assistantTesterOpen: open }),
      setThemeMode: (mode) => {
        set({ themeMode: mode });
        applyThemeClass(mode);
      },
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
    }),
    {
      name: "hello22_ui",
      // Exactly the keys that were already persisted before the palette moved in
      // here — a reload must never restore an open search dialog.
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        assistantTesterOpen: s.assistantTesterOpen,
        themeMode: s.themeMode,
        mobileSidebarOpen: s.mobileSidebarOpen,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyThemeClass(state.themeMode);
      },
    },
  ),
);

// Listen for system theme changes when in "system" mode
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { themeMode } = useUiStore.getState();
    if (themeMode === "system") applyThemeClass("system");
  });
}
