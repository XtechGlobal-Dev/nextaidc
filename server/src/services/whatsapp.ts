import { notImplemented } from "../lib/http.js";
import { env } from "../env.js";
import { getEffective, integrationConfiguredFor } from "./settings.js";
import { traceFetch } from "./apiTrace.js";
import { currentBrandId } from "../lib/brandContext.js";

/**
 * WhatsApp Business Cloud API (Meta) — sends messages via the Graph API.
 *
 * Required settings (Admin → Settings):
 *   whatsapp.accessToken   — permanent or system-user token from Meta Business
 *   whatsapp.phoneNumberId — the Phone Number ID from WhatsApp Business Manager
 *
 * API docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */

const API_VERSION = "v21.0";

/* Every credential read below is brand-aware: a white-label tenant can bring
 * its own WhatsApp sender, so messages reach that tenant's customers from the
 * tenant's number. With no brand resolved (background work, the platform's own
 * domain) these fall through to the platform credentials exactly as before. */
function apiUrl(brandId?: string | null): string {
  const phoneNumberId = getEffective("whatsapp.phoneNumberId", brandId ?? currentBrandId()).trim();
  if (!phoneNumberId) throw notImplemented("WhatsApp Phone Number ID not configured");
  return `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
}

function accessToken(brandId?: string | null): string {
  const token = getEffective("whatsapp.accessToken", brandId ?? currentBrandId()).trim();
  if (!token) throw notImplemented("WhatsApp access token not configured");
  return token;
}

/** True when both the access token and phone number ID are configured — for the
 *  ambient tenant, so a brand with its own WhatsApp sender counts as configured
 *  whatever the platform has. */
export function isWhatsAppConfigured(brandId?: string | null): boolean {
  return integrationConfiguredFor("whatsapp", brandId !== undefined ? brandId : currentBrandId());
}

/** Public callback URL Meta should post inbound messages to. Empty when no
 *  public base URL is configured (PUBLIC_API_URL → VAPI_SERVER_URL fallback). */
export function whatsAppWebhookUrl(): string {
  const base = (env.PUBLIC_API_URL || env.VAPI_SERVER_URL || "").replace(/\/$/, "");
  return base ? `${base}/api/whatsapp/webhook` : "";
}

/** Verify the saved credentials by reading the phone number from the Graph API —
 *  no message is sent. Returns a structured result for the admin UI. */
export async function verifyWhatsAppConnection(): Promise<{ success: boolean; message: string }> {
  if (!isWhatsAppConfigured()) {
    return { success: false, message: "Set Access Token + Phone Number ID first." };
  }
  const phoneNumberId = getEffective("whatsapp.phoneNumberId", currentBrandId()).trim();
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken()}` } },
    );
    const data = (await res.json()) as {
      error?: { message?: string };
      verified_name?: string;
      display_phone_number?: string;
    };
    if (!res.ok) {
      return { success: false, message: data.error?.message || `Graph API ${res.status}` };
    }
    const name = data.verified_name ? `${data.verified_name} ` : "";
    const num = data.display_phone_number ? `(${data.display_phone_number})` : "";
    return { success: true, message: `Connected to ${name}${num}`.trim() };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Connection failed" };
  }
}

/** Send a plain text WhatsApp message via Meta's Cloud API.
 *  Returns the parsed response body (contains message id on success). */
export async function sendWhatsApp(to: string, body: string): Promise<Record<string, unknown>> {
  const recipient = to.replace(/^\+/, "");

  const res = await traceFetch("whatsapp", apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (!res.ok) {
    const errMsg = (data as { error?: { message?: string } })?.error?.message
      || JSON.stringify(data);
    throw new Error(`WhatsApp API ${res.status}: ${errMsg}`);
  }

  console.log("[whatsapp] sent to", recipient, "→", JSON.stringify(data));
  return data;
}

/** Send a template message via Meta's Cloud API. Template messages bypass the
 *  24-hour conversation window. Pass `bodyParams` for templates with {{1}}, {{2}}…
 *  placeholders in the body. */
export async function sendWhatsAppTemplate(
  to: string,
  template = "hello_world",
  languageCode = "en_US",
  bodyParams?: string[],
): Promise<Record<string, unknown>> {
  const recipient = to.replace(/^\+/, "");

  const templatePayload: Record<string, unknown> = {
    name: template,
    language: { code: languageCode },
  };

  if (bodyParams?.length) {
    templatePayload.components = [
      {
        type: "body",
        parameters: bodyParams.map((text) => ({ type: "text", text })),
      },
    ];
  }

  const res = await traceFetch("whatsapp", apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: templatePayload,
    }),
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (!res.ok) {
    const errMsg = (data as { error?: { message?: string } })?.error?.message
      || JSON.stringify(data);
    throw new Error(`WhatsApp API ${res.status}: ${errMsg}`);
  }

  console.log("[whatsapp] template sent to", recipient, "→", JSON.stringify(data));
  return data;
}

/** Send a test message to verify the Access Token + Phone Number ID work.
 *  Uses a template message (hello_world) so it works outside the 24-hour window.
 *  Returns a structured result instead of throwing, for the admin UI. */
export async function sendTestWhatsApp(
  to: string,
): Promise<{ success: boolean; message: string }> {
  if (!isWhatsAppConfigured()) {
    return { success: false, message: "WhatsApp not configured — set Access Token + Phone Number ID first." };
  }
  try {
    const data = await sendWhatsAppTemplate(to);
    const msgId = ((data.messages as { id?: string }[])?.[0]?.id) ?? "";
    const idHint = msgId ? ` (id: ${msgId.slice(0, 20)}…)` : "";
    return { success: true, message: `Template sent${idHint}. Check WhatsApp on ${to}.` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Failed to send" };
  }
}

/** Post-call WhatsApp summary to the agent owner. Uses the template configured
 *  in `whatsapp.callTemplate` (Admin → Settings) so it always delivers regardless
 *  of the 24-hour window. Falls back to `hello_world` if no custom template is set.
 *
 *  Custom template body should have up to 3 params:
 *    {{1}} = business name, {{2}} = caller + duration, {{3}} = summary */
export async function callSummaryWhatsApp(opts: {
  to: string;
  callerName: string;
  callerNumber?: string;
  summary?: string;
  businessName?: string;
  durationSec?: number;
  /** Public "More info" conversation link. When set it's appended to the message
   *  (and to the template's summary param) so the owner can open the full call. */
  conversationUrl?: string;
}): Promise<void> {
  const templateName = getEffective("whatsapp.callTemplate", currentBrandId()).trim();
  const who = opts.businessName?.trim() || "Your AI receptionist";
  const dur =
    typeof opts.durationSec === "number" && opts.durationSec > 0
      ? ` (${Math.floor(opts.durationSec / 60)}m ${opts.durationSec % 60}s)`
      : "";
  // Include the caller's number so the owner knows which line rang.
  const num = opts.callerNumber?.trim() ? ` (${opts.callerNumber.trim()})` : "";
  const callerLine = `${opts.callerName}${num}${dur}`;
  const summaryLine = opts.summary?.replace(/\s+/g, " ").trim() || "No summary available.";
  const link = opts.conversationUrl?.trim();

  if (templateName) {
    // Template params: {{1}} business, {{2}} caller, {{3}} summary, and — when the
    // link is enabled — {{4}} the conversation link. The template MUST declare a
    // {{4}} placeholder for this to pass (see whatsapp.callTemplate in Admin); when
    // the link is off we send the original 3 params.
    const params = link ? [who, callerLine, summaryLine, link] : [who, callerLine, summaryLine];
    await sendWhatsAppTemplate(opts.to, templateName, "en_US", params);
    return;
  }

  // No custom template configured — try freeform, fall back to hello_world.
  const linkLine = link ? `\nMore info: ${link}` : "";
  const text = `📞 *${who}*: new call from ${callerLine}.\n${summaryLine}${linkLine}`;
  try {
    await sendWhatsApp(opts.to, text.slice(0, 4096));
    console.log("[whatsapp] freeform summary delivered to", opts.to);
  } catch (err) {
    console.warn("[whatsapp] freeform failed, falling back to hello_world:", (err as Error).message);
    await sendWhatsAppTemplate(opts.to);
  }
}

