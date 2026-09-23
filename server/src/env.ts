import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5174"),
  // Number of reverse-proxy hops in front of the app (Render's load balancer = 1).
  // Express uses this to take the real client IP from the RIGHT of X-Forwarded-For
  // — a specific count (not `true`) so a client can't spoof the header to forge an
  // IP. Wrong-too-low → everyone shares the proxy's IP (per-IP rate limits become
  // global); wrong-too-high → clients can spoof. Override only if infra adds hops.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Public base URL of the customer-facing app (e.g. https://agent.hello22.ai).
  // Used to build login links in account emails (staff/reseller credentials).
  // Falls back to the first CORS origin, then the production URL, so the link is
  // never broken even if this is unset.
  APP_URL: z.string().optional().default(""),
  // At least 32 chars: JWT_SECRET is the single key behind every login,
  // impersonation, unsubscribe and recording token — a short/guessable value is
  // brute-forceable and would let an attacker forge any of them. Boot fails loudly
  // rather than run on a weak secret. Generate one with: openssl rand -base64 48
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Integrations (optional — features return 501 until configured)
  VAPI_API_KEY: z.string().optional().default(""),
  VAPI_PUBLIC_KEY: z.string().optional().default(""),
  // Public base URL Vapi posts call events to (e.g. an ngrok tunnel in dev).
  // When set, the assistant is created with server.url → post-call webhooks fire.
  VAPI_SERVER_URL: z.string().optional().default(""),
  // Public base URL of this API (e.g. https://api.example.com). Used to show the
  // WhatsApp webhook callback URL in admin. Falls back to VAPI_SERVER_URL.
  PUBLIC_API_URL: z.string().optional().default(""),
  // Host used to build the "More info" conversation link in the summary SMS.
  // Set this to a brand/short domain (e.g. https://agent.hello22.ai) that proxies
  // /c/* to this API, so the SMS shows the brand domain instead of the api host.
  // Blank → falls back to PUBLIC_API_URL (the raw API host).
  SHARE_LINK_BASE_URL: z.string().optional().default(""),
  // LiveKit powers in-ticket voice/video calls. Env is only the fallback — the
  // admin sets these under Settings → Integrations (services/settings.ts).
  LIVEKIT_URL: z.string().optional().default(""),
  LIVEKIT_API_KEY: z.string().optional().default(""),
  LIVEKIT_API_SECRET: z.string().optional().default(""),

  /* ----------------------- White-label domains ------------------------ *
   *  The apex(es) whose wildcard DNS points at this deployment. A brand's
   *  slug becomes a label under the FIRST one — acme → acme.hello22.ai —
   *  and only hosts under one of these are read as brand subdomains.
   *
   *  That last part is load-bearing: without it the leading label of ANY
   *  host resolves a tenant, so `acme.attacker.com` would both serve
   *  Acme's branding and pass the brand-aware CORS check.
   * -------------------------------------------------------------------- */
  // Blank (the default) means "derive it" — see configuredPlatformDomains
  // below, which falls back to APP_URL/CORS_ORIGIN's own host rather than a
  // literal domain, so a deployment that never sets this still gets ITS
  // domain, not the one this codebase happened to be written for.
  PLATFORM_DOMAIN: z.string().optional().default(""),
  // Where a brand's vanity domain is CNAMEd. Vercel's shared alias by default.
  BRAND_CNAME_TARGET: z.string().default("cname.vercel-dns.com"),
  // A-record target for brands that insist on an apex (CNAME is illegal there).
  BRAND_APEX_IP: z.string().default("76.76.21.21"),
  // Label the ownership-proof TXT record lives under: _hello22-verify.brand.com
  // Label the ownership-proof TXT lives under, and the prefix on its value.
  // Blank (the default) derives BOTH from PLATFORM_DOMAIN — see
  // domainVerifyName / domainVerifyValuePrefix — so the records handed to a
  // client never carry a platform name that isn't yours.
  DOMAIN_VERIFY_PREFIX: z.string().default(""),

  // Vercel Domains API — lets brand creation attach a vanity domain to the
  // project (and issue its certificate) without anyone opening the dashboard.
  // Blank → domains are still verified by DNS lookup, but the operator has to
  // add the hostname in Vercel by hand.
  VERCEL_API_TOKEN: z.string().optional().default(""),
  VERCEL_PROJECT_ID: z.string().optional().default(""),
  VERCEL_TEAM_ID: z.string().optional().default(""),

  // The ONE public API origin third parties are registered against — Google's
  // OAuth redirect URI, provider webhooks. Never brand-specific: a per-tenant
  // callback would need a per-tenant Google project. Falls back to
  // PUBLIC_API_URL → VAPI_SERVER_URL.
  CANONICAL_API_URL: z.string().optional().default(""),

  DEEPGRAM_API_KEY: z.string().optional().default(""),
  ELEVENLABS_API_KEY: z.string().optional().default(""),

  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().default("hello22.ai <support@hello22.ai>"),
  // Inbox that receives support-chat handoff emails (blank = SMTP_FROM address).
  SUPPORT_INBOX_EMAIL: z.string().optional().default(""),

  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_FROM_NUMBER: z.string().optional().default(""),
  // Regulatory docs for buying numbers in regulated countries (e.g. Australia).
  // Env-only on purpose — never surfaced in the admin Settings UI. AddressSid is
  // required for AU; BundleSid is usually required too. Mobile numbers may need a
  // different bundle than local/geographic ones — set the *_MOBILE override if so.
  TWILIO_ADDRESS_SID: z.string().optional().default(""),
  TWILIO_BUNDLE_SID: z.string().optional().default(""),
  TWILIO_BUNDLE_SID_MOBILE: z.string().optional().default(""),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:4000/api/google/callback"),

  // S3 (object storage for branding assets — logos & favicon)
  AWS_S3_BUCKET: z.string().optional().default(""),
  AWS_S3_REGION: z.string().optional().default(""),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  AWS_S3_ENDPOINT: z.string().optional().default(""),
  AWS_S3_PUBLIC_URL: z.string().optional().default(""),

  // ---- Call log tiering (services/callArchive.ts) --------------------------
  // Age in days at which a call's transcript/analysis JSON moves out of
  // Postgres and into S3. The row stays; only the blobs move, and reads
  // rehydrate transparently. 0 disables archiving entirely.
  //
  // The default keeps three months of calls fully inline: long enough that the
  // window an owner actually browses never pays a round trip, short enough that
  // the table stops growing without bound. Requires the AWS_* keys above —
  // without storage configured the sweep is a no-op and nothing is lost.
  //
  // Do not set this below 8. The weekly digest reads `analysis` across a 7-day
  // window (services/reports.ts) straight from the column, and a shorter window
  // would archive calls out from under it — digests would quietly lose their
  // top-intents breakdown rather than fail visibly.
  CALL_ARCHIVE_AFTER_DAYS: z.coerce.number().int().min(0).default(90),
  // Age in days at which a call log is DELETED outright, blob and all.
  // 0 = never delete, and that is the default deliberately: call rows carry
  // billed minutes and appear in reports, so throwing them away is a policy
  // decision the operator has to make on purpose, not a default they inherit.
  CALL_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

  // ---- Per-tenant databases (services/tenantDb.ts) ------------------------
  // Neon account API key, used ONLY to provision and decommission the dedicated
  // project a data-residency customer's call logs live in. Leave blank and the
  // whole feature is inert: no brand can be isolated, and every call stays in
  // the control-plane database.
  //
  // This key can create and DELETE any project on the Neon account, so it is
  // environment-only — never settable from the admin UI, never returned by an
  // endpoint, never logged.
  NEON_API_KEY: z.string().optional().default(""),
  // Neon region a tenant project is created in when the admin doesn't name one
  // (e.g. "aws-ap-southeast-2"). Blank lets Neon pick, which is wrong for a
  // residency contract — so provisioning asks for a region explicitly.
  NEON_DEFAULT_REGION: z.string().optional().default(""),

  // ---- Job queue (lib/jobQueue.ts, pg-boss) --------------------------------
  // Postgres connection pg-boss's tables live in. Blank (the default) reuses
  // DATABASE_URL — pg-boss's schema is additive and isolated from Prisma's, so
  // most deployments need nothing here. Override only to isolate queue load
  // onto a separate database if it ever needs to scale independently.
  JOB_QUEUE_DB_URL: z.string().optional().default(""),
  JOB_QUEUE_SCHEMA: z.string().default("pgboss"),
  // Per-job cutover flags: each job migrated from scheduler.ts's setInterval
  // onto the queue gets one, so a single instance can flip back to the old
  // in-process path with an env change and a restart — no redeploy — if the
  // queue path misbehaves. Off by default; enable per job as each is proven.
  JOBS_VIA_QUEUE_API_LOG_SWEEP: z.enum(["true", "false"]).default("false"),
  JOBS_VIA_QUEUE_ALERT_RULES: z.enum(["true", "false"]).default("false"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Integration "is it configured?" flags now live in services/settings.ts
// (DB override → env fallback). Use integrationsStatus() from there.

// Trailing slashes are a one-character typo that silently breaks the exact-match
// check below (a browser's `Origin` header never carries one), so strip them
// here rather than making every deploy get `CORS_ORIGIN` byte-perfect.
export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

/** Public base URL of the customer-facing app (no trailing slash), for login
 *  links in emails. Prefers APP_URL, then the first CORS origin, then the
 *  production URL — guaranteed non-empty so emails always carry a working link. */
export const appBaseUrl = (env.APP_URL || corsOrigins[0] || `http://localhost:${env.PORT}`).replace(
  /\/$/,
  "",
);

/** Public base URL of THIS API (no trailing slash), for links that must hit the
 *  backend directly from anywhere — e.g. the email unsubscribe endpoint, which a
 *  recipient (or their mail client's one-click List-Unsubscribe) opens outside
 *  the SPA. Prefers PUBLIC_API_URL, then VAPI_SERVER_URL (both are the public API
 *  host in prod), falling back to the local dev port. */
export const publicApiBaseUrl = (
  env.PUBLIC_API_URL ||
  env.VAPI_SERVER_URL ||
  `http://localhost:${env.PORT}`
).replace(/\/$/, "");

/** Base URL for the public "More info" conversation link in the summary SMS.
 *  Prefers SHARE_LINK_BASE_URL (a brand/short domain that proxies /c/* to this
 *  API) so the SMS masks the raw API host; falls back to the API base. */
export const shareLinkBaseUrl = (env.SHARE_LINK_BASE_URL || publicApiBaseUrl).replace(/\/$/, "");

/**
 * The apex domain(s) whose wildcard DNS points here, lowercased and stripped of
 * any scheme/port someone pasted in. The FIRST one is canonical: it's the apex a
 * new brand's subdomain is built under and the one shown in the admin UI. Extra
 * entries exist so a staging apex (or a domain you're migrating off) still
 * resolves its tenants.
 */
const configuredPlatformDomains: string[] = env.PLATFORM_DOMAIN.split(",")
  .map((d) =>
    d
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[:/].*$/, "")
      .replace(/\.$/, ""),
  )
  .filter(Boolean);

/**
 * When PLATFORM_DOMAIN is never set, there is no safe way to GUESS the apex:
 * deriving it from APP_URL's hostname looked appealing but silently pulled in
 * whatever subdomain APP_URL carries (`agent.hello22.ai` → brand subdomains
 * minted as `acme.agent.hello22.ai`), and there's no telling a subdomain from
 * a bare registrable domain without a public-suffix list. Getting this wrong
 * is a tenant-routing bug, not a cosmetic one, so this falls back to the
 * literal, obviously-a-placeholder "localhost" instead of a clever guess —
 * loud enough to notice locally, and loud enough in a production log (below)
 * that it's the one setting a real deployment still has to make.
 */
const effectivePlatformDomains: string[] = configuredPlatformDomains.length
  ? configuredPlatformDomains
  : ["localhost"];

if (process.env.NODE_ENV === "production" && !configuredPlatformDomains.length) {
  console.error(
    "⚠️  PLATFORM_DOMAIN is not set. Brand subdomains, the domain-ownership TXT record, " +
      "and the admin domain screens are all falling back to \"localhost\", which cannot work " +
      "in production. Set PLATFORM_DOMAIN to this deployment's own apex (e.g. \"example.com\").",
  );
}

/**
 * Outside production the loopback apex counts too, so `acme.localhost:5174`
 * resolves to brand "acme" with nothing to configure.
 *
 * Without it a brand's own front door cannot be opened locally at all: the
 * configured apex is a real domain that never points at a dev machine, so every
 * request from `acme.localhost` fell through to the platform. The visitor was
 * painted as the platform, and anyone signing up there was created as a
 * PLATFORM customer instead of the brand's. Browsers resolve `*.localhost` to
 * loopback themselves, so this needs no hosts file either.
 */
export const platformDomains: string[] =
  process.env.NODE_ENV === "production" || effectivePlatformDomains.includes("localhost")
    ? effectivePlatformDomains
    : [...effectivePlatformDomains, "localhost"];

/** The apex new brand subdomains are minted under (`acme` → acme.<this>).
 *  Always a CONFIGURED (or derived) apex — never the dev loopback appended above. */
export const platformDomain = effectivePlatformDomains[0];

/**
 * `true` on the loopback apex — `platformDomain` is "localhost" itself, or
 * (matching `platformDomains`' own `.endsWith` check nowhere else needed) a
 * "*.localhost" apex someone configured on purpose. Never true in production,
 * matching `platformDomains`' own rule that the loopback only counts outside it.
 */
const platformDomainIsLoopback =
  process.env.NODE_ENV !== "production" &&
  (platformDomain === "localhost" || platformDomain.endsWith(".localhost"));

/**
 * The dev frontend's port, borrowed from the first configured CORS origin —
 * on the loopback apex a bare `acme.localhost` (port 80) has nothing to
 * answer it, so a brand's platform subdomain needs the SPA's real dev port to
 * actually open. Undefined in production, or if that origin carries none.
 */
const devFrontendPort = (() => {
  if (!platformDomainIsLoopback) return undefined;
  try {
    return new URL(corsOrigins[0] ?? "").port || undefined;
  } catch {
    return undefined;
  }
})();

/**
 * The bare hostname a brand's platform subdomain answers on — with the dev
 * frontend's port suffixed on the loopback apex, since a bare
 * `acme.localhost` (port 80) has nothing listening on it there. What the
 * admin UI shows as "Platform subdomain" should be this, not the plain apex,
 * so the text itself is the actually-reachable address, not just the link.
 */
export function platformSubdomainHost(slug: string): string {
  const host = `${slug}.${platformDomain}`;
  return platformDomainIsLoopback && devFrontendPort ? `${host}:${devFrontendPort}` : host;
}

/** The URL that hostname is reachable at: `https://` normally, `http://` on
 *  the loopback apex, where there is no certificate to have one. */
export function platformSubdomainUrl(slug: string): string {
  const scheme = platformDomainIsLoopback && devFrontendPort ? "http" : "https";
  return `${scheme}://${platformSubdomainHost(slug)}`;
}

/**
 * The platform's own short name, taken from its domain: `hello22.ai` →
 * "hello22". Used to name the DNS records a brand's client publishes, so they
 * read as yours rather than as whoever this codebase was first written for.
 */
const platformLabel =
  platformDomain
    .split(".")[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") || "platform";

/**
 * Where the ownership-proof TXT lives, and what its value starts with:
 *
 *   _acme-verify.app.client.com   TXT   acme-verify=<per-brand token>
 *
 * Both derive from PLATFORM_DOMAIN, so pointing the deployment at a different
 * domain renames the records with it and there is nothing else to remember.
 * DOMAIN_VERIFY_PREFIX overrides the name if you ever need to keep an old one
 * working; changing either invalidates proofs already published, so a domain
 * mid-verification has to publish the new record.
 */
export const domainVerifyName = env.DOMAIN_VERIFY_PREFIX.trim() || `_${platformLabel}-verify`;
export const domainVerifyValuePrefix = `${domainVerifyName.replace(/^_/, "")}`;

/**
 * Route a brand's vanity domain before its DNS proof exists — development only.
 *
 * A custom domain can never verify against a dev machine (the TXT record would
 * have to be published in real, public DNS), so testing one locally is
 * otherwise impossible: point the hostname at 127.0.0.1 in your hosts file and
 * set this. Refused in production, where an unproven domain must never be
 * served or admitted by CORS.
 */
export const allowUnverifiedBrandDomains =
  process.env.NODE_ENV !== "production" &&
  process.env.ALLOW_UNVERIFIED_BRAND_DOMAINS === "true";

/**
 * The single public API origin registered with third parties — Google's OAuth
 * redirect URI, provider webhooks. Deliberately NOT per-brand: Google requires
 * an exact pre-registered redirect_uri, so every tenant's OAuth round-trip comes
 * back through this one host and is bounced to the brand from there.
 */
export const canonicalApiBaseUrl = (
  env.CANONICAL_API_URL ||
  env.PUBLIC_API_URL ||
  env.VAPI_SERVER_URL ||
  `http://localhost:${env.PORT}`
).replace(/\/$/, "");
