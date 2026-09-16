import { env } from "@/lib/env";

// Platform name from VITE_APP_NAME. A domain-style name ("hello22.ai") gets its TLD split off for the accent colour.
const [WORDMARK_HEAD, ...wordmarkRest] = env.appName.split(".");
const WORDMARK_TAIL = wordmarkRest.length ? `.${wordmarkRest.join(".")}` : "";

/** Text wordmark, the BrandLogo fallback. Never hardcode the product name; white-label deploys set one env var. */
export function Wordmark() {
  return (
    <>
      {WORDMARK_HEAD}
      {WORDMARK_TAIL && <span className="text-primary">{WORDMARK_TAIL}</span>}
    </>
  );
}
