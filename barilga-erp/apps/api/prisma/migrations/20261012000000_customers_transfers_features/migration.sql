-- Phase 2B: customer register, warehouse-to-warehouse stock transfers, and admin module on/off switches.
-- Purely additive: no existing column or row is dropped or changed. ord_orders.customer_id is nullable, so
-- every existing order stays valid (its customer_name / customer_phone snapshot is untouched).

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "ord_orders" ADD COLUMN     "customer_id" TEXT;

-- CreateTable
CREATE TABLE "crm_customers" (
    "id" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reg_number" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "search_text" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_stock_transfers" (
    "id" TEXT NOT NULL,
    "transfer_number" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "from_warehouse_id" TEXT NOT NULL,
    "to_warehouse_id" TEXT NOT NULL,
    "notes" TEXT,
    "sent_by_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_id" TEXT,
    "received_at" TIMESTAMP(3),
    "cancelled_by_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inv_stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_stock_transfer_items" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "inv_stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_by_id" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sys_feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_customers_reg_number_key" ON "crm_customers"("reg_number");

-- CreateIndex
CREATE INDEX "crm_customers_phone_idx" ON "crm_customers"("phone");

-- CreateIndex
CREATE INDEX "crm_customers_name_idx" ON "crm_customers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "inv_stock_transfers_transfer_number_key" ON "inv_stock_transfers"("transfer_number");

-- CreateIndex
CREATE INDEX "inv_stock_transfers_status_idx" ON "inv_stock_transfers"("status");

-- CreateIndex
CREATE INDEX "inv_stock_transfers_from_warehouse_id_idx" ON "inv_stock_transfers"("from_warehouse_id");

-- CreateIndex
CREATE INDEX "inv_stock_transfers_to_warehouse_id_idx" ON "inv_stock_transfers"("to_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_stock_transfer_items_transfer_id_product_id_key" ON "inv_stock_transfer_items"("transfer_id", "product_id");

-- CreateIndex
CREATE INDEX "ord_orders_customer_id_idx" ON "ord_orders"("customer_id");

-- AddForeignKey
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_customers" ADD CONSTRAINT "crm_customers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_from_warehouse_id_fkey" FOREIGN KEY ("from_warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_to_warehouse_id_fkey" FOREIGN KEY ("to_warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfer_items" ADD CONSTRAINT "inv_stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "inv_stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock_transfer_items" ADD CONSTRAINT "inv_stock_transfer_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sys_feature_flags" ADD CONSTRAINT "sys_feature_flags_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Guards the application also enforces, kept in the database so no code path can bypass them.
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_distinct_warehouses" CHECK ("from_warehouse_id" <> "to_warehouse_id");
ALTER TABLE "inv_stock_transfer_items" ADD CONSTRAINT "inv_stock_transfer_items_positive_qty" CHECK ("quantity" > 0);
