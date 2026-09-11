import { env } from "@/lib/env";

// The PLATFORM's own name (a white-label reseller renames the whole product
// via VITE_APP_NAME, not just one brand's logo — see BrandLogo, which this is
// always the `children` fallback for). When the name reads as a domain
// ("hello22.ai") the TLD is split off so it keeps its accent color; a plain
// product name renders as-is with no colored suffix.
const [WORDMARK_HEAD, ...wordmarkRest] = env.appName.split(".");
const WORDMARK_TAIL = wordmarkRest.length ? `.${wordmarkRest.join(".")}` : "";

/** The platform's text wordmark — the default mark `<BrandLogo>` shows when no
 *  custom logo image is configured. Never hardcode the product name inline;
 *  render this instead so a white-label deploy only has to set one env var. */
export function Wordmark() {
  return (
    <>
      {WORDMARK_HEAD}
      {WORDMARK_TAIL && <span className="text-primary">{WORDMARK_TAIL}</span>}
    </>
  );
}
