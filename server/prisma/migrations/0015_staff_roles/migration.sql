-- CreateTable
CREATE TABLE "staff_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_roles_name_key" ON "staff_roles"("name");

-- AlterTable
ALTER TABLE "users" ADD COLUMN "staffRoleId" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_staffRoleId_fkey" FOREIGN KEY ("staffRoleId") REFERENCES "staff_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
