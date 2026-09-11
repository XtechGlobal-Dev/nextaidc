// Named .tsx so it runs under the jsdom project (localStorage) — see vitest.config.ts.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The store applies the theme at import time via matchMedia, which jsdom doesn't
// implement. Stub it before the module is evaluated (vi.hoisted runs first).
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

import { useUiStore } from "./useUiStore";

/* The command palette's open state moved into this store so the mobile top bar
 * can open the same dialog the (desktop-only) header opens. This store is
 * persisted, so the one thing worth pinning is that the dialog state is NOT —
 * otherwise a reload would restore a search dialog nobody opened. */

describe("useUiStore — command palette", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ commandPaletteOpen: false });
  });

  it("opens, closes and toggles", () => {
    const { setCommandPaletteOpen, toggleCommandPalette } = useUiStore.getState();

    setCommandPaletteOpen(true);
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);

    toggleCommandPalette();
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    toggleCommandPalette();
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
  });

  it("never persists the open dialog across a reload", () => {
    useUiStore.getState().setCommandPaletteOpen(true);

    const saved = JSON.parse(localStorage.getItem("hello22_ui") ?? "{}");
    expect(saved.state).not.toHaveProperty("commandPaletteOpen");
    // The keys that were persisted before still are.
    expect(saved.state).toHaveProperty("themeMode");
    expect(saved.state).toHaveProperty("sidebarCollapsed");
  });
});
