import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requestTenant, tenantForUser } from "../services/tenantDb.js";
import { asyncHandler, badRequest } from "../lib/http.js";
import { requireAuth, requireCustomerAccount } from "../middleware/auth.js";
import {
  compileMasterPrompt,
  DEFAULT_AGENT_CONFIG,
  normalizeAutomations,
  clampName,
  clampGreeting,
  resolveGreeting,
  renameBusinessInConfig,
  sanitizeAgentLanguages,
  type AgentConfig,
  type CompileContext,
} from "../lib/agentConfig.js";
import { normalizeCountry } from "../lib/countryStyles.js";
import { isoCountryForPhone, normalizeTimeZone, resolveBusinessTimeZone } from "../lib/phoneTimeZone.js";
import { getPlanFeatures, getCallDurationCap, getEntitlement, entitlementError } from "../services/trial.js";
import {
  upsertAssistant,
  buildAssistantPayload,
  buildLiveAssistantPayload,
  buildVapiSystemPrompt,
  getCallRecording,
  getBookingToolConfig,
  getSmsInfoToolConfig,
  ensureVapiPhoneNumberId,
  createOutboundCall,
  getCallStatus,
  endVapiCall,
} from "../services/vapi.js";
import { markVapiSyncPending, markVapiSynced } from "../services/vapiSync.js";
import {
  integrationsStatus,
  getPromptTemplate,
  getAgentDefaultNames,
  DEFAULT_AGENT_NAME_MALE,
  DEFAULT_AGENT_NAME_FEMALE,
} from "../services/settings.js";
import { isTwilioConfigured } from "../services/sms.js";
import { availableForBrand, resolveOutboundCallerId } from "../services/phones.js";
import { provisionAgentForUser, canProvisionForUser } from "../services/provisioning.js";
import {
  canSelectVoice,
  deepgramVoiceFor,
  resolveElevenLabsVoiceId,
  providerForVoiceId,
  voiceGenderResolved,
} from "../services/voices.js";
import { isAdminRole } from "../lib/roles.js";
import { draftDiffersFromSaved } from "../lib/agentDraft.js";

const router = express.Router();

/** Business name the config was last saved with — the baseline a rename propagates from. */
function storedBusinessName(conversion: { agentConfig: unknown }): string {
  const identity = (conversion.agentConfig as { identity?: { businessName?: string } })?.identity;
  return (identity?.businessName ?? "").trim();
}

/** Find the authenticated user's Conversion (agent record), creating it if missing. */
async function getConversion(userId: string) {
  const existing = await (await tenantForUser(userId)).conversion.findUnique({ where: { userId } });
  if (existing) return existing;
  return (await tenantForUser(userId)).conversion.create({
    data: {
      userId,
      agentConfig: DEFAULT_AGENT_CONFIG as object,
      promptTemplateSnapshot: getPromptTemplate() || null,
    },
  });
}

/** True when the name is still an auto default (seeded, "{Business} Receptionist", a gender name we assigned, or blank) — only then may we re-pick it. */
function isDefaultAssistantName(name: string | undefined, businessName: string | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (n === DEFAULT_AGENT_CONFIG.identity.assistantName) return true; // seeded "Sophie"
  const names = getAgentDefaultNames();
  if ([names.male, names.female, DEFAULT_AGENT_NAME_MALE, DEFAULT_AGENT_NAME_FEMALE].includes(n)) {
    return true; // auto-assigned gender name (current admin override or built-in)
  }
  const biz = (businessName ?? "").trim();
  return Boolean(biz) && n === clampName(`${biz} Receptionist`);
} 

/** Fetch the owner's country/industry from their profile for prompt compilation. */
async function getCompileContext(userId: string): Promise<CompileContext> {
  const p = await (await tenantForUser(userId)).profile.findUnique({
    where: { userId },
    select: { country: true, industry: true },
  });
  return { country: p?.country || undefined, industry: p?.industry || undefined };
}

/** Renames a still-default assistant to match its voice's gender (admin-configured names). No-op for an owner-chosen name or unknown gender. Mutates + returns config. */
async function applyGenderDefaultName(config: AgentConfig): Promise<AgentConfig> {
  if (!config.identity) return config;
  if (!isDefaultAssistantName(config.identity.assistantName, config.identity.businessName)) return config;
  const gender = await voiceGenderResolved(config.identity.voiceId);
  if (!gender) return config;
  const names = getAgentDefaultNames();
  config.identity.assistantName = clampName(gender === "male" ? names.male : names.female);
  return config;
}

router.get(
  "/",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    let conversion = await getConversion(req.user!.sub);

    // Retry provisioning while incomplete: still pending, or live with no number yet (pool was empty).
    const profile = await (await requestTenant(req)).profile.findUnique({
      where: { userId: req.user!.sub },
      select: {
        receptionistNumber: true,
        businessNumber: true,
        mobile: true,
        address: true,
        timezone: true,
      },
    });
    const incomplete =
      conversion.status === "pending" ||
      (conversion.status === "approved" && !profile?.receptionistNumber);
    // Admins only provision on their first AI Brain save, so opening the page doesn't spin up an agent on the default config.
    if (incomplete && !isAdminRole(req.user!.role)) {
      const provisioned = await provisionAgentForUser(req.user!.sub);
      if (provisioned) conversion = await getConversion(req.user!.sub);
    }

    // Normalize automations so summary channels are on-by-default for legacy
    // configs (pre-feature). Plan + per-channel gating still applies downstream.
    const stored = conversion.agentConfig as {
      automations?: unknown;
      rules?: { timezone?: string };
    };
    // Resolve the timezone on read: configs are seeded from several places and legacy rows predate
    // the field. A stored value is the owner's choice and is never overwritten.
    const resolvedZone =
      normalizeTimeZone(stored.rules?.timezone) ||
      resolveBusinessTimeZone({
        receptionistNumber: profile?.receptionistNumber,
        businessNumber: profile?.businessNumber,
        mobile: profile?.mobile,
        address: profile?.address,
        browserTimeZone: profile?.timezone,
      });
    const agentConfig = {
      ...(stored as object),
      rules: { ...(stored.rules ?? {}), timezone: resolvedZone },
      automations: normalizeAutomations(stored.automations),
    };
    // Apply the gender default name on READ too, or the first AI Brain load shows the
    // "{business} Receptionist" placeholder until the post-onboarding save. Idempotent.
    const nameBefore = (agentConfig as AgentConfig).identity?.assistantName;
    await applyGenderDefaultName(agentConfig as unknown as AgentConfig);
    const nameChanged = (agentConfig as AgentConfig).identity?.assistantName !== nameBefore;
    // Persist a newly resolved zone/name, or the live agent keeps the old value until the next manual save.
    if (normalizeTimeZone(stored.rules?.timezone) !== resolvedZone || nameChanged) {
      await (await requestTenant(req)).conversion.update({
        where: { id: conversion.id },
        data: { agentConfig: agentConfig as object },
      });
    }

    // Use the conversion's frozen template snapshot if available; fall back to the
    // current global template for legacy conversions that haven't been snapshotted.
    const effectiveTempl = conversion.promptTemplateSnapshot ?? getPromptTemplate();
    const currentGlobal = getPromptTemplate();
    // The snapshot matches the latest global template (or both are empty/default).
    const promptTemplateIsLatest =
      (conversion.promptTemplateSnapshot ?? null) === null || conversion.promptTemplateSnapshot === currentGlobal;

    res.json({
      agentConfig,
      vapiAssistantId: conversion.vapiAssistantId,
      status: conversion.status, // pending | approved
      lastSyncedAt: conversion.updatedAt,
      promptTemplate: effectiveTempl,
      promptTemplateIsLatest,
    });
  }),
);

/** Recording URL for a finished Vapi call (web test calls fetch it post-call). */
router.get(
  "/call-recording/:callId",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const recordingUrl = await getCallRecording(req.params.callId).catch(() => null);
    res.json({ recordingUrl });
  }),
);

const putSchema = z.object({ agentConfig: z.any() });

/** Master prompt is server-owned: drop whatever the client sent and restore the STORED values (a read-only textarea
 *  is bypassable with curl). Restores rather than recompiles so pre-rule hand edits (masterPromptDirty) aren't wiped.
 *  Admins are exempt, including while impersonating, so support can repair a broken prompt. */
export function lockMasterPrompt(
  config: AgentConfig,
  conversion: { agentConfig: unknown },
  user: { role: string; imp?: boolean },
): void {
  if (user.role !== "USER" || user.imp) return;
  const stored = (
    conversion.agentConfig as {
      advanced?: { masterPrompt?: string; masterPromptDirty?: boolean };
    } | null
  )?.advanced;
  config.advanced.masterPromptDirty = stored?.masterPromptDirty ?? false;
  config.advanced.masterPrompt = stored?.masterPrompt ?? "";
}

router.put(
  "/",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { agentConfig } = putSchema.parse(req.body);
    let config = agentConfig as AgentConfig;

    // Clamp names server-side too — Vapi has a 40-char name limit and a client can bypass the input cap.
    if (config.identity) {
      config.identity.assistantName = clampName(config.identity.assistantName);
      config.identity.businessName = clampName(config.identity.businessName);
      // The greeting bakes the business name in, so re-derive generated greetings on rename (custom ones are kept).
      // Clamped like the names: it lands in every call's prompt, so a client bypass must not bloat it.
      config.identity.greetingMessage = clampGreeting(
        resolveGreeting(config.identity.greetingMessage, config.identity.businessName),
      );
      // Languages are a multilingual-plan entitlement — strip them on other
      // plans so an API bypass can't smuggle them into the prompt.
      config.identity.languages = (await getPlanFeatures(req.user!.sub)).multilingual
        ? sanitizeAgentLanguages(
            config.identity.languages,
            providerForVoiceId(config.identity.voiceId),
          )
        : [];
    }

    // Same for "SMS to Caller": force it off when the plan lacks it, or a devtools bypass
    // stores ON and the UI shows it active even though the send path refuses.
    if (config.automations && !(await getPlanFeatures(req.user!.sub)).smsToCaller) {
      config.automations.clientPostCallSms = false;
    }

    // Re-match a still-default name to the voice's gender. Before the compile so it reaches the ## IDENTITY block.
    await applyGenderDefaultName(config);

    // Fetch profile context for location/industry-aware prompt compilation.
    const compileCtx = await getCompileContext(req.user!.sub);

    const conversion = await getConversion(req.user!.sub);

    // Before the rename, so a business rename still propagates into a frozen
    // hand-edited prompt (renameBusinessInConfig only rewrites a dirty one).
    lockMasterPrompt(config, conversion, req.user!);

    // Carry a rename through onboarding-generated text that baked the old name in. The DB name is the
    // baseline (the client may have renamed across several edits). Before the compile so the prompt gets it.
    config = renameBusinessInConfig(config, storedBusinessName(conversion), config.identity?.businessName);

    // Use the conversion's frozen template snapshot (or the current global one for
    // brand-new conversions that haven't been snapshotted yet).
    const effectiveTemplate = conversion.promptTemplateSnapshot ?? getPromptTemplate();

    // Auto-compile unless hand-edited. Manual edits are deliberately not length-capped.
    if (!config.advanced.masterPromptDirty) {
      config.advanced.masterPrompt = compileMasterPrompt(config, effectiveTemplate, compileCtx);
    }

    // Normalise + validate the voiceId against its own provider (decided by the id)
    // so stored configs self-heal and the Vapi payload / TTS always see a real id.
    const prevVoiceId = (conversion.agentConfig as { identity?: { voiceId?: string } })?.identity
      ?.voiceId;
    config.identity.voiceId =
      providerForVoiceId(config.identity.voiceId) === "elevenlabs"
        ? await resolveElevenLabsVoiceId(config.identity.voiceId)
        : deepgramVoiceFor(config.identity.voiceId);

    // Voice Bank gate against API bypass: only switching TO a voice is checked, so an
    // unchanged (grandfathered) voice never blocks a save.
    if (config.identity.voiceId !== prevVoiceId) {
      if (!(await canSelectVoice(req.user!.sub, config.identity.voiceId))) {
        throw badRequest("This voice isn't available on your current plan.");
      }
    }

    // Still missing an assistant or number? For the admin (never onboarded) this save doubles as onboarding.
    const profile = await (await requestTenant(req)).profile.findUnique({
      where: { userId: req.user!.sub },
      select: { receptionistNumber: true, mobile: true },
    });

    // Backfill a blank country from the AI number, else their mobile. An explicit choice always wins.
    if (!normalizeCountry(config.identity.country)) {
      const iso = isoCountryForPhone(profile?.receptionistNumber) || isoCountryForPhone(profile?.mobile);
      if (iso) config.identity.country = iso;
    }

    // For admins, a real number means a pool row (their seeded placeholder
    // receptionistNumber doesn't count); customers use the mirrored profile field.
    const isAdmin = isAdminRole(req.user!.role);
    const ownedNumber = isAdmin
      ? await prisma.phoneNumber.findFirst({ where: { userId: req.user!.sub }, select: { id: true } })
      : null;
    const hasNumber = isAdmin ? Boolean(ownedNumber) : Boolean(profile?.receptionistNumber);
    const incomplete =
      conversion.status !== "approved" || !conversion.vapiAssistantId || !hasNumber;

    // Admin's first save draws a pool number, so block it until Twilio is configured and a
    // number is available — otherwise we'd create an orphan assistant that can't take calls.
    if (isAdmin && incomplete) {
      if (!isTwilioConfigured()) {
        throw badRequest(
          "Configure Twilio in Admin → Settings before saving your AI Brain — your assistant needs a phone number to go live.",
        );
      }
      // Counted with the same rule allocation uses, or a customer could clear
      // this check on inventory that is not theirs to take.
      const available = await prisma.phoneNumber.count({
        where: availableForBrand(req.user!.brandId),
      });
      if (available === 0) {
        throw badRequest(
          "No available phone number in the pool. Add or import one in Admin → Phone Numbers before saving your AI Brain.",
        );
      }
    }

    const updated = await (await requestTenant(req)).conversion.update({
      where: { id: conversion.id },
      data: {
        agentConfig: config as object,
        dataCaptureFields: config.knowledge.captureFields as object,
      },
    });

    // Mirror the business name to the Profile (it used to go stale there). Only when set, so a blank never wipes it.
    const newBusinessName = config.identity.businessName?.trim();
    if (newBusinessName) {
      await (await requestTenant(req)).profile
        .updateMany({ where: { userId: req.user!.sub }, data: { businessName: newBusinessName } })
        .catch(() => {});
    }

    // Best-effort Vapi push: an outage must never block the save, but report why it failed.
    let vapiAssistantId = conversion.vapiAssistantId;
    let synced = false;
    let syncError: string | undefined;
    // True only when a live assistant is now running the stale config (see services/vapiSync.ts).
    let syncQueued = false;
    if (integrationsStatus().vapi) {
      try {
        if (incomplete) {
          // First-time provision (creates the assistant + assigns a number).
          await provisionAgentForUser(req.user!.sub);
        } else {
          const id = await upsertAssistant(config, conversion.vapiAssistantId, {
            ownerId: req.user!.sub,
          });
          if (id && id !== conversion.vapiAssistantId) {
            await (await requestTenant(req)).conversion.update({
              where: { id: conversion.id },
              data: { vapiAssistantId: id },
            });
          }
          vapiAssistantId = id;
        }
        synced = true;
        // Clears anything an earlier failed save queued — this push superseded it.
        await markVapiSynced(await requestTenant(req), conversion.id);
      } catch (e) {
        syncError = e instanceof Error ? e.message : "Vapi sync failed";
        console.error(`[agent] Vapi sync failed for user ${req.user!.sub}:`, syncError);
        // Only queue a retry for an existing assistant — a failed first provision leaves nothing stale.
        if (conversion.vapiAssistantId) {
          await markVapiSyncPending(await requestTenant(req), conversion.id, e);
          syncQueued = true;
        }
      }
    } else {
      syncError = "Vapi is not configured";
    }

    // Re-read so the response reflects provisioning (fresh assistant id + status).
    const fresh = await (await requestTenant(req)).conversion.findUnique({
      where: { id: conversion.id },
      select: { vapiAssistantId: true, status: true, updatedAt: true },
    });

    res.json({
      agentConfig: updated.agentConfig,
      lastSyncedAt: fresh?.updatedAt ?? updated.updatedAt,
      vapiAssistantId: fresh?.vapiAssistantId ?? vapiAssistantId,
      status: fresh?.status ?? conversion.status,
      synced,
      ...(syncError ? { syncError } : {}),
      ...(syncQueued ? { syncQueued } : {}),
    });
  }),
);

// Save the config without provisioning (onboarding finish step). Provisioning happens on subscribe / a real Save.
router.post(
  "/persist",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { agentConfig } = putSchema.parse(req.body);
    let config = agentConfig as AgentConfig;
    if (config.identity) {
      config.identity.assistantName = clampName(config.identity.assistantName);
      config.identity.businessName = clampName(config.identity.businessName);
      // The greeting bakes the business name in, so re-derive generated greetings on rename (custom ones are kept).
      config.identity.greetingMessage = resolveGreeting(
        config.identity.greetingMessage,
        config.identity.businessName,
      );
      config.identity.languages = (await getPlanFeatures(req.user!.sub)).multilingual
        ? sanitizeAgentLanguages(
            config.identity.languages,
            providerForVoiceId(config.identity.voiceId),
          )
        : [];
    }
    // Gender-matched default name, before the compile so it reaches the ## IDENTITY block.
    await applyGenderDefaultName(config);
    const compileCtxPersist = await getCompileContext(req.user!.sub);
    const conversionPersist = await getConversion(req.user!.sub);
    // Same lock as the PUT: this route writes the same config from the same
    // client, so leaving it open would just move the bypass one endpoint along.
    lockMasterPrompt(config, conversionPersist, req.user!);
    // Same rename propagation as the PUT — text generated against the previous
    // business name follows the rename instead of going stale.
    config = renameBusinessInConfig(
      config,
      storedBusinessName(conversionPersist),
      config.identity?.businessName,
    );
    const effectiveTemplatePersist = conversionPersist.promptTemplateSnapshot ?? getPromptTemplate();
    if (!config.advanced.masterPromptDirty) {
      config.advanced.masterPrompt = compileMasterPrompt(config, effectiveTemplatePersist, compileCtxPersist);
    }
    const conversion = conversionPersist;
    const updated = await (await requestTenant(req)).conversion.update({
      where: { id: conversion.id },
      data: {
        agentConfig: config as object,
        dataCaptureFields: config.knowledge.captureFields as object,
      },
    });
    // Push to an existing live assistant too, or it keeps its old prompt until a manual Save. Best-effort.
    if (conversion.vapiAssistantId && integrationsStatus().vapi) {
      try {
        const id = await upsertAssistant(config, conversion.vapiAssistantId);
        if (id && id !== conversion.vapiAssistantId) {
          await (await requestTenant(req)).conversion.update({
            where: { id: conversion.id },
            data: { vapiAssistantId: id },
          });
        }
        await markVapiSynced(await requestTenant(req), conversion.id);
      } catch (e) {
        console.error(
          `[agent] persist: Vapi sync failed for user ${req.user!.sub}:`,
          e instanceof Error ? e.message : e,
        );
        // No UI to report to here (onboarding moves on), so the retry queue is the only safety net.
        await markVapiSyncPending(await requestTenant(req), conversion.id, e);
      }
    }
    res.json({ agentConfig: updated.agentConfig, lastSyncedAt: updated.updatedAt });
  }),
);

router.post(
  "/adopt-latest-template",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const latestTemplate = getPromptTemplate();
    const conversion = await getConversion(req.user!.sub);
    const config = conversion.agentConfig as unknown as AgentConfig;

    // Update the snapshot to the latest global template.
    await (await requestTenant(req)).conversion.update({
      where: { id: conversion.id },
      data: { promptTemplateSnapshot: latestTemplate || null },
    });

    // If the prompt is auto-compiled, recompile with the new template.
    if (!config.advanced.masterPromptDirty) {
      const ctx = await getCompileContext(req.user!.sub);
      config.advanced.masterPrompt = compileMasterPrompt(config, latestTemplate, ctx);
      await (await requestTenant(req)).conversion.update({
        where: { id: conversion.id },
        data: { agentConfig: config as object },
      });

      // Best-effort sync to Vapi.
      if (conversion.vapiAssistantId && integrationsStatus().vapi) {
        try {
          await upsertAssistant(config, conversion.vapiAssistantId, { ownerId: req.user!.sub });
          await markVapiSynced(await requestTenant(req), conversion.id);
        } catch (e) {
          console.error(`[agent] adopt-latest Vapi sync failed:`, e instanceof Error ? e.message : e);
          await markVapiSyncPending(await requestTenant(req), conversion.id, e);
        }
      }
    }

    res.json({
      agentConfig: config,
      promptTemplate: latestTemplate,
      promptTemplateIsLatest: true,
    });
  }),
);

router.post(
  "/sync",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    // This CREATES the assistant when missing, so it must follow the same entitlement rule as provisionAgentForUser.
    if (!(await canProvisionForUser(req.user!.sub, req.user!.role)))
      throw badRequest("Your AI assistant goes live once you choose a plan.");
    const conversion = await getConversion(req.user!.sub);
    let id: string;
    try {
      id = await upsertAssistant(
        conversion.agentConfig as unknown as AgentConfig,
        conversion.vapiAssistantId,
        { ownerId: req.user!.sub },
      );
    } catch (e) {
      // Reports the failure, but still queue a retry so an outage doesn't need a second manual attempt.
      if (conversion.vapiAssistantId) await markVapiSyncPending(await requestTenant(req), conversion.id, e);
      throw e;
    }
    await (await requestTenant(req)).conversion.update({
      where: { id: conversion.id },
      data: { vapiAssistantId: id },
    });
    await markVapiSynced(await requestTenant(req), conversion.id);
    res.json({ vapiAssistantId: id });
  }),
);

router.post(
  "/test-token",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const conversion = await getConversion(req.user!.sub);
    // This payload IS the authorisation (the browser places the call itself), so a blocked entitlement
    // must be refused outright, not capped. Not validateTrial: its per-request reconcileSubscription
    // is a Stripe round-trip and parallel reconciles once double-charged.
    if (!isAdminRole(req.user!.role)) {
      const ent = await getEntitlement(req.user!.sub);
      if (ent.blocked) {
        const { code, message } = entitlementError(ent);
        res.status(403).json({ success: false, code, message });
        return;
      }
    }
    // Use the unsaved AI Brain draft when sent so a test call reflects it. Never persisted.
    const draft = (req.body as { agentConfig?: AgentConfig } | undefined)?.agentConfig;
    const config = (
      draft?.identity && draft?.advanced && draft?.knowledge && draft?.rules
        ? draft
        : conversion.agentConfig
    ) as unknown as AgentConfig;
    // Same compressed wire prompt (+ regional style) as the live assistant, so a
    // web test call behaves exactly like a real inbound call.
    const systemPrompt = await buildVapiSystemPrompt(config, req.user!.sub);
    // Mirror the live assistant's website-first booking behaviour + tools so a web
    // test call behaves exactly like a real inbound call.
    const booking = await getBookingToolConfig(req.user!.sub);
    // Same for "Text Info to Callers" — a test call really does text, so the owner
    // can check their own templates land before a customer ever hears the offer.
    const infoSms = await getSmsInfoToolConfig(req.user!.sub);
    res.json({
      publicKeyConfigured: integrationsStatus().vapi,
      assistant: buildAssistantPayload(config, {
        systemPrompt,
        booking,
        infoSms,
        // Inline assistant: this payload is the whole config, so stamp the cap here rather than trusting the browser.
        maxDurationSeconds: await getCallDurationCap(req.user!.sub),
      }),
    });
  }),
);


/* ------------------------- Outbound test call ------------------------- */

/** Strip a typed number down to E.164. Vapi rejects anything else outright. */
function toE164(raw: string): string {
  const trimmed = (raw ?? "").trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  // A leading "+" or "00" both mean "already international".
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return `+${digits}`;
}

/** Ring the customer on a real phone with their own agent.
 *
 *  Two things are resolved independently and must not be confused:
 *   - WHICH AGENT answers is always this customer's own assistant (their
 *     knowledge, prompt, voice and tools), whoever owns the line.
 *   - WHICH NUMBER it calls from is their own number if they hold one, else
 *     their brand's caller ID, else the platform's — see resolveOutboundCallerId.
 *
 *  `assistantId` + `assistantOverrides` (rather than a transient assistant) is
 *  what lets the end-of-call webhook find the owner and log the call, bill the
 *  minutes and send the summary, exactly as a real inbound call does — while an
 *  unsaved AI-Brain draft is still heard on this one call. */
router.post(
  "/test-call",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { toNumber, agentConfig: draft } = z
      .object({ toNumber: z.string(), agentConfig: z.any().optional() })
      .parse(req.body);

    const to = toE164(toNumber);
    if (!/^\+\d{7,15}$/.test(to))
      throw badRequest("Enter the number to call in full international format, e.g. +61412345678.");

    // Everything the call needs that doesn't depend on anything else, at once.
    // Run in sequence these were four round-trips of dead air before dialling.
    const [ent, from, conversion, maxDurationSeconds] = await Promise.all([
      isAdminRole(req.user!.role) ? Promise.resolve(null) : getEntitlement(req.user!.sub),
      resolveOutboundCallerId(req.user!.sub),
      getConversion(req.user!.sub),
      getCallDurationCap(req.user!.sub),
    ]);

    if (ent?.blocked) {
      const { code, message } = entitlementError(ent);
      res.status(403).json({ success: false, code, message });
      return;
    }
    if (!from)
      throw badRequest(
        "Test calls aren't available yet — no outbound number is set up. Ask your administrator to set an outbound caller ID, or activate your own number.",
      );
    if (toE164(from.number) === to)
      throw badRequest("That's the number the call is placed from — enter the phone you want us to ring.");

    // Resolving the caller ID's Vapi id is pure I/O that depends on nothing below,
    // so start it now and collect it just before dialling.
    const phoneNumberIdPromise = ensureVapiPhoneNumberId(from.number);
    // Never leave it unhandled while the assistant work runs, or a Vapi hiccup
    // becomes an unhandled rejection instead of this route's error.
    phoneNumberIdPromise.catch(() => {});

    let assistantId = conversion.vapiAssistantId;
    if (!assistantId) {
      // First call on this account only: there is no live agent to dial with yet.
      // Gated exactly as /assistant is — an unentitled account gets none.
      if (!(await canProvisionForUser(req.user!.sub, req.user!.role)))
        throw badRequest("Your AI assistant goes live once you choose a plan.");
      assistantId = await upsertAssistant(
        conversion.agentConfig as unknown as AgentConfig,
        null,
        { ownerId: req.user!.sub, maxDurationSeconds },
      );
      await (await requestTenant(req)).conversion.update({
        where: { id: conversion.id },
        data: { vapiAssistantId: assistantId },
      });
    }

    // THE fast path. The saved assistant already runs this exact payload — every
    // change that affects it (agent save, booking, transfer, profile, plan) pushes
    // a fresh one and `vapiSyncPendingAt` flags any push that failed. So unless the
    // caller is testing an UNSAVED draft, rebuilding it would re-summarise the
    // prompt through an LLM and re-read booking/transfer/SMS config for a result
    // byte-identical to what Vapi already holds — seconds of silence for nothing.
    const draftDiffers = draftDiffersFromSaved(draft, conversion.agentConfig);
    const assistantIsCurrent = !conversion.vapiSyncPendingAt;
    const needsOverrides = draftDiffers || !assistantIsCurrent;

    // The cap is the one thing the saved assistant CAN'T be trusted on: it is
    // stamped at provisioning time and minutes are spent after that. So it is sent
    // on every call, even on the fast path — a partial override costs nothing.
    const capOverride =
      typeof maxDurationSeconds === "number" && maxDurationSeconds > 0
        ? { maxDurationSeconds }
        : undefined;

    let assistantOverrides: Record<string, unknown> | undefined = capOverride;
    if (needsOverrides) {
      const config = (draftDiffers ? draft : conversion.agentConfig) as unknown as AgentConfig;
      const live = await buildLiveAssistantPayload(config, {
        ownerId: req.user!.sub,
        maxDurationSeconds,
      });
      // `name`, `server` and `metadata` belong to the saved assistant — overriding
      // them would detach the webhook or the owner stamp.
      const { name: _name, server: _server, metadata: _metadata, ...rest } = live;
      assistantOverrides = rest;
    }

    const businessName = (
      (draftDiffers ? draft : conversion.agentConfig) as { identity?: { businessName?: string } }
    )?.identity?.businessName?.trim();

    const call = await createOutboundCall({
      phoneNumberId: await phoneNumberIdPromise,
      toNumber: to,
      assistantId,
      assistantOverrides,
      // Second attribution path: a call whose assistant was deleted upstream can
      // still be traced back to its owner from the report.
      metadata: {
        userId: req.user!.sub,
        brandId: req.user!.brandId ?? "",
        testCall: "true",
        callerIdSource: from.source,
      },
      name: `Test call — ${businessName || req.user!.email}`,
    });

    res.json({
      callId: call.id,
      status: call.status,
      from: from.number,
      fromSource: from.source,
      to,
      maxDurationSeconds: maxDurationSeconds ?? null,
      /** False when the saved assistant was dialled as-is (the fast path). */
      usedDraft: needsOverrides,
    });
  }),
);

/** Everything the dialog can settle BEFORE the caller presses the button.
 *
 *  Called when the tester opens: it resolves the caller ID, warms the Vapi
 *  phone-number lookup, and — when an unsaved draft is being tested — pre-builds
 *  (and therefore caches) the compressed prompt that draft will run on. That last
 *  one is the difference between a click that dials and a click that waits on an
 *  LLM. Purely a warm-up: it places no call and changes nothing. */
router.post(
  "/test-call/preflight",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const draft = (req.body as { agentConfig?: unknown } | undefined)?.agentConfig;
    const [from, conversion] = await Promise.all([
      resolveOutboundCallerId(req.user!.sub),
      getConversion(req.user!.sub),
    ]);

    if (!from) {
      res.json({
        ready: false,
        reason:
          "No outbound number is set up yet. Ask your administrator to set an outbound caller ID, or activate your own number.",
        from: null,
        fromSource: null,
      });
      return;
    }

    const draftDiffers = draftDiffersFromSaved(draft, conversion.agentConfig);

    await Promise.all([
      ensureVapiPhoneNumberId(from.number).catch(() => {}),
      // Warms the prompt cache for the payload the call will build. Skipped on the
      // fast path, where no payload is built at all.
      draftDiffers || conversion.vapiSyncPendingAt
        ? buildLiveAssistantPayload(
            (draftDiffers ? draft : conversion.agentConfig) as unknown as AgentConfig,
            { ownerId: req.user!.sub },
          ).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    res.json({
      ready: true,
      reason: "",
      from: from.number,
      fromSource: from.source,
    });
  }),
);

/** Live status of a test call the caller placed, so the dialog can say "ringing"
 *  vs "answered" vs why it ended. Scoped by the Vapi call id, which the caller
 *  only learns from their own POST above. */
router.get(
  "/test-call/:callId",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    res.json(await getCallStatus(req.params.callId));
  }),
);

/** Hang up from the dashboard, for a caller who started the call and wants it stopped. */
router.post(
  "/test-call/:callId/end",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    await endVapiCall(req.params.callId);
    res.json({ ok: true });
  }),
);

export default router;
