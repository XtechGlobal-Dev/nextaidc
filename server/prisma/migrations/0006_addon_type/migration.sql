-- Add-on type: distinguishes call-minutes add-ons from WhatsApp / SMS add-ons.
ALTER TABLE "addons" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'minutes';
