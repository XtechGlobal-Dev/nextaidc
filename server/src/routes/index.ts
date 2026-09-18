import { Router } from "express";
import authRouter from "./auth.routes.js";
import profileRouter from "./profile.routes.js";
import agentRouter from "./agent.routes.js";
import callsRouter from "./calls.routes.js";
import notificationsRouter from "./notifications.routes.js";
import ticketsRouter from "./tickets.routes.js";
import adminTicketsRouter from "./adminTickets.routes.js";
import trialRouter from "./trial.routes.js";
import crmRouter from "./crm.routes.js";
import transferRouter from "./transfer.routes.js";
import chatRouter from "./chat.routes.js";
import billingRouter from "./billing.routes.js";
import adminRouter from "./admin.routes.js";
import adminPhonesRouter from "./adminPhones.routes.js";
import brandsRouter from "./brands.routes.js";
import platformViewsRouter from "./platformViews.routes.js";
import brandAdminRouter from "./brandAdmin.routes.js";
import apiCenterRouter from "./apiCenter.routes.js";
import resellerRouter from "./reseller.routes.js";
import onboardRouter from "./onboard.routes.js";
import bookingRouter from "./booking.routes.js";
import bookingModuleRouter from "./bookingModule.routes.js";
import bookingAiRouter from "./bookingAi.routes.js";
import aiSmsRouter from "./aiSms.routes.js";
import ttsRouter from "./tts.routes.js";
import googleRouter from "./google.routes.js";
import whatsappRouter from "./whatsapp.routes.js";
import voicesRouter from "./voices.routes.js";
import industriesRouter from "./industries.routes.js";
import eventsRouter from "./events.routes.js";
import unsubscribeRouter from "./unsubscribe.routes.js";
import { getEffective } from "../services/settings.js";
import { emptyBranding, getBranding } from "../services/branding.js";
import { getSeoScripts } from "../services/seo.js";
import { brandBySlug, publicBrand } from "../services/brands.js";
import { brandScripts } from "../services/brandSetup.js";
import { requireBrandModule } from "../middleware/brandModule.js";
import { asyncHandler } from "../lib/http.js";

export const apiRouter = Router();

// Public, non-secret runtime config for the SPA. `brand` is the tenant the host
// resolved to (null on the platform domain) so brand pages look right before sign-in.
//
// Every async route goes through asyncHandler: Express 4 does not catch a rejected
// handler, and Node exits on an unhandled rejection — so before this wrapper, one
// page load during a database blip took the whole API down. The SPA can't boot
// without /config, so the branding lookup also degrades to empty rather than 500.
apiRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    const branding = await getBranding().catch((err: unknown) => {
      console.error("[config] branding unavailable, serving defaults:", err instanceof Error ? err.message : err);
      return emptyBranding();
    });
    res.json({
      vapiPublicKey: getEffective("vapi.publicKey", req.brand?.id ?? null),
      branding,
      // A brand host gets the BRAND's snippets, not the platform's on top: a
      // tenant's pages must never carry the platform's analytics or chat widget.
      scripts: req.brand ? brandScripts(req.brand) : await getSeoScripts(),
      brand: req.brand ? publicBrand(req.brand) : null,
    });
  }),
);

// Brand by slug for the SPA's path-based tenant lookup. Public on purpose — it only
// returns what a visitor sees anyway; unknown/suspended slug is a 404 so the SPA falls back.
apiRouter.get(
  "/brand/:slug",
  asyncHandler(async (req, res) => {
    const brand = brandBySlug(req.params.slug);
    if (!brand) {
      res.status(404).json({ error: "No such brand" });
      return;
    }
    res.json(publicBrand(brand));
  }),
);

apiRouter.use("/unsubscribe", unsubscribeRouter);
apiRouter.use("/events", eventsRouter);
apiRouter.use("/onboard", onboardRouter);
apiRouter.use("/bookings", bookingRouter);
// `/booking/ai` (public Vapi dispatcher) mounts before `/booking` so the specific
// path wins. `/bookings` above is the unrelated marketing demo form.
apiRouter.use("/booking/ai", bookingAiRouter);
// Module switches gate the owner APIs (403 when the brand turned it off). The public
// Vapi dispatchers (/booking/ai, /ai/sms) carry no request brand, so they aren't gated.
apiRouter.use("/booking", requireBrandModule("booking"), bookingModuleRouter);
// Public Vapi tool dispatcher for "Text Info to Callers" (sendInfoSms).
apiRouter.use("/ai/sms", aiSmsRouter);
apiRouter.use("/tts", ttsRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/agent", agentRouter);
apiRouter.use("/voices", voicesRouter);
apiRouter.use("/industries", industriesRouter);
apiRouter.use("/calls", callsRouter);
apiRouter.use("/notifications", notificationsRouter);
// Tickets, requester side. Lane (customer→brand or brand admin→platform) is picked
// by role, not URL — see lib/ticketLanes.ts.
apiRouter.use("/tickets", ticketsRouter);
apiRouter.use("/trial", trialRouter);
apiRouter.use("/crm", requireBrandModule("crm"), crmRouter);
apiRouter.use("/transfer", requireBrandModule("transfer"), transferRouter);
apiRouter.use("/google", googleRouter);
apiRouter.use("/whatsapp", whatsappRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/billing", billingRouter);
// Super-admin only: white-label brands (tenants). Its own prefix, not /admin,
// so the boundary is visible in the URL as well as in the middleware.
apiRouter.use("/super", brandsRouter);
// The super admin's overview, the customer directory, and one brand's inside
// (its customers, subscriptions, support) — see platformViews.routes.ts.
apiRouter.use("/super", platformViewsRouter);
apiRouter.use("/admin/phones", adminPhonesRouter);
// The handler side of the same two lanes — a brand admin's customer inbox, or
// the super admin's brand-request inbox.
apiRouter.use("/admin/tickets", adminTicketsRouter);
// Mounted before /admin so the more specific prefix wins.
apiRouter.use("/admin/api-center", apiCenterRouter);
// A brand admin's own pricing addons and wallet. Mounted before /admin so the
// more specific prefix wins; scoped to the caller's brand, never by id.
apiRouter.use("/admin/brand", brandAdminRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/reseller", resellerRouter);
