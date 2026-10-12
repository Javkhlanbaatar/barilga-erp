-- Picking checklist on order lines, goods receipts (бараа орлого) with optional unit cost, and admin settings.
-- Additive only: new nullable columns and new tables; no existing data is changed.

-- AlterTable
ALTER TABLE "inv_products" ADD COLUMN     "last_cost_mnt" INTEGER;

-- AlterTable
ALTER TABLE "ord_order_items" ADD COLUMN     "picked_at" TIMESTAMP(3),
ADD COLUMN     "picked_by_id" TEXT;

-- CreateTable
CREATE TABLE "inv_stock_receipts" (
    "id" TEXT NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "supplier_invoice_no" TEXT,
    "notes" TEXT,
    "received_by_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_stock_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_stock_receipt_items" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost_mnt" INTEGER,

    CONSTRAINT "inv_stock_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sys_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "inv_stock_receipts_receipt_number_key" ON "inv_stock_receipts"("receipt_number");

-- CreateIndex
CREATE INDEX "inv_stock_receipts_warehouse_id_received_at_idx" ON "inv_stock_receipts"("warehouse_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inv_stock_receipt_items_receipt_id_product_id_key" ON "inv_stock_receipt_items"("receipt_id", "product_id");

-- AddForeignKey
ALTER TABLE "ord_order_items" ADD CONSTRAINT "ord_order_items_picked_by_id_fkey" FOREIGN KEY ("picked_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_receipts" ADD CONSTRAINT "inv_stock_receipts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_receipts" ADD CONSTRAINT "inv_stock_receipts_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_receipt_items" ADD CONSTRAINT "inv_stock_receipt_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "inv_stock_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_receipt_items" ADD CONSTRAINT "inv_stock_receipt_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sys_settings" ADD CONSTRAINT "sys_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Guards the application also enforces.
ALTER TABLE "inv_stock_receipt_items" ADD CONSTRAINT "inv_stock_receipt_items_positive_qty" CHECK ("quantity" > 0);
ALTER TABLE "inv_stock_receipt_items" ADD CONSTRAINT "inv_stock_receipt_items_cost_not_negative" CHECK ("unit_cost_mnt" IS NULL OR "unit_cost_mnt" >= 0);
