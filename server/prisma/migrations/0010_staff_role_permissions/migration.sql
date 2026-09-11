-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'STAFF';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
