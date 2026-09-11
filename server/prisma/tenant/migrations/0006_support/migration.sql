-- CreateEnum
CREATE TYPE "TicketLane" AS ENUM ('support', 'brand');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

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

-- CreateTable
CREATE TABLE "ticket_departments" (
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
CREATE TABLE "ticket_saved_replies" (
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
CREATE TABLE "tickets" (
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
    "escalatedFromId" TEXT,
    "escalatedFromBrandId" TEXT,
    "escalationId" TEXT,
    "requesterBrandId" TEXT,
    "requesterName" TEXT NOT NULL DEFAULT '',
    "requesterEmail" TEXT NOT NULL DEFAULT '',
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
CREATE TABLE "ticket_messages" (
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
CREATE TABLE "ticket_merges" (
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
CREATE TABLE "ticket_message_reactions" (
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
CREATE TABLE "ticket_attachments" (
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
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_StaffRoleTicketDepartments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_StaffTicketDepartments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_roles_name_key" ON "staff_roles"("name");

-- CreateIndex
CREATE INDEX "ticket_departments_lane_brandId_order_idx" ON "ticket_departments"("lane", "brandId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_departments_brandId_lane_name_key" ON "ticket_departments"("brandId", "lane", "name");

-- CreateIndex
CREATE INDEX "ticket_saved_replies_lane_brandId_title_idx" ON "ticket_saved_replies"("lane", "brandId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_reference_key" ON "tickets"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_escalatedFromId_key" ON "tickets"("escalatedFromId");

-- CreateIndex
CREATE INDEX "tickets_lane_brandId_status_lastMessageAt_idx" ON "tickets"("lane", "brandId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_lane_brandId_lastMessageAt_idx" ON "tickets"("lane", "brandId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_departmentId_lastMessageAt_idx" ON "tickets"("departmentId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_requesterId_lastMessageAt_idx" ON "tickets"("requesterId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_assignedToId_lastMessageAt_idx" ON "tickets"("assignedToId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_rating_idx" ON "tickets"("rating");

-- CreateIndex
CREATE INDEX "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "ticket_merges_ticketId_mergedAt_idx" ON "ticket_merges"("ticketId", "mergedAt");

-- CreateIndex
CREATE INDEX "ticket_message_reactions_messageId_idx" ON "ticket_message_reactions"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_message_reactions_messageId_actorKey_emoji_key" ON "ticket_message_reactions"("messageId", "actorKey", "emoji");

-- CreateIndex
CREATE INDEX "ticket_attachments_ticketId_createdAt_idx" ON "ticket_attachments"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "_StaffRoleTicketDepartments_AB_unique" ON "_StaffRoleTicketDepartments"("A", "B");

-- CreateIndex
CREATE INDEX "_StaffRoleTicketDepartments_B_index" ON "_StaffRoleTicketDepartments"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_StaffTicketDepartments_AB_unique" ON "_StaffTicketDepartments"("A", "B");

-- CreateIndex
CREATE INDEX "_StaffTicketDepartments_B_index" ON "_StaffTicketDepartments"("B");

-- AddForeignKey
ALTER TABLE "ticket_saved_replies" ADD CONSTRAINT "ticket_saved_replies_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_saved_replies" ADD CONSTRAINT "ticket_saved_replies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ticket_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ticket_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_merges" ADD CONSTRAINT "ticket_merges_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_message_reactions" ADD CONSTRAINT "ticket_message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StaffRoleTicketDepartments" ADD CONSTRAINT "_StaffRoleTicketDepartments_A_fkey" FOREIGN KEY ("A") REFERENCES "staff_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StaffRoleTicketDepartments" ADD CONSTRAINT "_StaffRoleTicketDepartments_B_fkey" FOREIGN KEY ("B") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StaffTicketDepartments" ADD CONSTRAINT "_StaffTicketDepartments_A_fkey" FOREIGN KEY ("A") REFERENCES "ticket_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StaffTicketDepartments" ADD CONSTRAINT "_StaffTicketDepartments_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

