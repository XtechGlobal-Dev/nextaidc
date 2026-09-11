-- Lazy, cached translation of a call's transcript into the owner's report
-- language (see agentConfig automations.reportLanguage). Populated on first view;
-- transcriptTranslatedLang records which language it's stored in so a later
-- language change triggers a re-translation.
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "transcriptTranslated" JSONB;
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "transcriptTranslatedLang" TEXT;
