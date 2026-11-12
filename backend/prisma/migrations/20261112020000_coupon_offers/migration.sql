BEGIN;

CREATE TABLE "CouponOffer" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "points" INTEGER NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "stoppedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponOffer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CouponOffer_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "CouponOffer_description_check" CHECK (char_length("description") BETWEEN 1 AND 500),
    CONSTRAINT "CouponOffer_points_check" CHECK ("points" BETWEEN 1 AND 2147483647),
    CONSTRAINT "CouponOffer_period_check" CHECK ("startsAt" < "endsAt"),
    CONSTRAINT "CouponOffer_brandId_fkey"
        FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CouponOffer_brandId_createdAt_id_idx" ON "CouponOffer"("brandId", "createdAt", "id");

COMMIT;
