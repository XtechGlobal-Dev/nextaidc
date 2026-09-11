import express from "express";
import cors from "cors";
import morgan from "morgan";
import { env, corsOrigins } from "./env.js";
import { apiRouter } from "./routes/index.js";
import publicCallRouter from "./routes/publicCall.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { loadSettings, integrationsStatus } from "./services/settings.js";
import { seedEmailTemplates } from "./services/emailTemplates.js";
import { seedAllTicketDepartments } from "./services/tickets.js";
import { startScheduler } from "./services/scheduler.js";
import { getElevenLabsCatalog } from "./services/voices.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { brandContext } from "./middleware/brand.js";
import { loadBrands, resolveBrandForHost } from "./services/brands.js";
import { markStaleTenants } from "./services/tenantProvisioning.js";
const app = express();

// Don't advertise the framework, and set the baseline security headers on every
// response (before routing, so 404s/errors carry them too).
app.disable("x-powered-by");
app.use(securityHeaders);

// Behind Render's load balancer the socket IP is the proxy, identical for every
// visitor — so without this, req.ip collapses all users into one value and the
// per-IP rate limiter locks EVERYONE out after one attacker's burst. Trust a
// fixed number of hops (not `true`, which would let a client spoof
// X-Forwarded-For) so req.ip is the real client address.
app.set("trust proxy", env.TRUST_PROXY_HOPS);

// CORS. Beyond the configured origins, ANY host that resolves to an active
// brand is allowed: brands are created at runtime, so a white-label subdomain
// would otherwise be blocked from its own API until someone redeployed with an
// updated CORS_ORIGIN. Resolution goes through the brand cache — an unknown or
// suspended host is still refused.
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: same-origin navigations, curl, server-to-server
      // webhooks. Never a cross-site risk, and blocking them breaks the webhooks.
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        return callback(null, false);
      }
      callback(null, Boolean(resolveBrandForHost(hostname)));
    },
    credentials: true,
  }),
);
app.use(morgan("dev"));

// Resolve the white-label tenant from the Host before anything else routes, so
// even an anonymous visitor on a brand subdomain gets that brand's look, and
// every send (mail/SMS/WhatsApp) further down uses that brand's sender.
app.use(brandContext);

// Stripe + WhatsApp webhooks need the raw body for signature verification; parse JSON everywhere else.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/billing/webhook") return next();
  if (req.path === "/api/whatsapp/webhook") return next();
  express.json({ limit: "2mb" })(req, res, next);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, integrations: integrationsStatus() });
});

app.use("/api", apiRouter);

// Public "More info" conversation page linked from the summary SMS. Top-level
// (not under /api) to keep the SMS link short and unguessable.
app.use("/c", publicCallRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// Open the port immediately so platform health checks pass fast (critical on
// cold starts / free-tier spin-ups) — don't block listening on the DB. Platform
// settings load in the background; integration values fall back to env until ready.
app.listen(env.PORT, () => {
  console.log(`🚀 API listening on http://localhost:${env.PORT}`);
  // A cross-origin frontend that gets rejected shows up in the browser as an
  // opaque "CORS error" with nothing server-side to point at — print the
  // actual allow-list so that's a 5-second log check instead of a guess.
  // (Any host resolving to an active brand is allowed too; see the cors()
  // call above — this line only covers the fixed CORS_ORIGIN list.)
  console.log(`   CORS_ORIGIN allow-list: ${corsOrigins.join(", ") || "(empty)"}`);
  startScheduler();
  // Brand cache first: host resolution runs on every request, and the settings
  // load below also reads per-brand overrides.
  void loadBrands();
  // A tenant whose schema is behind this build stops routing until
  // `npm run tenant:migrate` has caught it up — new code never runs against an
  // old table. Loud in the log; nothing else here depends on it.
  void markStaleTenants().catch((err) => console.error("[tenantDb] stale-tenant check failed:", err));
  void loadSettings().then(() => {
    console.log(`   Integrations:`, integrationsStatus());
    // Seed any missing system-email templates (idempotent, best-effort).
    void seedEmailTemplates();
    // Starter ticket queues: the platform's own (the ones brand admins file
    // into) and each brand's customer queues. Only ever on a lane+tenant that
    // has none, so a deleted department never comes back.
    void seedAllTicketDepartments();
    // Warm the ElevenLabs voice catalog so the first AI-Brain visitor doesn't wait
    // on it. Must run AFTER loadSettings — the API key comes from settings.
    void getElevenLabsCatalog();
  });
});
