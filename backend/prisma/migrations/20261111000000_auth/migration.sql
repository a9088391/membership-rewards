CREATE TYPE "Role" AS ENUM ('MEMBER', 'GROUP_ADMIN', 'BRAND_ADMIN');
CREATE TYPE "AttemptKind" AS ENUM ('LOGIN_SOURCE', 'LOGIN_ACCOUNT', 'REGISTER_SOURCE');

CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "memberNumber" UUID,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Account_member_number_role" CHECK (("role" = 'MEMBER') = ("memberNumber" IS NOT NULL))
);

CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttemptWindow" (
    "kind" "AttemptKind" NOT NULL,
    "key" TEXT NOT NULL,
    "attempted" TIMESTAMPTZ(3)[] NOT NULL,

    CONSTRAINT "AttemptWindow_pkey" PRIMARY KEY ("kind", "key")
);

CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
CREATE UNIQUE INDEX "Account_memberNumber_key" ON "Account"("memberNumber");

ALTER TABLE "Session" ADD CONSTRAINT "Session_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
