BEGIN;

CREATE TABLE "Brand" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "seedKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandAdminGrant" (
    "accountId" UUID NOT NULL,
    "brandId" UUID NOT NULL,

    CONSTRAINT "BrandAdminGrant_pkey" PRIMARY KEY ("accountId", "brandId")
);

CREATE UNIQUE INDEX "Brand_seedKey_key" ON "Brand"("seedKey");
CREATE INDEX "Brand_createdAt_id_idx" ON "Brand"("createdAt", "id");

ALTER TABLE "BrandAdminGrant" ADD CONSTRAINT "BrandAdminGrant_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BrandAdminGrant" ADD CONSTRAINT "BrandAdminGrant_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
