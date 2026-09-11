-- Cache the owner-language translation of a call's summary alongside the
-- transcript translation, so re-opening a call costs zero LLM calls. Shares the
-- transcriptTranslatedLang marker (both re-translate together on a language change).
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "summaryTranslated" TEXT;
