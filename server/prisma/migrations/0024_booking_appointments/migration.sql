-- Website-first booking module: one minimal Appointment record per booking.
-- No Service / Resource / capacity tables (deliberately simple). Idempotent so it
-- tolerates being re-run / a partially-ahead DB (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "booking_appointments" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "customerName"  TEXT NOT NULL DEFAULT '',
  "customerPhone" TEXT NOT NULL DEFAULT '',
  "customerEmail" TEXT NOT NULL DEFAULT '',
  "notes"         TEXT NOT NULL DEFAULT '',
  "startAt"       TIMESTAMP(3) NOT NULL,
  "endAt"         TIMESTAMP(3) NOT NULL,
  "timezone"      TEXT NOT NULL DEFAULT '',
  "status"        TEXT NOT NULL DEFAULT 'confirmed',
  "source"        TEXT NOT NULL DEFAULT 'ai',
  "googleEventId" TEXT NOT NULL DEFAULT '',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_appointments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "booking_appointments_userId_startAt_idx"
  ON "booking_appointments" ("userId", "startAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'booking_appointments_userId_fkey'
  ) THEN
    ALTER TABLE "booking_appointments"
      ADD CONSTRAINT "booking_appointments_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
