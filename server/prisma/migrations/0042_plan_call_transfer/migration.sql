-- Human Call Transfer becomes a per-plan entitlement with a department cap.
--
--   callTransferEnabled = false  → the module is locked; the AI never offers a
--                                  handoff and the page shows an upgrade prompt.
--   callTransferEnabled = true   → allowed, capped by callTransferLimit.
--   callTransferLimit   = 0      → unlimited. Same convention `includedMinutes`
--                                  already uses, so one rule reads across the
--                                  whole plan form. The pair is always resolved
--                                  through transferDepartmentAllowance().
--
-- BACKFILL: every existing plan is switched ON and UNLIMITED, which is exactly
-- what customers have today (transfer was ungated, capped only by the global
-- MAX_DEPARTMENTS = 20). Defaulting to `false` instead would silently strip a
-- live feature from every paying customer the moment this deploys. Same
-- reasoning as the smsToCaller backfill: nobody's entitlement changes on
-- deploy, and the real tier limits are then set deliberately in Admin → Plans.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "callTransferEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "callTransferLimit" INTEGER NOT NULL DEFAULT 0;

-- Only touches rows still sitting on the column default, so re-running this
-- after an admin has configured real limits cannot undo their work.
UPDATE "subscription_plans"
  SET "callTransferEnabled" = true
  WHERE "callTransferEnabled" = false;
