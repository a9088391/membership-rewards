BEGIN;

ALTER TYPE "PointSource" ADD VALUE 'EXCHANGE';
ALTER TABLE "PointLedger" ALTER COLUMN "reason" DROP NOT NULL;
-- 新 enum 值在提交前只能用文字比較，既有流水仍須保留原因。
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_source_check" CHECK (
    CASE WHEN "source"::text = 'EXCHANGE'
        THEN "amount" < 0 AND "reason" IS NULL AND "actorId" = "memberId"
        ELSE "reason" IS NOT NULL
    END
);

-- 原因為 NULL 等同於兌換流水。用衍生識別碼讓雙向外鍵僅要求兌換流水配對。
ALTER TABLE "PointLedger" ADD COLUMN "exchangeId" UUID
    GENERATED ALWAYS AS (CASE WHEN "reason" IS NULL THEN "id" END) STORED;

CREATE UNIQUE INDEX "CouponOffer_brandId_id_key" ON "CouponOffer"("brandId", "id");
CREATE UNIQUE INDEX "PointLedger_brandId_memberId_exchangeId_key" ON "PointLedger"("brandId", "memberId", "exchangeId");

CREATE TABLE "Voucher" (
    "id" UUID NOT NULL,
    "code" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "ledgerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Voucher_brandId_offerId_fkey"
        FOREIGN KEY ("brandId", "offerId") REFERENCES "CouponOffer"("brandId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Voucher_brandId_memberId_ledgerId_fkey"
        FOREIGN KEY ("brandId", "memberId", "ledgerId") REFERENCES "PointLedger"("brandId", "memberId", "exchangeId")
        ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");
CREATE UNIQUE INDEX "Voucher_brandId_memberId_ledgerId_key" ON "Voucher"("brandId", "memberId", "ledgerId");
CREATE INDEX "Voucher_memberId_createdAt_id_idx" ON "Voucher"("memberId", "createdAt", "id");

-- 扣點先寫入、發券後寫入，兩者須在同一筆交易提交前相互配對。
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_brandId_memberId_exchangeId_fkey"
    FOREIGN KEY ("brandId", "memberId", "exchangeId") REFERENCES "Voucher"("brandId", "memberId", "ledgerId")
    ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

COMMIT;
