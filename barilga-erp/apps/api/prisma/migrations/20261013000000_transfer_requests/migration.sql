-- Transfer requests from shops, partial receipt with shortages. Additive only: existing transfers keep
-- their sender and sent time; the new columns are empty for them.

-- AlterEnum
ALTER TYPE "TransferStatus" ADD VALUE 'REQUESTED' BEFORE 'IN_TRANSIT';

-- AlterTable
ALTER TABLE "inv_stock_transfers" ALTER COLUMN "sent_by_id" DROP NOT NULL,
ALTER COLUMN "sent_at" DROP NOT NULL,
ALTER COLUMN "sent_at" DROP DEFAULT,
ADD COLUMN "requested_by_id" TEXT,
ADD COLUMN "requested_at" TIMESTAMP(3),
ADD COLUMN "has_shortage" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "inv_stock_transfer_items" ADD COLUMN "requested_qty" DECIMAL(12,3),
ADD COLUMN "received_qty" DECIMAL(12,3),
ADD COLUMN "shortage_reason" TEXT;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The sender is optional now (requests), so match Prisma's default for optional relations.
ALTER TABLE "inv_stock_transfers" DROP CONSTRAINT "inv_stock_transfers_sent_by_id_fkey";
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Who recorded each payment, so a debt paid later counts in the drawer of the cashier who took it.
ALTER TABLE "ord_payment_splits" ADD COLUMN "recorded_by_id" TEXT;

-- A request line has nothing sent yet (0), and a source may decline one line (0): sent quantity may be zero.
ALTER TABLE "inv_stock_transfer_items" DROP CONSTRAINT "inv_stock_transfer_items_positive_qty";
ALTER TABLE "inv_stock_transfer_items" ADD CONSTRAINT "inv_stock_transfer_items_nonneg_qty" CHECK ("quantity" >= 0);
ALTER TABLE "inv_stock_transfer_items" ADD CONSTRAINT "inv_stock_transfer_items_requested_positive" CHECK ("requested_qty" IS NULL OR "requested_qty" > 0);
