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

// Behind Render's proxy req.ip would be the proxy for everyone (one attacker's burst would
// rate-limit all users). A fixed hop count, not `true`, so clients can't spoof X-Forwarded-For.
app.set("trust proxy", env.TRUST_PROXY_HOPS);

// Any host resolving to an active brand is allowed too — brands are created at runtime, so a new
// subdomain can't wait for a CORS_ORIGIN redeploy. Unknown/suspended hosts are still refused.
app.use(
  cors({
    origin(origin, callback) {
      // No Origin = same-origin, curl or webhooks; never a cross-site risk, and blocking breaks webhooks.
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

// Resolve the brand from Host before routing so anonymous visitors get the brand's look and sends use its sender.
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

// Listen before the DB is ready so health checks pass on cold starts; settings load in the background
// and integrations fall back to env until then.
app.listen(env.PORT, () => {
  console.log(`🚀 API listening on http://localhost:${env.PORT}`);
  // A rejected origin is an opaque "CORS error" in the browser — log the fixed list so it's a quick check.
  console.log(`   CORS_ORIGIN allow-list: ${corsOrigins.join(", ") || "(empty)"}`);
  startScheduler();
  // Brand cache first: host resolution and the settings load both need it.
  void loadBrands();
  // A tenant behind this build's schema stops routing until `npm run tenant:migrate` catches it up.
  void markStaleTenants().catch((err) => console.error("[tenantDb] stale-tenant check failed:", err));
  void loadSettings().then(() => {
    console.log(`   Integrations:`, integrationsStatus());
    // Seed any missing system-email templates (idempotent, best-effort).
    void seedEmailTemplates();
    // Only seeds a lane+tenant that has none, so a deleted department never comes back.
    void seedAllTicketDepartments();
    // Warm the voice catalog. Must run after loadSettings — the API key comes from settings.
    void getElevenLabsCatalog();
  });
});
