-- Per-recipient opt-out from non-essential notification emails (call summaries,
-- usage & grace/trial reminders). Set when the user clicks the footer
-- unsubscribe link; null = still subscribed.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailOptOutAt" TIMESTAMP(3);
