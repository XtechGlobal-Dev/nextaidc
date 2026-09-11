-- API Center — telemetry for every third-party API this platform calls.
--
-- Four tables, all additive; nothing existing is touched:
--
--  * api_request_logs      — one row per outbound vendor call (append-only).
--  * api_provider_settings — admin-editable quota / price / key expiry per vendor.
--  * api_alert_rules       — thresholds that turn telemetry into alerts.
--  * api_alert_events      — the firing history of those rules.
--
-- api_request_logs is the hot one: it takes a write on every outbound call and is
-- read by every API Center screen. Its three indexes match the only three shapes
-- those queries take — one provider over time, the whole fleet over time, and one
-- provider's failures over time. Retention is enforced in application code
-- (services/apiTrace.ts prunes rows past the window), not by a trigger, so the
-- policy is visible where the writes are.
--
-- Idempotent (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "api_request_logs" (
  "id"           TEXT NOT NULL,
  "provider"     TEXT NOT NULL,
  "endpoint"     TEXT NOT NULL DEFAULT '',
  "method"       TEXT NOT NULL DEFAULT 'GET',
  "status"       INTEGER NOT NULL DEFAULT 0,
  "ok"           BOOLEAN NOT NULL DEFAULT true,
  "durationMs"   INTEGER NOT NULL DEFAULT 0,
  "environment"  TEXT NOT NULL DEFAULT 'production',
  "errorCode"    TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "units"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
  "rateLimit"     INTEGER,
  "rateRemaining" INTEGER,
  "rateResetAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "api_request_logs_provider_createdAt_idx"
  ON "api_request_logs" ("provider", "createdAt");
CREATE INDEX IF NOT EXISTS "api_request_logs_createdAt_idx"
  ON "api_request_logs" ("createdAt");
CREATE INDEX IF NOT EXISTS "api_request_logs_provider_ok_createdAt_idx"
  ON "api_request_logs" ("provider", "ok", "createdAt");

CREATE TABLE IF NOT EXISTS "api_provider_settings" (
  "provider"         TEXT NOT NULL,
  "monthlyQuota"     INTEGER NOT NULL DEFAULT 0,
  "unitCostMicroUsd" INTEGER,
  "rateLimitPerMin"  INTEGER NOT NULL DEFAULT 0,
  "environment"      TEXT NOT NULL DEFAULT 'production',
  "keyExpiresAt"     TIMESTAMP(3),
  "muted"            BOOLEAN NOT NULL DEFAULT false,
  "notes"            TEXT NOT NULL DEFAULT '',
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_provider_settings_pkey" PRIMARY KEY ("provider")
);

CREATE TABLE IF NOT EXISTS "api_alert_rules" (
  "id"          TEXT NOT NULL,
  "provider"    TEXT,
  "metric"      TEXT NOT NULL,
  "comparator"  TEXT NOT NULL DEFAULT 'gt',
  "threshold"   DOUBLE PRECISION NOT NULL,
  "windowMin"   INTEGER NOT NULL DEFAULT 60,
  "severity"    TEXT NOT NULL DEFAULT 'warning',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "cooldownMin" INTEGER NOT NULL DEFAULT 60,
  "lastFiredAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_alert_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "api_alert_rules_enabled_idx"
  ON "api_alert_rules" ("enabled");

CREATE TABLE IF NOT EXISTS "api_alert_events" (
  "id"             TEXT NOT NULL,
  "ruleId"         TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "metric"         TEXT NOT NULL,
  "severity"       TEXT NOT NULL DEFAULT 'warning',
  "value"          DOUBLE PRECISION NOT NULL,
  "threshold"      DOUBLE PRECISION NOT NULL,
  "message"        TEXT NOT NULL DEFAULT '',
  "acknowledgedAt" TIMESTAMP(3),
  "resolvedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_alert_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "api_alert_events_createdAt_idx"
  ON "api_alert_events" ("createdAt");
CREATE INDEX IF NOT EXISTS "api_alert_events_provider_createdAt_idx"
  ON "api_alert_events" ("provider", "createdAt");

-- Deleting a rule discards its history: an alert event is only meaningful in
-- terms of the rule that raised it. Guarded so re-running can't fail on an FK
-- that is already present.
DO $$
BEGIN
  ALTER TABLE "api_alert_events"
    ADD CONSTRAINT "api_alert_events_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "api_alert_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
