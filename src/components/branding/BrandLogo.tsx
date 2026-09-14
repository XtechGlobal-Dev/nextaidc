import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useBrandingStore } from "@/stores/useBrandingStore";

interface BrandLogoProps {
  /** Default mark to render when no custom logo is configured (or one fails to load). */
  children: ReactNode;
  /** Classes applied to the custom logo <img> (e.g. sizing). */
  imgClassName?: string;
}

/** Brand logo with light/dark variants, falling back to `children` when unset or the asset fails to load.
 *  Failure is tracked per variant. A light-only logo is inverted to a silhouette in dark mode. */
export function BrandLogo({ children, imgClassName }: BrandLogoProps) {
  const platformLight = useBrandingStore((s) => s.assets.logoLight);
  const platformDark = useBrandingStore((s) => s.assets.logoDark);
  const brand = useBrandingStore((s) => s.brand);

  // Tenant's own mark wins; the platform logo is only the fallback.
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
