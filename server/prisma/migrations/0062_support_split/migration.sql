-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_staffRoleId_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_escalatedFromId_fkey";

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "escalatedFromBrandId" TEXT,
ADD COLUMN     "escalationId" TEXT,
ADD COLUMN     "requesterBrandId" TEXT,
ADD COLUMN     "requesterEmail" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "requesterName" TEXT NOT NULL DEFAULT '';

