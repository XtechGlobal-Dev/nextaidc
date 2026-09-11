-- Support tickets: two lanes of conversation on the tenancy ladder.
--
--   support — a brand's CUSTOMER asks that brand's admin team
--   brand   — a BRAND ADMIN asks the platform (the super admin)
--
-- Seven tables, three enums and the two implicit join tables behind the
-- department grants on StaffRole and User.
--
-- Written idempotently (see server/MIGRATIONS.md): the shared Neon DB already
-- carries these objects, so every statement here tolerates being re-run.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TicketLane" AS ENUM ('support', 'brand');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_departments" (
    "id" TEXT NOT NULL,
    "lane" "TicketLane" NOT NULL,
    "brandId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "requesterVisible" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_saved_replies" (
    "id" TEXT NOT NULL,
    "lane" "TicketLane" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "brandId" TEXT,
    "departmentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "tickets" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "reference" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lane" "TicketLane" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "brandId" TEXT,
    "departmentId" TEXT,
    "requesterId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'app',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadForStaff" BOOLEAN NOT NULL DEFAULT true,
    "unreadForRequester" BOOLEAN NOT NULL DEFAULT false,
    "staffReadAt" TIMESTAMP(3),
    "requesterReadAt" TIMESTAMP(3),
    "rating" INTEGER,
    "ratingComment" TEXT NOT NULL DEFAULT '',
    "ratedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "replyToId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_merges" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "sourceNumber" INTEGER NOT NULL,
    "sourceReference" TEXT NOT NULL,
    "sourceSubject" TEXT NOT NULL,
    "sourceRequesterName" TEXT NOT NULL DEFAULT '',
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "mergedById" TEXT,
    "mergedByName" TEXT NOT NULL DEFAULT '',
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ticket_attachments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "_StaffRoleTicketDepartments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "_StaffTicketDepartments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_departments_lane_brandId_order_idx" ON "ticket_departments"("lane", "brandId", "order");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_departments_brandId_lane_name_key" ON "ticket_departments"("brandId", "lane", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_saved_replies_lane_brandId_title_idx" ON "ticket_saved_replies"("lane", "brandId", "title");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_number_key" ON "tickets"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_reference_key" ON "tickets"("reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_lane_brandId_status_lastMessageAt_idx" ON "tickets"("lane", "brandId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_lane_brandId_lastMessageAt_idx" ON "tickets"("lane", "brandId", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_departmentId_lastMessageAt_idx" ON "tickets"("departmentId", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_requesterId_lastMessageAt_idx" ON "tickets"("requesterId", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_assignedToId_lastMessageAt_idx" ON "tickets"("assignedToId", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_rating_idx" ON "tickets"("rating");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_merges_ticketId_mergedAt_idx" ON "ticket_merges"("ticketId", "mergedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_message_reactions_messageId_idx" ON "ticket_message_reactions"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_message_reactions_messageId_actorKey_emoji_key" ON "ticket_message_reactions"("messageId", "actorKey", "emoji");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_attachments_ticketId_createdAt_idx" ON "ticket_attachments"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "_StaffRoleTicketDepartments_AB_unique" ON "_StaffRoleTicketDepartments"("A", "B");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "_StaffRoleTicketDepartments_B_index" ON "_StaffRoleTicketDepartments"("B");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "_StaffTicketDepartments_AB_unique" ON "_StaffTicketDepartments"("A", "B");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "_StaffTicketDepartments_B_index" ON "_StaffTicketDepartments"("B");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_departments" ADD CONSTRAINT "ticket_departments_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_saved_replies" ADD CONSTRAINT "ticket_saved_replies_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_saved_replies" ADD CONSTRAINT "ticket_saved_replies_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_saved_replies" ADD CONSTRAINT "ticket_saved_replies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ticket_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ticket_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_merges" ADD CONSTRAINT "ticket_merges_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_message_reactions" ADD CONSTRAINT "ticket_message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "_StaffRoleTicketDepartments" ADD CONSTRAINT "_StaffRoleTicketDepartments_A_fkey" FOREIGN KEY ("A") REFERENCES "staff_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "_StaffRoleTicketDepartments" ADD CONSTRAINT "_StaffRoleTicketDepartments_B_fkey" FOREIGN KEY ("B") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "_StaffTicketDepartments" ADD CONSTRAINT "_StaffTicketDepartments_A_fkey" FOREIGN KEY ("A") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "_StaffTicketDepartments" ADD CONSTRAINT "_StaffTicketDepartments_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
