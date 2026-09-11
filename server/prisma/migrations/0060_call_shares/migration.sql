-- Where a shared call lives.
--
-- The "More info" link in a call-summary SMS names a call by an unguessable
-- slug, and is served from the platform's API host for every brand — so the
-- request's host cannot say which brand's database holds the call. This index
-- can. Written when the slug is minted (services/callWrite.ts), read by the
-- public conversation page (routes/publicCall.routes.ts).
CREATE TABLE "call_shares" (
    "publicId"      TEXT         NOT NULL,
    "brandId"       TEXT         NOT NULL,
    "callId"        TEXT         NOT NULL,
    "callCreatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_shares_pkey" PRIMARY KEY ("publicId")
);

CREATE INDEX "call_shares_brandId_idx" ON "call_shares" ("brandId");
