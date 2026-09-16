// Calls, CRM settings and delivery logs all live in the brand's DB, so the brand
// travels beside the call here rather than on it.
import type { CallLog, CrmIntegration, WebhookDelivery } from "@prisma/tenant-client";
import { tenantForUser, tenantsFor, type TenantClient } from "./tenantDb.js";
import { getEffective, integrationsStatus } from "./settings.js";
import { getPlanFeatures } from "./trial.js";
import { callerLabel } from "../lib/callerName.js";
import { env } from "../env.js";
import { signRecording } from "../lib/jwt.js";
import { brandDisplayName } from "../lib/brandUrls.js";
import { vapiCallIdOf } from "./callArchive.js";

interface DeliveryResult {
  success: boolean;
  status: number;
  responseBody: string;
  errorMessage: string;
  durationMs: number;
}

// Recording link for the CRM: our proxy with a signed, expiring token, not the raw
// call id — Vapi's storage URL isn't public, and a CRM lead shouldn't carry a permanent audio link.
function crmRecordingUrl(call: CallLog, brandId: string | null | undefined): string | null {
  const hasRecording = Boolean(call.recordingUrl) || Boolean(vapiCallIdOf(call));
  if (!hasRecording) return null;
  const base = (env.VAPI_SERVER_URL || env.PUBLIC_API_URL || "").replace(/\/$/, "");
  // The token names the brand whose database holds the call; without one there
  // is nothing the proxy could look up, so fall back to the stored URL.
  if (!base || !brandId) return call.recordingUrl ?? null;
  return `${base}/api/calls/recording-file/${signRecording(call.id, brandId, "30d")}`;
}

/** The member a call belongs to, attached to Perfex leads so members are distinguishable in the shared CRM. */
export interface LeadOwner {
  userId: string;
  businessName: string;
  fullName: string;
  email: string;
}

/** Load the member identity for a user (best-effort; never throws). */
async function loadLeadOwner(userId: string): Promise<LeadOwner> {
  const user = await tenantForUser(userId)
    .then((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: { email: true, fullName: true, profile: { select: { businessName: true } } },
      }),
    )
    .catch(() => null);

  return {
    userId,
    businessName: user?.profile?.businessName?.trim() ?? "",
    fullName: user?.fullName?.trim() ?? "",
    email: user?.email?.trim() ?? "",
  };
}

/** Human-readable label for the owner, used for the Perfex "Company" column. */
function ownerLabel(owner: LeadOwner): string {
  return owner.businessName || owner.fullName || owner.email || `Member ${owner.userId}`;
}

// Test-call leads land in the owner's REAL pipeline, so mark them loudly.
const TEST_LEAD_PREFIX = "[TEST]";

function buildLeadPayload(call: CallLog, brandId: string | null | undefined, test = false) {
  return {
    event: test ? "call.test" : "call.completed",
    /** True when this lead came from the agent tester, not a real caller. */
    test,
    timestamp: new Date().toISOString(),
    call: {
      id: call.id,
      type: call.type,
      intent: call.intent,
      callerName: callerLabel(call.callerName),
      callerNumber: call.callerNumber,
      durationSec: call.durationSec,
      outcome: call.outcome,
      summary: call.summary,
      recordingUrl: crmRecordingUrl(call, brandId),
      transcript: call.transcript,
      analysis: call.analysis,
      createdAt: call.createdAt.toISOString(),
    },
  };
}

async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<DeliveryResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseBody = await res.text().catch(() => "");
    return {
      success: res.ok,
      status: res.status,
      responseBody: responseBody.slice(0, 2000),
      errorMessage: res.ok ? "" : `HTTP ${res.status}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      responseBody: "",
      errorMessage: err instanceof Error ? err.message : "Network error",
      durationMs: Date.now() - start,
    };
  }
}

/** POST form-urlencoded (for Perfex web-to-lead). */
async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<DeliveryResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const body = new URLSearchParams(fields).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseBody = await res.text().catch(() => "");
    let perfexSuccess = res.ok;
    try {
      const json = JSON.parse(responseBody);
      if (typeof json.success === "boolean") perfexSuccess = json.success;
    } catch { /* not JSON, use HTTP status */ }

    return {
      success: perfexSuccess,
      status: res.status,
      responseBody: responseBody.slice(0, 2000),
      errorMessage: perfexSuccess ? "" : `HTTP ${res.status}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      responseBody: "",
      errorMessage: err instanceof Error ? err.message : "Network error",
      durationMs: Date.now() - start,
    };
  }
}

// Perfex web-to-lead fields. With `owner` (shared admin CRM) the member goes in `company`
// plus an Account block in the description. wtl accepts any real tbl_leads column.
function buildNexleonLeadFields(
  call: CallLog,
  formKey: string,
  owner?: LeadOwner,
  test = false,
): Record<string, string> {
  const accountBlock = owner
    ? `Account: ${ownerLabel(owner)}\n` +
      (owner.email ? `Account Email: ${owner.email}\n` : "") +
      `Account ID: ${owner.userId}\n\n`
    : "";

  const testBlock = test
    ? `*** ${TEST_LEAD_PREFIX} This lead came from an in-app test call in hello22.ai, ` +
      `not a real customer. Safe to delete. ***\n\n`
    : "";

  const description =
    testBlock +
    accountBlock +
    `AI Receptionist Call Summary\n` +
    `Outcome: ${call.outcome}\n` +
    (call.intent ? `Category: ${call.intent}\n` : "") +
    `Duration: ${call.durationSec}s\n` +
    `Type: ${call.type}\n` +
    `Date: ${call.createdAt.toISOString()}\n\n` +
    (call.summary || "");

  // Never "Unknown": a call where the caller didn't give a name still lands in
  // the owner's pipeline, so it goes in as "Caller" (see lib/callerName).
  const name = callerLabel(call.callerName);
  const fields: Record<string, string> = {
    key: formKey,
    // Prefix the NAME too — it's the column an owner scans in the leads list.
    name: test ? `${TEST_LEAD_PREFIX} ${name}` : name,
    phonenumber: call.callerNumber || "",
    description,
  };

  if (owner) {
    fields.company = ownerLabel(owner);
  }

  return fields;
}

async function logDelivery(
  db: TenantClient,
  crmId: string | null,
  callLogId: string | null,
  provider: string,
  url: string,
  payload: unknown,
  result: DeliveryResult,
) {
  await db.webhookDelivery.create({
    data: {
      crmIntegrationId: crmId,
      callLogId,
      provider,
      url,
      status: result.status,
      success: result.success,
      payload: (typeof payload === "object" && payload !== null ? payload : { raw: String(payload) }) as object,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    },
  });
}

// Admin-global Perfex delivery: every user's leads go here.

async function deliverToAdminNexleon(
  db: TenantClient,
  call: CallLog,
  owner: LeadOwner,
  test = false,
): Promise<void> {
  if (!integrationsStatus().perfex) return;

  const nexleonUrl = getEffective("perfex.url").trim().replace(/\/$/, "");
  const formKey = getEffective("perfex.formKey").trim();
  if (!nexleonUrl || !formKey) return;

  const url = `${nexleonUrl}/forms/wtl/${formKey}`;
  const fields = buildNexleonLeadFields(call, formKey, owner, test);
  const result = await postForm(url, fields);

  await logDelivery(db, null, call.id, "perfex-global", url, fields, result);
}

// Per-user CRM delivery.

async function deliverToUserCrm(
  userId: string,
  call: CallLog,
  brandId: string | null | undefined,
  preloaded?: CrmIntegration | null,
  test = false,
): Promise<void> {
  const db = await tenantForUser(userId);
  const crm = preloaded ?? (await db.crmIntegration.findUnique({ where: { userId } }));
  if (!crm || !crm.connectedProvider) return;

  let result: DeliveryResult;
  let url: string;
  let provider: string;
  let payload: unknown;

  if (crm.connectedProvider === "perfex" && crm.nexleonUrl && crm.nexleonFormKey) {
    provider = "perfex";
    url = crm.nexleonUrl.trim().replace(/\/$/, "") + "/forms/wtl/" + crm.nexleonFormKey;
    const fields = buildNexleonLeadFields(call, crm.nexleonFormKey, undefined, test);
    payload = fields;
    result = await postForm(url, fields);
  } else if (crm.connectedProvider === "custom" && crm.customWebhookUrl.trim()) {
    // Custom CRM is plan-gated: a stale "custom" selection (e.g. after a
    // downgrade) must not keep delivering leads to the webhook.
    const features = await getPlanFeatures(userId);
    if (!features.customCrm) return;
    provider = "custom";
    url = crm.customWebhookUrl.trim();
    payload = buildLeadPayload(call, brandId, test);
    result = await postJson(url, payload);
  } else {
    return;
  }

  await logDelivery(db, crm.id, call.id, provider, url, payload, result);
}

// Public API.

/** Delivers a lead to the admin-global Perfex and the user's own CRM. Best-effort. `opts.test` still hits the real CRM (so the owner can verify end to end) but is marked "[TEST]". */
export async function deliverCallToCrm(
  userId: string,
  call: CallLog,
  opts: { test?: boolean; brandId?: string | null } = {},
): Promise<void> {
  const test = Boolean(opts.test);
  try {
    // If the user has their own Perfex configured, skip the admin-global one
    // to avoid duplicate leads when both point to the same instance.
    const db = await tenantForUser(userId);
    const [crm, owner] = await Promise.all([
      db.crmIntegration.findUnique({ where: { userId } }),
      loadLeadOwner(userId),
    ]);
    const userHasNexleon = crm?.connectedProvider === "perfex" && crm.nexleonUrl && crm.nexleonFormKey;

    await Promise.all([
      userHasNexleon ? Promise.resolve() : deliverToAdminNexleon(db, call, owner, test),
      deliverToUserCrm(userId, call, opts.brandId, crm, test),
    ]);
  } catch {
    // Best-effort: never break the call ingestion flow
  }
}

/** Sends a test payload to the user's webhook and returns the result. */
export async function testWebhookDelivery(crm: CrmIntegration): Promise<DeliveryResult> {
  let result: DeliveryResult;
  let url: string;
  let provider: string;
  let payload: unknown;

  if (crm.connectedProvider === "perfex" && crm.nexleonUrl && crm.nexleonFormKey) {
    provider = "perfex";
    url = crm.nexleonUrl.trim().replace(/\/$/, "") + "/forms/wtl/" + crm.nexleonFormKey;
    const fields: Record<string, string> = {
      key: crm.nexleonFormKey,
      name: `Test Caller (${brandDisplayName()})`,
      phonenumber: "+1234567890",
      description: `This is a test lead from ${brandDisplayName()} to verify your Nexleon CRM integration is working correctly.`,
    };
    payload = fields;
    result = await postForm(url, fields);
  } else if (crm.customWebhookUrl.trim()) {
    provider = "custom";
    url = crm.customWebhookUrl.trim();
    payload = buildTestPayload();
    result = await postJson(url, payload);
  } else {
    return { success: false, status: 0, responseBody: "", errorMessage: "No webhook configured", durationMs: 0 };
  }

  await logDelivery(await tenantForUser(crm.userId), crm.id, null, provider, url, payload, result);
  return result;
}

/** Tests the admin-global Perfex connection. */
export async function testAdminNexleon(): Promise<DeliveryResult> {
  const nexleonUrl = getEffective("perfex.url").trim().replace(/\/$/, "");
  const formKey = getEffective("perfex.formKey").trim();

  if (!nexleonUrl || !formKey) {
    return { success: false, status: 0, responseBody: "", errorMessage: "Nexleon CRM not configured", durationMs: 0 };
  }

  const url = `${nexleonUrl}/forms/wtl/${formKey}`;
  const fields: Record<string, string> = {
    key: formKey,
    name: `Test Caller (${brandDisplayName()} Admin)`,
    phonenumber: "+1234567890",
    description: "Admin test — verifying the global Nexleon CRM integration is working.",
  };

  // A platform-level test belongs to no brand, so there is no delivery log to
  // write it to; the result goes back to the admin who clicked.
  return postForm(url, fields);
}

/** Retries a logged delivery with its stored url + payload, recording a fresh row. */
export async function retryDelivery(
  deliveryId: string,
  brandId: string | null | undefined,
): Promise<DeliveryResult> {
  // The delivery is in some brand's database: the caller's own brand, or —
  // for the platform's own people — whichever brand's holds it.
  let found: { db: TenantClient; delivery: WebhookDelivery } | null = null;
  for (const { db } of await tenantsFor(brandId)) {
    const delivery = await db.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (delivery) {
      found = { db, delivery };
      break;
    }
  }
  if (!found) {
    return { success: false, status: 0, responseBody: "", errorMessage: "Delivery not found", durationMs: 0 };
  }
  const { db, delivery } = found;

  const payload = delivery.payload;
  let result: DeliveryResult;
  if (delivery.provider.startsWith("perfex")) {
    const fields = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, string>;
    result = await postForm(delivery.url, fields);
  } else {
    result = await postJson(delivery.url, payload);
  }

  await logDelivery(db, delivery.crmIntegrationId, delivery.callLogId, delivery.provider, delivery.url, payload, result);
  return result;
}

export interface WebhookStats {
  total: number;
  success: number;
  failed: number;
  successRate: number; // 0..100
  avgLatencyMs: number;
  last24h: number;
}

/** Aggregate counts across webhook deliveries (for system health / logs UI):
 *  one brand's, or every brand's summed for the platform. */
export async function webhookStats(brandId: string | null | undefined = null): Promise<WebhookStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let total = 0;
  let success = 0;
  let last24h = 0;
  let latencySum = 0;
  let latencyRows = 0;
  for (const { db } of await tenantsFor(brandId)) {
    const [t, s, latency, l] = await Promise.all([
      db.webhookDelivery.count(),
      db.webhookDelivery.count({ where: { success: true } }),
      db.webhookDelivery.aggregate({ _avg: { durationMs: true }, _count: { _all: true } }),
      db.webhookDelivery.count({ where: { createdAt: { gte: since } } }),
    ]);
    total += t;
    success += s;
    last24h += l;
    // A mean of means would weight a quiet brand like a busy one.
    latencySum += (latency._avg.durationMs ?? 0) * latency._count._all;
    latencyRows += latency._count._all;
  }
  const failed = total - success;
  return {
    total,
    success,
    failed,
    successRate: total > 0 ? Math.round((success / total) * 100) : 0,
    avgLatencyMs: latencyRows > 0 ? Math.round(latencySum / latencyRows) : 0,
    last24h,
  };
}

function buildTestPayload() {
  return {
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    call: {
      id: "test_call_001",
      type: "Phone",
      callerName: "Test Caller",
      callerNumber: "+1234567890",
      durationSec: 45,
      outcome: "completed",
      summary: `This is a test webhook delivery from ${brandDisplayName()} to verify your CRM integration is working correctly.`,
      recordingUrl: null,
      transcript: [],
      analysis: {},
      createdAt: new Date().toISOString(),
    },
  };
}
