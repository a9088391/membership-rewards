BEGIN;

ALTER TYPE "AttemptKind" ADD VALUE 'REDEMPTION_ACCOUNT';

CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED');

ALTER TABLE "Voucher" ADD COLUMN "usedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "Voucher_brandId_memberId_id_key" ON "Voucher"("brandId", "memberId", "id");

CREATE TABLE "RedemptionRequest" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "voucherId" UUID NOT NULL,
    "initiatorId" UUID NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    CONSTRAINT "RedemptionRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RedemptionRequest_times_check" CHECK (
        "createdAt" < "expiresAt" AND (("status" = 'PENDING') = ("resolvedAt" IS NULL))
    ),
    CONSTRAINT "RedemptionRequest_voucher_owner_fkey" FOREIGN KEY ("brandId", "memberId", "voucherId")
        REFERENCES "Voucher"("brandId", "memberId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RedemptionRequest_initiatorId_fkey" FOREIGN KEY ("initiatorId")
        REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "RedemptionRequest_memberId_createdAt_id_idx" ON "RedemptionRequest"("memberId", "createdAt", "id");
CREATE INDEX "RedemptionRequest_voucherId_idx" ON "RedemptionRequest"("voucherId");

-- 時效由交易判斷；索引防止任一路徑同時保留兩筆待確認。
CREATE UNIQUE INDEX "RedemptionRequest_pending_voucher_key" ON "RedemptionRequest"("voucherId") WHERE "status" = 'PENDING';

COMMIT;
