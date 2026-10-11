CREATE TABLE "aud_stock_reconciliations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "previous_source_type" "SourceType" NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "quantity_restored" DECIMAL(12,3) NOT NULL,
    "stock_before" DECIMAL(12,3) NOT NULL,
    "stock_after" DECIMAL(12,3) NOT NULL,
    "amount_mnt" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aud_stock_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "aud_stock_reconciliations_orderId_idx" ON "aud_stock_reconciliations"("orderId");
CREATE INDEX "aud_stock_reconciliations_productId_idx" ON "aud_stock_reconciliations"("productId");

ALTER TABLE "aud_stock_reconciliations" ADD CONSTRAINT "aud_stock_reconciliations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aud_stock_reconciliations" ADD CONSTRAINT "aud_stock_reconciliations_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "ord_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aud_stock_reconciliations" ADD CONSTRAINT "aud_stock_reconciliations_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
