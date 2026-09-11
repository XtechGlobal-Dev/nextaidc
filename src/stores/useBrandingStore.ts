import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, type Branding, type PublicBrand } from "@/lib/api";
import { applyBrandTheme } from "@/lib/brandTheme";

interface BrandingState {
  assets: Branding;
  /** The white-label tenant this host resolved to, or null on the platform's
   *  own domain. Drives the palette, font, logo and page title. */
  brand: PublicBrand | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const EMPTY: Branding = {
  logoLight: "",
  logoDark: "",
  favicon: "",
  avatarFemale: "",
  avatarMale: "",
};

/** Point a <link rel> at the given href, creating the tag if it's missing. */
function setIconLink(rel: string, url: string) {
  let link = document.querySelector<HTMLLinkElement>(`link[rel~="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = url;
}

/** Swap the document favicon + iOS home-screen icon to the configured asset. */
function applyFavicon(url: string) {
  if (typeof document === "undefined" || !url) return;
  setIconLink("icon", url);
  setIconLink("apple-touch-icon", url);
}

/** Put the brand's name in the tab title, so a tenant's app doesn't announce
 *  the platform. No-op on the platform's own domain. */
function applyBrandTitle(brand: PublicBrand | null) {
  if (typeof document === "undefined" || !brand?.name) return;
  const suffix = brand.tagline ? ` — ${brand.tagline}` : "";
  document.title = `${brand.name}${suffix}`;
}

export const useBrandingStore = create<BrandingState>()(
  persist(
    (set) => ({
      assets: EMPTY,
      brand: null,
      loaded: false,
      refresh: async () => {
        try {
          const cfg = await api.config();
          const assets = cfg.branding ?? EMPTY;
          const brand = cfg.brand ?? null;
          set({ assets, brand, loaded: true });
          // Brand favicon wins over the platform one on a branded host.
          applyFavicon(brand?.faviconUrl || assets.favicon);
          applyBrandTheme(brand);
          applyBrandTitle(brand);
        } catch {
          set({ loaded: true });
        }
      },
    }),
    {
      name: "hello22_branding",
      // Repaint from the cached brand before the network answers — otherwise a
      // tenant's app flashes the platform's blue on every reload.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        applyFavicon(state.brand?.faviconUrl || state.assets.favicon);
        applyBrandTheme(state.brand);
        applyBrandTitle(state.brand);
      },
    },
  ),
);

/** The logo to show for the current context: the brand's when this host is a
 *  brand, else the platform's own. `dark` picks the dark-surface variant. */
export function brandLogoUrl(dark = false): string {
  const { brand, assets } = useBrandingStore.getState();
  if (brand) {
    const own = dark ? brand.logoDarkUrl || brand.logoLightUrl : brand.logoLightUrl;
    if (own) return own;
  }
  return dark ? assets.logoDark || assets.logoLight : assets.logoLight;
}
