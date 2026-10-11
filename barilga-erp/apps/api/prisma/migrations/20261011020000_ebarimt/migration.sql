-- E-Barimt (POSAPI) receipt fields on ord_orders
CREATE TYPE "BillType" AS ENUM ('CITIZEN', 'COMPANY');
CREATE TYPE "EbarimtStatus" AS ENUM ('NOT_ISSUED', 'PENDING', 'ISSUED', 'FAILED');

ALTER TABLE "ord_orders" ADD COLUMN "billType" "BillType" NOT NULL DEFAULT 'CITIZEN';
ALTER TABLE "ord_orders" ADD COLUMN "customerRegNumber" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "receiptId" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "lottery" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "qrCode" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtStatus" "EbarimtStatus" NOT NULL DEFAULT 'NOT_ISSUED';
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtError" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtIssuedAt" TIMESTAMP(3);
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtNextRetryAt" TIMESTAMP(3);
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ord_orders" ADD COLUMN "ebarimtPayload" JSONB;
