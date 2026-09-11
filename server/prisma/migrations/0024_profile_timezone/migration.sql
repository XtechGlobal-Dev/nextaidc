-- IANA timezone the browser reported at signup (e.g. "Australia/Perth").
-- A signal used to resolve a sensible default for the agent's operating
-- timezone (agentConfig.rules.timezone) — not the source of truth itself.
-- Blank when the browser didn't report one.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT '';
