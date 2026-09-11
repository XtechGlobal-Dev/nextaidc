-- Every account belongs to a brand — except the platform's own people.
--
-- WHY
--   The product is one platform owner (the SUPER_ADMIN) with their own support
--   staff, and under them, brands. A customer, brand admin or reseller is always
--   SOMEONE'S: they signed up on a brand's door, or a brand's admin created
--   them. "An account with no brand" used to ALSO mean "the platform's own
--   customer" — a leftover from before brands existed — and it was exactly the
--   case that leaked: an ADMIN with a NULL brandId read as platform-wide to
--   tenantScope() and saw every brand's customers. That concept is gone. The
--   seed no longer creates a platform ADMIN, sign-up on the platform's own door
--   is refused, and this constraint makes the rule impossible to break from any
--   code path, script or console session.
--
-- WHAT
--   users.brandId may be NULL only on a SUPER_ADMIN row, or on a STAFF row —
--   the platform's own support team, created by the super admin. A brand's
--   staff carry their brand like everyone else.
--
-- DEPLOY
--   The deploy runs `prisma db push`, which does not manage CHECK constraints —
--   it neither creates nor drops them — so this is applied once per database
--   (`npm run prisma:deploy`, or the statement below in psql) and survives every
--   later push. On a database that already has data, fix any violating rows
--   first; the query at the bottom lists them.

ALTER TABLE "users"
    ADD CONSTRAINT "users_brand_required_unless_platform"
    CHECK ("role" IN ('SUPER_ADMIN', 'STAFF') OR "brandId" IS NOT NULL);

-- Rows an existing database must fix (move into a brand, or delete) before the
-- constraint can be added:
--
--   SELECT id, email, role FROM "users"
--    WHERE role NOT IN ('SUPER_ADMIN', 'STAFF') AND "brandId" IS NULL;
