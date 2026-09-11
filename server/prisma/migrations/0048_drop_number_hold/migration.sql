-- Replace the post-release HOLD with a brand reclaim window.
--
-- The old rule: a released number sat in its brand's pool as HELD — visible but
-- assignable by nobody — for a configurable window (30 days by default), then
-- returned to the shared platform pool.
--
-- The new rule: a number a brand admin unassigns goes straight back to that
-- brand's pool as AVAILABLE, so the brand can hand it to another of its own
-- customers immediately. If the brand does NOT reuse it within the reclaim
-- window (7 days), the hourly sweep moves it to the shared platform pool, where
-- every brand's customers can draw on it. Use it or lose it.
--
-- `releasedAt` is KEPT — it stops being a cooldown clock and becomes the
-- "unassigned at" stamp the reclaim sweep measures from.
--
-- Any number still sitting in HELD is freed in place, keeping its brandId, so it
-- lands in the pool of the brand that is still being billed for it.
--
-- Idempotent (see server/MIGRATIONS.md).

UPDATE "phone_numbers"
SET "poolStatus" = 'AVAILABLE'
WHERE "poolStatus" = 'HELD';

-- The old hold setting configured a window that no longer exists.
DELETE FROM "platform_settings" WHERE "key" = 'phones.releaseHoldDays';
