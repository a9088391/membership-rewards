BEGIN;

CREATE TYPE "PointSource" AS ENUM ('SEED', 'GRANT');

CREATE TABLE "PointAccount" (
    "brandId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PointAccount_pkey" PRIMARY KEY ("brandId", "memberId"),
    CONSTRAINT "PointAccount_balance_check" CHECK ("balance" BETWEEN 0 AND 2147483647)
);

CREATE TABLE "PointLedger" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "source" "PointSource" NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PointLedger_amount_check" CHECK ("amount" <> 0)
);

CREATE TABLE "IdempotentOperation" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "key" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "status" INTEGER,
    "result" JSONB,

    CONSTRAINT "IdempotentOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotentOperation_result_check" CHECK (("status" IS NULL) = ("result" IS NULL))
);

CREATE INDEX "PointLedger_brandId_memberId_createdAt_id_idx" ON "PointLedger"("brandId", "memberId", "createdAt", "id");
CREATE UNIQUE INDEX "IdempotentOperation_actorId_key_key" ON "IdempotentOperation"("actorId", "key");

ALTER TABLE "PointAccount" ADD CONSTRAINT "PointAccount_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointAccount" ADD CONSTRAINT "PointAccount_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_brandId_memberId_fkey"
    FOREIGN KEY ("brandId", "memberId") REFERENCES "PointAccount"("brandId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotentOperation" ADD CONSTRAINT "IdempotentOperation_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
