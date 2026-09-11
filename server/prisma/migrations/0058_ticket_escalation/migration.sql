-- A brand admin can hand one of their customers' tickets up to the platform.
--
-- That creates a NEW ticket on the `brand` lane — the brand asking, the
-- platform answering — and links it back to the customer's ticket, which stays
-- on the `support` lane in the brand's own inbox. The platform never reaches a
-- tenant's customer conversation; it reaches the brand admin's account of it.
--
-- One escalation per ticket (unique), and deleting either side only clears the
-- link on the other.

ALTER TABLE "tickets" ADD COLUMN "escalatedFromId" TEXT;

CREATE UNIQUE INDEX "tickets_escalatedFromId_key" ON "tickets"("escalatedFromId");

ALTER TABLE "tickets"
    ADD CONSTRAINT "tickets_escalatedFromId_fkey"
    FOREIGN KEY ("escalatedFromId") REFERENCES "tickets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
