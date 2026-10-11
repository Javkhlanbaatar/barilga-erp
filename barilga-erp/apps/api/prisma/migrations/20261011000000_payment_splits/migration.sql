CREATE TYPE "PayMethod" AS ENUM ('QPAY', 'CASH', 'CARD');

ALTER TABLE "pay_qpay_invoices" RENAME TO "ord_payment_splits";

ALTER TABLE "ord_payment_splits" DROP CONSTRAINT IF EXISTS "pay_qpay_invoices_orderId_key";
DROP INDEX IF EXISTS "pay_qpay_invoices_orderId_key";

ALTER TABLE "ord_payment_splits" RENAME CONSTRAINT "pay_qpay_invoices_pkey" TO "ord_payment_splits_pkey";
ALTER TABLE "ord_payment_splits" RENAME CONSTRAINT "pay_qpay_invoices_orderId_fkey" TO "ord_payment_splits_orderId_fkey";

ALTER INDEX IF EXISTS "pay_qpay_invoices_status_nextPollAt_idx" RENAME TO "ord_payment_splits_status_nextPollAt_idx";

ALTER TABLE "ord_payment_splits" ADD COLUMN "method" "PayMethod";

UPDATE "ord_payment_splits" SET "method" = CASE
  WHEN "provider" = 'CASH' THEN 'CASH'::"PayMethod"
  WHEN "provider" = 'CARD' THEN 'CARD'::"PayMethod"
  ELSE 'QPAY'::"PayMethod"
END;

ALTER TABLE "ord_payment_splits" ALTER COLUMN "method" SET NOT NULL;

CREATE INDEX "ord_payment_splits_orderId_idx" ON "ord_payment_splits"("orderId");
