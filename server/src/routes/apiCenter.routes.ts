/* ------------------------------------------------------------------ *
 *  Admin → API Center.
 *
 *  Mounted at /api/admin/api-center. SUPER_ADMIN-only throughout (never
 *  requirePermission): this screen exposes vendor spend, key expiry and raw
 *  request logs for the platform's own API accounts. It sits with Platform
 *  Settings on the far side of the tenant boundary — not staff-assignable, and
 *  not reachable by a brand ADMIN either.
 *
 *  Shape of the API: one fat `GET /snapshot` powering the Overview, Connections,
 *  Health, Quotas, Costs and Latency screens, plus narrow endpoints for the
 *  screens that page or filter their own data (Logs, Errors, Alerts). See
 *  services/apiCenter.ts for why the snapshot is a single call.
 * ------------------------------------------------------------------ */

import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../lib/http.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import {
  apiCenterSnapshot,
  providerDetail,
  apiLogs,
  errorGroups,
  resolveRange,
  THRESHOLDS,
} from "../services/apiCenter.js";
import {
  PROVIDER_DEFS,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  providerDef,
  providerDefOrFallback,
} from "../services/apiProviders.js";
import { getProviderStatus, activeIncidents } from "../services/providerStatus.js";
import { invalidateProviderPriceCache, droppedRowCount, flushTraces } from "../services/apiTrace.js";
import {
  listAlertRules,
  listAlertEvents,
  evaluateAlertRules,
  METRIC_LABEL,
  METRIC_UNIT,
} from "../services/apiAlerts.js";
import { integrationsView } from "../services/settings.js";

const router = express.Router();

// Super-admin only. This screen exposes the platform's provider spend, key
// expiry and raw request traces — the credentials side of every API account —
// which a brand ADMIN must never see.
router.use(requireAuth, requireSuperAdmin);

/* ----------------------------- Snapshot ---------------------------- */

router.get(
  "/snapshot",
  asyncHandler(async (req, res) => {
    // Flush first so a call made a second ago is already in the numbers — the
    // dashboard feeling live matters more here than the few ms it costs.
    await flushTraces();
    const environment = typeof req.query.environment === "string" ? req.query.environment : undefined;
    const snapshot = await apiCenterSnapshot(
      typeof req.query.range === "string" ? req.query.range : undefined,
      { environment: environment && environment !== "all" ? environment : undefined },
    );
    res.json({ ...snapshot, droppedRows: droppedRowCount(), thresholds: THRESHOLDS });
  }),
);

/** Static reference data — categories and the provider registry. Cached hard by
 *  the client; it only changes when the code does. */
router.get(
  "/registry",
  asyncHandler(async (_req, res) => {
    res.json({
      categories: CATEGORY_ORDER.map((key) => ({ key, label: CATEGORY_LABEL[key] })),
      providers: PROVIDER_DEFS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        wired: p.wired,
        docsUrl: p.docsUrl,
        dashboardUrl: p.dashboardUrl ?? null,
        statusPageUrl: p.statusPageUrl ?? null,
      })),
      metrics: (Object.keys(METRIC_LABEL) as Array<keyof typeof METRIC_LABEL>).map((m) => ({
        key: m,
        label: METRIC_LABEL[m],
        unit: METRIC_UNIT[m],
      })),
    });
  }),
);

/* -------------------------- Provider detail ------------------------ */

router.get(
  "/providers/:id",
  asyncHandler(async (req, res) => {
    await flushTraces();
    const detail = await providerDetail(
      req.params.id,
      typeof req.query.range === "string" ? req.query.range : undefined,
    );
    res.json(detail);
  }),
);

/** Force a fresh read of the vendor's own status page, bypassing the TTL cache. */
router.post(
  "/providers/:id/refresh-status",
  asyncHandler(async (req, res) => {
    const def = providerDef(req.params.id);
    if (!def) throw notFound("Unknown provider");
    if (!def.statusApiUrl) throw badRequest(`${def.name} does not publish a machine-readable status feed.`);
    const status = await getProviderStatus(def.id);
    res.json(status);
  }),
);

/* -------------------------- Provider settings ---------------------- */

const settingSchema = z.object({
  monthlyQuota: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Dollars per unit, as typed by the admin; stored as micro-USD. */
  unitCostUsd: z.number().min(0).max(10_000).nullable().optional(),
  rateLimitPerMin: z.number().int().min(0).max(1_000_000).optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
  keyExpiresAt: z.string().datetime().nullable().optional(),
  muted: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.apiProviderSetting.findMany();
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    res.json(
      PROVIDER_DEFS.map((def) => {
        const row = byProvider.get(def.id);
        return {
          provider: def.id,
          name: def.name,
          category: def.category,
          unit: def.unit,
          costConfidence: def.costConfidence,
          monthlyQuota: row?.monthlyQuota ?? 0,
          unitCostUsd:
            row?.unitCostMicroUsd != null ? row.unitCostMicroUsd / 1_000_000 : (def.defaultUnitCostUsd ?? null),
          /** True once an admin has overridden the code default. */
          unitCostOverridden: row?.unitCostMicroUsd != null,
          rateLimitPerMin: row?.rateLimitPerMin ?? 0,
          environment: row?.environment ?? "production",
          keyExpiresAt: row?.keyExpiresAt ? row.keyExpiresAt.toISOString() : null,
          muted: row?.muted ?? false,
          notes: row?.notes ?? "",
        };
      }),
    );
  }),
);

router.put(
  "/settings/:provider",
  asyncHandler(async (req, res) => {
    const def = providerDef(req.params.provider);
    if (!def) throw notFound("Unknown provider");
    const parsed = settingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid settings", parsed.error.flatten());
    const body = parsed.data;

    const data = {
      ...(body.monthlyQuota !== undefined ? { monthlyQuota: body.monthlyQuota } : {}),
      ...(body.unitCostUsd !== undefined
        ? { unitCostMicroUsd: body.unitCostUsd === null ? null : Math.round(body.unitCostUsd * 1_000_000) }
        : {}),
      ...(body.rateLimitPerMin !== undefined ? { rateLimitPerMin: body.rateLimitPerMin } : {}),
      ...(body.environment !== undefined ? { environment: body.environment } : {}),
      ...(body.keyExpiresAt !== undefined
        ? { keyExpiresAt: body.keyExpiresAt === null ? null : new Date(body.keyExpiresAt) }
        : {}),
      ...(body.muted !== undefined ? { muted: body.muted } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    };

    const row = await prisma.apiProviderSetting.upsert({
      where: { provider: def.id },
      create: { provider: def.id, ...data },
      update: data,
    });
    // The tracer caches prices for a minute; drop it so the next call is costed
    // at the new rate rather than the old one.
    invalidateProviderPriceCache();

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "api_center.settings.update",
      targetType: "apiProvider",
      targetId: def.id,
      metadata: data as Record<string, unknown>,
      ip: req.ip,
    });

    // Return the SAME shape as GET /settings so the client can drop the saved
    // row straight back into its list without re-merging fields by hand.
    res.json({
      provider: def.id,
      name: def.name,
      category: def.category,
      unit: def.unit,
      costConfidence: def.costConfidence,
      monthlyQuota: row.monthlyQuota,
      unitCostUsd:
        row.unitCostMicroUsd != null ? row.unitCostMicroUsd / 1_000_000 : (def.defaultUnitCostUsd ?? null),
      unitCostOverridden: row.unitCostMicroUsd != null,
      rateLimitPerMin: row.rateLimitPerMin,
      environment: row.environment,
      keyExpiresAt: row.keyExpiresAt ? row.keyExpiresAt.toISOString() : null,
      muted: row.muted,
      notes: row.notes,
    });
  }),
);

/* ------------------------------ API keys --------------------------- */

/**
 * Credential status per provider. Values come from settings.ts already masked —
 * this endpoint never sees or returns a raw secret, only whether one is set,
 * its last four characters, and when it expires.
 */
router.get(
  "/keys",
  asyncHandler(async (_req, res) => {
    const [integrations, settings] = await Promise.all([
      Promise.resolve(integrationsView()),
      prisma.apiProviderSetting.findMany(),
    ]);
    const viewById = new Map(integrations.map((i) => [i.id, i]));
    const settingByProvider = new Map(settings.map((s) => [s.provider, s]));

    res.json(
      PROVIDER_DEFS.filter((def) => def.id !== "self").map((def) => {
        const view = def.integrationId ? viewById.get(def.integrationId) : undefined;
        const setting = settingByProvider.get(def.id);
        const expiresAt = setting?.keyExpiresAt ?? null;
        const daysToExpiry = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
        return {
          provider: def.id,
          name: def.name,
          category: def.category,
          authMethod: def.authMethod,
          wired: def.wired,
          /** Whether the platform holds credentials for this vendor at all. */
          configured: view ? view.fields.some((f) => f.isSet) : false,
          /** Managed outside the admin UI (server env only) — e.g. Stripe. */
          managedExternally: !def.integrationId && def.wired,
          fields: (view?.fields ?? []).map((f) => ({ key: f.key, label: f.label, isSet: f.isSet, value: f.value })),
          keyExpiresAt: expiresAt ? expiresAt.toISOString() : null,
          daysToExpiry,
          environment: setting?.environment ?? "production",
          docsUrl: def.docsUrl,
          dashboardUrl: def.dashboardUrl ?? null,
        };
      }),
    );
  }),
);

/* -------------------------------- Logs ----------------------------- */

const logQuerySchema = z.object({
  provider: z.string().max(64).optional(),
  status: z.enum(["all", "success", "error"]).optional(),
  environment: z.string().max(32).optional(),
  search: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(10).max(200).optional(),
});

router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    await flushTraces();
    const parsed = logQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid filters", parsed.error.flatten());
    const q = parsed.data;
    const page = await apiLogs({
      provider: q.provider,
      status: q.status,
      environment: q.environment,
      search: q.search,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      page: q.page,
      pageSize: q.pageSize,
    });
    res.json(page);
  }),
);

/** CSV of the current filter selection, for taking a failure to a vendor's support. */
router.get(
  "/logs.csv",
  asyncHandler(async (req, res) => {
    const parsed = logQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid filters", parsed.error.flatten());
    const q = parsed.data;
    const page = await apiLogs({
      provider: q.provider,
      status: q.status,
      environment: q.environment,
      search: q.search,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      page: 1,
      pageSize: 200,
    });

    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = "time,provider,method,endpoint,status,ok,duration_ms,environment,units,cost_usd,error";
    const lines = page.rows.map((r) =>
      [
        r.createdAt,
        r.provider,
        r.method,
        r.endpoint,
        r.status,
        r.ok,
        r.durationMs,
        r.environment,
        r.units,
        r.costUsd.toFixed(6),
        r.errorMessage,
      ]
        .map(esc)
        .join(","),
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="api-logs.csv"`);
    res.send([header, ...lines].join("\n"));
  }),
);

/* ------------------------------- Errors ---------------------------- */

router.get(
  "/errors",
  asyncHandler(async (req, res) => {
    const provider = typeof req.query.provider === "string" && req.query.provider !== "all" ? req.query.provider : undefined;
    const groups = await errorGroups(typeof req.query.range === "string" ? req.query.range : undefined, provider);
    res.json({ range: resolveRange(typeof req.query.range === "string" ? req.query.range : undefined).key, groups });
  }),
);

/* ------------------------------ Incidents -------------------------- */

router.get(
  "/incidents",
  asyncHandler(async (_req, res) => {
    const incidents = await activeIncidents();
    res.json(
      incidents.map((s) => ({
        ...s,
        providerName: providerDefOrFallback(s.provider).name,
      })),
    );
  }),
);

/* ------------------------------- Alerts ---------------------------- */

router.get(
  "/alerts",
  asyncHandler(async (req, res) => {
    // Evaluate on read so the board is current the moment it's opened, rather
    // than up to one scheduler tick stale.
    await evaluateAlertRules();
    const status = req.query.status === "all" ? "all" : "open";
    const [events, rules] = await Promise.all([listAlertEvents(status), listAlertRules()]);
    res.json({ events, rules });
  }),
);

const ruleSchema = z.object({
  provider: z.string().max(64).nullable().optional(),
  metric: z.enum(["error_rate", "latency_p95", "quota_used", "uptime", "no_traffic"]),
  comparator: z.enum(["gt", "lt"]).optional(),
  threshold: z.number().min(0).max(1_000_000),
  windowMin: z.number().int().min(5).max(10_080).optional(),
  severity: z.enum(["warning", "critical"]).optional(),
  enabled: z.boolean().optional(),
  cooldownMin: z.number().int().min(5).max(10_080).optional(),
});

router.post(
  "/alerts/rules",
  asyncHandler(async (req, res) => {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid rule", parsed.error.flatten());
    const body = parsed.data;
    if (body.provider && !providerDef(body.provider)) throw badRequest("Unknown provider");

    const rule = await prisma.apiAlertRule.create({
      data: {
        provider: body.provider ?? null,
        metric: body.metric,
        comparator: body.comparator ?? "gt",
        threshold: body.threshold,
        windowMin: body.windowMin ?? 60,
        severity: body.severity ?? "warning",
        enabled: body.enabled ?? true,
        cooldownMin: body.cooldownMin ?? 60,
      },
    });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "api_center.alert_rule.create",
      targetType: "apiAlertRule",
      targetId: rule.id,
      metadata: { metric: rule.metric, threshold: rule.threshold, provider: rule.provider },
      ip: req.ip,
    });
    res.status(201).json(await listAlertRules());
  }),
);

router.patch(
  "/alerts/rules/:id",
  asyncHandler(async (req, res) => {
    const parsed = ruleSchema.partial().safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid rule", parsed.error.flatten());
    const existing = await prisma.apiAlertRule.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Rule not found");

    await prisma.apiAlertRule.update({ where: { id: req.params.id }, data: parsed.data });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "api_center.alert_rule.update",
      targetType: "apiAlertRule",
      targetId: req.params.id,
      metadata: parsed.data as Record<string, unknown>,
      ip: req.ip,
    });
    res.json(await listAlertRules());
  }),
);

router.delete(
  "/alerts/rules/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.apiAlertRule.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Rule not found");
    await prisma.apiAlertRule.delete({ where: { id: req.params.id } });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "api_center.alert_rule.delete",
      targetType: "apiAlertRule",
      targetId: req.params.id,
      metadata: { metric: existing.metric, provider: existing.provider },
      ip: req.ip,
    });
    res.json(await listAlertRules());
  }),
);

router.post(
  "/alerts/:id/acknowledge",
  asyncHandler(async (req, res) => {
    const event = await prisma.apiAlertEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw notFound("Alert not found");
    await prisma.apiAlertEvent.update({ where: { id: req.params.id }, data: { acknowledgedAt: new Date() } });
    res.json(await listAlertEvents(req.query.status === "all" ? "all" : "open"));
  }),
);

router.post(
  "/alerts/:id/resolve",
  asyncHandler(async (req, res) => {
    const event = await prisma.apiAlertEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw notFound("Alert not found");
    await prisma.apiAlertEvent.update({ where: { id: req.params.id }, data: { resolvedAt: new Date() } });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "api_center.alert.resolve",
      targetType: "apiAlertEvent",
      targetId: req.params.id,
      metadata: { provider: event.provider, metric: event.metric },
      ip: req.ip,
    });
    res.json(await listAlertEvents(req.query.status === "all" ? "all" : "open"));
  }),
);

export default router;
