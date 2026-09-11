import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useBrandingStore } from "@/stores/useBrandingStore";

interface BrandLogoProps {
  /** Default mark to render when no custom logo is configured (or one fails to load). */
  children: ReactNode;
  /** Classes applied to the custom logo <img> (e.g. sizing). */
  imgClassName?: string;
}

/**
 * Renders the admin-configured brand logo (light/dark variants toggled by the
 * `.dark` class) — or the supplied default mark when none is set, or when the
 * configured asset fails to load (e.g. a stale URL after a re-upload) so we never
 * show a broken-image icon.
 *
 * Failure is tracked PER variant and reset whenever the source changes, so a
 * broken light logo can't hide a valid dark one, and replacing a logo recovers
 * without a full page reload.
 *
 * If only a light-mode logo is uploaded, the dark-mode render falls back to it
 * but is forced to a light silhouette (`brightness-0 invert`) so it stays
 * visible on dark backgrounds. Upload a dedicated dark-mode logo for full colour.
 */
export function BrandLogo({ children, imgClassName }: BrandLogoProps) {
  const platformLight = useBrandingStore((s) => s.assets.logoLight);
  const platformDark = useBrandingStore((s) => s.assets.logoDark);
  const brand = useBrandingStore((s) => s.brand);

  // On a white-label host the tenant's own mark wins outright; the platform's
  // logo is only the fallback for the platform's own domain (or a brand that
  // hasn't uploaded one yet).
  const logoLight = brand?.logoLightUrl || platformLight;
  const logoDark = brand?.logoDarkUrl || (brand?.logoLightUrl ? "" : platformDark);

  const lightSrc = logoLight || logoDark;
  const darkSrc = logoDark || logoLight;

  const [lightFailed, setLightFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);

  // Reset failure when the source changes (e.g. after an admin re-upload).
  useEffect(() => setLightFailed(false), [lightSrc]);
  useEffect(() => setDarkFailed(false), [darkSrc]);

  // No custom assets at all → just the default mark.
  if (!lightSrc && !darkSrc) return <>{children}</>;

  const showLight = lightSrc && !lightFailed;
  const showDark = darkSrc && !darkFailed;

  return (
    <>
      {/* Light mode */}
      {showLight ? (
        <img
          src={lightSrc}
          alt="Logo"
          onError={() => setLightFailed(true)}
          className={cn("dark:hidden", imgClassName)}
        />
      ) : (
        <span className="contents dark:hidden">{children}</span>
      )}

      {/* Dark mode */}
      {showDark ? (
        <img
          src={darkSrc}
          alt="Logo"
          onError={() => setDarkFailed(true)}
          className={cn("hidden dark:block", !logoDark && "brightness-0 invert", imgClassName)}
        />
      ) : (
        <span className="hidden dark:contents">{children}</span>
      )}
    </>
  );
}
