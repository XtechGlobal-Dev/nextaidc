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
import { upsertAssistant, buildAssistantPayload, buildVapiSystemPrompt, getCallRecording, getBookingToolConfig, getSmsInfoToolConfig } from "../services/vapi.js";
import { markVapiSyncPending, markVapiSynced } from "../services/vapiSync.js";
import {
  integrationsStatus,
  getPromptTemplate,
  getAgentDefaultNames,
  DEFAULT_AGENT_NAME_MALE,
  DEFAULT_AGENT_NAME_FEMALE,
} from "../services/settings.js";
import { isTwilioConfigured } from "../services/sms.js";
import { availableForBrand } from "../services/phones.js";
import { provisionAgentForUser, canProvisionForUser } from "../services/provisioning.js";
import {
  canSelectVoice,
  deepgramVoiceFor,
  resolveElevenLabsVoiceId,
  providerForVoiceId,
  voiceGenderResolved,
} from "../services/voices.js";
import { isAdminRole } from "../lib/roles.js";

const router = express.Router();

/** The business name the stored config was last saved with — the baseline a
 *  rename is propagated from, so onboarding-generated text that named the old
 *  business (scenarios, FAQs, facts) follows the rename instead of going stale. */
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

/** True when the assistant name is still an auto-generated default the owner
 *  never personalised — the seeded "Sophie", the "{Business} Receptionist"
 *  fallback, a gender-matched name we assigned earlier (so a later voice change
 *  can re-match it), or blank. Only then may a gender-matched name be picked. */
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

/** Rename a still-default assistant to match its voice's gender using the
 *  admin-configured names (male → "Mark", female → "Jessica" by default). Runs
 *  at onboarding AND on every AI-Brain save, so switching to a male voice flips
 *  an auto-assigned "Jessica" to "Mark" (and back). No-op when the owner chose
 *  their own name or the voice's gender is unknown. Mutates + returns the config. */
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

    // Auto-retry provisioning while the agent is incomplete: still pending (Vapi
    // wasn't configured at subscribe time), or live but without an assigned
    // number yet (e.g. the Twilio pool was empty / the import had failed).
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
    // Customers auto-provision here; the admin provisions only when they first
    // build + save their AI Brain (see the PUT handler), so simply opening the
    // page doesn't spin up an admin agent on the default config.
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
    // Resolve the operating timezone here rather than at each creation site: a
    // config can be seeded by signup, by getConversion above, or by the call
    // webhook, and legacy rows predate the field. Doing it on read means every
    // path ends up with a real zone, and it doesn't depend on the owner opening
    // the Rules tab. A stored value (incl. a normalised legacy label) is kept as
    // the owner's choice and never overwritten.
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
    // Give a still-default assistant its gender-matched admin default name
    // ("Jessica"/"Mark") on READ, not just on save. Onboarding seeds the name as
    // "{business} Receptionist"; without this the first AI-Brain load showed that
    // placeholder and only flipped to the real name a few seconds later when the
    // post-onboarding save applied it. Applying it here makes the first render
    // correct. Idempotent — a name the owner personalised (or already a default
    // gender name) is left unchanged.
    const nameBefore = (agentConfig as AgentConfig).identity?.assistantName;
    await applyGenderDefaultName(agentConfig as unknown as AgentConfig);
    const nameChanged = (agentConfig as AgentConfig).identity?.assistantName !== nameBefore;
    // Persist a newly-resolved zone or name so the prompt synced to Vapi matches
    // what the owner is shown — otherwise the live agent keeps compiling with the
    // old value until their next manual save.
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

/**
 * Make the master prompt SERVER-OWNED: discard whatever the client sent for it
 * and restore the stored values in its place.
 *
 * The prompt is the product — it is what makes the assistant work — so a
 * customer may read it but never rewrite it. A read-only textarea alone is
 * decoration: the config travels to the browser and comes back on a plain PUT,
 * so deleting the attribute in devtools, editing the store from the console, or
 * simply POSTing the JSON with curl would all have saved a hand-written prompt.
 * Refusing it HERE is the only version of this rule that holds, for the same
 * reason the voice and language gates a few lines below live on the server.
 *
 * It restores the STORED prompt rather than recompiling from scratch on
 * purpose. Customers who hand-edited before this rule existed have
 * `masterPromptDirty` set, and forcing a recompile would silently delete
 * guidance their live agent has been running on for months. Their text is
 * frozen exactly as it is; they simply can't add to it. Everyone else stays on
 * the auto-compiled path, so editing Identity, Knowledge or Rules still flows
 * into the prompt exactly as before — that is now the only way to change it.
 *
 * Admins are exempt, including while impersonating (`imp`, minted only by the
 * ADMIN-only impersonate route), so support can still repair a broken prompt
 * for a customer who asks.
 */
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

    // Defence-in-depth: clamp names to 40 so the stored config (and the Vapi
    // assistant built from it) can never overflow Vapi's 40-char name limit,
    // even if a client bypasses the input cap.
    if (config.identity) {
      config.identity.assistantName = clampName(config.identity.assistantName);
      config.identity.businessName = clampName(config.identity.businessName);
      // The greeting stores the business name baked in, so renaming the business
      // used to leave the agent greeting callers with the OLD name on every live
      // call. Re-derive it here (only for greetings we generated — a custom one is
      // kept as-is) so the fix persists and flows into the prompt + Vapi payload.
      // Clamped for the same reason the names above are: the greeting is
      // owner-editable free text that lands in the master prompt and the Vapi
      // payload, so a client bypassing the input cap must not bloat every call.
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

    // Same reasoning as languages above, for "SMS to Caller": force the master
    // switch off when the plan doesn't include it. Deleting a `disabled`
    // attribute in the browser (or PUTting the config straight at this route)
    // would otherwise store it as ON — which the UI would then show as active
    // even though the send path refuses it.
    if (config.automations && !(await getPlanFeatures(req.user!.sub)).smsToCaller) {
      config.automations.clientPostCallSms = false;
    }

    // Voice picked/changed on save: re-match a still-default assistant name
    // (Jessica/Mark or the admin overrides) to the voice's gender. Runs before
    // the prompt compile so the new name flows into the ## IDENTITY block.
    await applyGenderDefaultName(config);

    // Fetch profile context for location/industry-aware prompt compilation.
    const compileCtx = await getCompileContext(req.user!.sub);

    const conversion = await getConversion(req.user!.sub);

    // Before the rename, so a business rename still propagates into a frozen
    // hand-edited prompt (renameBusinessInConfig only rewrites a dirty one).
    lockMasterPrompt(config, conversion, req.user!);

    // Renaming the business must carry through the text that baked the old name
    // in — the onboarding-generated scenarios/FAQs/facts ("existing customer of
    // Acme") kept naming the previous business on every live call. The DB holds
    // the name this config was last saved under, which is the reliable baseline
    // (the client may have renamed across several edits). Runs before the prompt
    // compile so the corrected text flows into the prompt and the Vapi payload.
    config = renameBusinessInConfig(config, storedBusinessName(conversion), config.identity?.businessName);

    // Use the conversion's frozen template snapshot (or the current global one for
    // brand-new conversions that haven't been snapshotted yet).
    const effectiveTemplate = conversion.promptTemplateSnapshot ?? getPromptTemplate();

    // When the prompt hasn't been manually edited, keep it auto-compiled from the
    // structured config. Manual edits are no longer length-capped — the owner can
    // write as much custom guidance as they like.
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

    // Voice Bank gate: a user may only switch *to* a voice their plan's category
    // includes (the default voice is always allowed). Trial / no-category plans keep
    // the picker locked client-side; this guards an API bypass. A voice they already
    // have (unchanged id) is grandfathered in so a save without a voice change works.
    if (config.identity.voiceId !== prevVoiceId) {
      if (!(await canSelectVoice(req.user!.sub, config.identity.voiceId))) {
        throw badRequest("This voice isn't available on your current plan.");
      }
    }

    // Whether this agent is still missing a live assistant or a number. The admin
    // (who never onboarded) lands here on their first save, so saving the AI Brain
    // doubles as their onboarding: create the assistant + draw a pool number.
    const profile = await (await requestTenant(req)).profile.findUnique({
      where: { userId: req.user!.sub },
      select: { receptionistNumber: true, mobile: true },
    });

    // Backfill the customer's country for the regional style when onboarding
    // never captured it (legacy configs, admins who skip the number step) —
    // derive it from their AI number, else their own mobile. Explicit onboarding
    // selection always wins; this only fills a blank.
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

    // Admin self-provisioning guard. The admin's first AI-Brain save draws a pool
    // number for the new assistant. Block the save until Twilio is configured AND
    // an AVAILABLE pool number exists — otherwise we'd create/update a live Vapi
    // assistant with no number behind it (an orphan that can't receive calls).
    // Only gates the admin while still incomplete (no number yet); once they have
    // a number, later saves just update the assistant and pass through.
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

    // The business name lives in two places — the agent config (AI Brain) and the
    // account Profile (Settings / header). Editing it in the AI Brain used to leave
    // the profile showing the old name, so mirror the change across on save. Only
    // when it's actually set, so a blank AI-Brain field never wipes the profile.
    const newBusinessName = config.identity.businessName?.trim();
    if (newBusinessName) {
      await (await requestTenant(req)).profile
        .updateMany({ where: { userId: req.user!.sub }, data: { businessName: newBusinessName } })
        .catch(() => {});
    }

    // Auto-deploy to Vapi so the live assistant always matches the saved config.
    // Best-effort: a Vapi outage must never block saving the config, but surface
    // why the live push failed so the user can retry instead of assuming it synced.
    let vapiAssistantId = conversion.vapiAssistantId;
    let synced = false;
    let syncError: string | undefined;
    // Whether the scheduler will finish the job (see services/vapiSync.ts). Only
    // true when there IS a live assistant now running the previous config — that's
    // the case where doing nothing would leave callers silently out of date.
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
        // A failed FIRST provision leaves no live agent, so nothing is stale and
        // there is nothing to converge on — the account simply isn't live yet, and
        // the response says so. Only queue a retry for an existing assistant.
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

// Persist the agent config without touching Vapi — used by the guided onboarding
// finish step to save the services/FAQs/facts it collected straight to the DB, so
// they're there when the AI Brain first hydrates. Provisioning + the live deploy
// happen later (on subscribe / a real Save), so this stays a pure DB write.
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
      // The greeting stores the business name baked in, so renaming the business
      // used to leave the agent greeting callers with the OLD name on every live
      // call. Re-derive it here (only for greetings we generated — a custom one is
      // kept as-is) so the fix persists and flows into the prompt + Vapi payload.
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
    // Give a still-default assistant a gender-matched name that suits its picked
    // voice (admin-configurable). Runs before the prompt is compiled so the new
    // name flows into the ## IDENTITY block.
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
    // If a live assistant already exists, push this config to it too — otherwise
    // content collected here (onboarding FAQs/scenarios) sits in the DB while the
    // live agent keeps answering with its old prompt until a manual Save. Best-
    // effort: a Vapi outage must never fail the persist itself.
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
        // This endpoint has no UI to report a failure to (onboarding just moves on),
        // so the retry queue is the only thing standing between an outage here and
        // an agent permanently missing the FAQs onboarding just collected.
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
    // Pushes the config to Vapi, CREATING the assistant when there isn't one yet
    // — so it has to respect the same entitlement rule as provisionAgentForUser
    // rather than provisioning any authenticated account that calls it.
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
      // This one reports the failure to the caller, but an explicit "make it live"
      // that dies on an outage should still be finished for them in the background
      // rather than needing a second manual attempt.
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
    // The browser places this call itself with the public Vapi key, so this
    // payload IS the authorisation — once handed over, the server is no longer in
    // the call path and can't stop anything. A blocked entitlement therefore has
    // to be refused outright rather than merely capped: getCallDurationCap below
    // would still return a working (10-second) assistant, and nothing forces the
    // client to report the call back for metering.
    //
    // Deliberately not the validateTrial middleware — that calls
    // reconcileSubscription on every request (a Stripe round-trip), and parallel
    // reconciles have already caused a double-charge once.
    if (!isAdminRole(req.user!.role)) {
      const ent = await getEntitlement(req.user!.sub);
      if (ent.blocked) {
        const { code, message } = entitlementError(ent);
        res.status(403).json({ success: false, code, message });
        return;
      }
    }
    // Compile from the caller's CURRENT AI Brain draft when the client sends it,
    // so a test call still reflects unsaved edits (what the old client-side build
    // did). Never persisted — it only shapes this one-off test payload. Falls back
    // to the stored config when absent or obviously not an AgentConfig.
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
        // A web test call runs on an INLINE assistant, so whatever ships in this
        // payload is the whole config — including the per-call ceiling. Stamped
        // here so the browser is handed a capped assistant rather than being
        // trusted to impose the cap on itself.
        maxDurationSeconds: await getCallDurationCap(req.user!.sub),
      }),
    });
  }),
);

export default router;
