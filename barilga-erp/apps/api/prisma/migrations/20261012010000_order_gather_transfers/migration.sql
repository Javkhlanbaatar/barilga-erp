-- Links a stock transfer to the order it collects stock for (gathering an order from several warehouses).
-- Additive: a nullable column, an index and a foreign key. Existing transfers keep order_id = NULL.

-- AlterTable
ALTER TABLE "inv_stock_transfers" ADD COLUMN     "order_id" TEXT;

-- CreateIndex
CREATE INDEX "inv_stock_transfers_order_id_idx" ON "inv_stock_transfers"("order_id");

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ord_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

