BEGIN;

ALTER TYPE "PointSource" ADD VALUE 'REVERSAL';
ALTER TABLE "PointLedger" ADD COLUMN "reversalOfId" UUID;

-- 新 enum 值在提交前以文字比較。既有兌換來源約束及雙向配對維持原樣。
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_reversal_check" CHECK (
    CASE WHEN "source"::text = 'REVERSAL'
        THEN "reversalOfId" IS NOT NULL AND "amount" < 0 AND "reason" IS NOT NULL
        ELSE "reversalOfId" IS NULL
    END
);

-- 原流水只能由同一帳戶引用一次，外鍵也禁止單獨刪除已被撤回的原流水。
CREATE UNIQUE INDEX "PointLedger_brandId_memberId_id_key" ON "PointLedger"("brandId", "memberId", "id");
CREATE UNIQUE INDEX "PointLedger_brandId_memberId_reversalOfId_key" ON "PointLedger"("brandId", "memberId", "reversalOfId");

ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_brandId_memberId_reversalOfId_fkey"
    FOREIGN KEY ("brandId", "memberId", "reversalOfId") REFERENCES "PointLedger"("brandId", "memberId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
