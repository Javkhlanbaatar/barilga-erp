-- A return records the amount owed back to the customer. Nothing in the system pays it out yet,
-- so every return (existing rows included) starts as PENDING_PAYOUT instead of implying money moved.
CREATE TYPE "RefundStatus" AS ENUM ('PENDING_PAYOUT', 'PAID_OUT');

ALTER TABLE "ord_returns" ADD COLUMN "refund_status" "RefundStatus" NOT NULL DEFAULT 'PENDING_PAYOUT';
