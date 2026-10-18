-- Where a transfer refund goes, and when it was actually paid out.
ALTER TABLE "ord_returns" ADD COLUMN "refund_account" TEXT;
ALTER TABLE "ord_returns" ADD COLUMN "paid_out_at" TIMESTAMP(3);
ALTER TABLE "ord_returns" ADD COLUMN "paid_out_by_id" TEXT;
