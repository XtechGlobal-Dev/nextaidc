-- Coupons: admin-created discount codes redeemed at checkout or granted by an
-- admin. `percentOff` discounts the plan price (mirrored to a Stripe coupon);
-- `bonusMinutes` tops up the cycle's call minutes (ours alone, never sent to
-- Stripe). The discount lasts `durationCycles` BILLING CYCLES, counted by us —
-- Stripe's calendar-month duration is unusable here because
-- renewActivePlanIfExhausted renews early whenever minutes run out.
--
-- coupon_redemptions rows are permanent once live: the unique (couponId, userId)
-- index is what stops a user redeeming the same code twice, and a spent
-- redemption is kept (status 'exhausted') precisely because it is that block.
-- Stale 'pending' reservations are DELETED by the scheduler sweep rather than
-- marked, or an abandoned checkout would lock the user out of a code they never
-- actually used.
--
-- Idempotent (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "percentOff" INTEGER,
    "bonusMinutes" INTEGER,
    "durationCycles" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "newCustomersOnly" BOOLEAN NOT NULL DEFAULT true,
    "planIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stripeCouponId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_key" ON "coupons"("code");

CREATE TABLE IF NOT EXISTS "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cyclesUsed" INTEGER NOT NULL DEFAULT 0,
    -- Makes cycle consumption idempotent per billing period: an early renewal
    -- counts a cycle AND fires a subscription webhook that would otherwise count
    -- the same one again, halving the customer's discount.
    "lastCountedPeriodEnd" TIMESTAMP(3),
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- The per-user limit, enforced by the database so a race or double-submit can't
-- create a second redemption of the same code for the same user.
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_redemptions_couponId_userId_key"
    ON "coupon_redemptions"("couponId", "userId");

CREATE INDEX IF NOT EXISTS "coupon_redemptions_userId_status_idx"
    ON "coupon_redemptions"("userId", "status");

DO $$ BEGIN
    ALTER TABLE "coupon_redemptions"
        ADD CONSTRAINT "coupon_redemptions_couponId_fkey"
        FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "coupon_redemptions"
        ADD CONSTRAINT "coupon_redemptions_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Pointer to the LIVE redemption only, so "does this user have a discount right
-- now" is a single column read. Deliberately NOT a foreign key: the sweep deletes
-- stale pending rows and a released revoke deletes the row outright, and neither
-- should be blocked by (or silently null out through) a constraint.
ALTER TABLE "profiles"
    ADD COLUMN IF NOT EXISTS "activeCouponRedemptionId" TEXT;
