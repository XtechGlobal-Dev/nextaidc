import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/* ------------------------------------------------------------------ *
 *  localStorage under jsdom
 *
 *  Node 26 ships its own `localStorage` global. Without the
 *  `--localstorage-file` flag it is permanently undefined (it only warns
 *  once, at startup). Vitest's jsdom environment copies jsdom's window
 *  onto globalThis but SKIPS any key that already exists there, so Node's
 *  stub wins and jsdom's real Storage never lands — leaving
 *  `localStorage` undefined while `sessionStorage`, which has no such
 *  collision, works fine.
 *
 *  Everything that persists in this app (auth session, UI prefs, brand
 *  theme) goes through localStorage, so without this the store tests
 *  cannot run at all — and, worse, a passing test could be exercising a
 *  code path where persistence silently no-ops.
 *
 *  Installed as a real Storage-shaped object rather than a bare Map so
 *  code under test sees the same API a browser gives it, including the
 *  string coercion that trips people up (`setItem("k", 1)` stores "1").
 * ------------------------------------------------------------------ */
function createStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string) {
      return store.has(String(key)) ? store.get(String(key))! : null;
    },
    setItem(key: string, value: unknown) {
      store.set(String(key), String(value));
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    clear() {
      store = new Map();
    },
  } as Storage;
}

if (typeof globalThis.localStorage === "undefined") {
  const storage = createStorage();
  // configurable so a test that wants to stub or break storage still can.
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined" && window !== (globalThis as unknown as Window)) {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}

// Unmount anything a test rendered so DOM state never leaks between tests.
afterEach(() => cleanup());
