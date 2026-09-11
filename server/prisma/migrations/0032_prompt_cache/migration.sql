-- Persisted cache of Vapi prompt summaries: SHA-1 of the master prompt -> the
-- OpenAI-compressed version. The summariser is a slow LLM call; the result is
-- deterministic per prompt, so caching it here lets a test call / assistant
-- re-sync reuse it. Unlike the in-memory cache this survives restarts and
-- cold starts, so a freshly-woken instance doesn't re-pay the latency for an
-- unchanged prompt.
--
-- Idempotent (see server/MIGRATIONS.md).
CREATE TABLE IF NOT EXISTS "prompt_cache" (
  "hash" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prompt_cache_pkey" PRIMARY KEY ("hash")
);
