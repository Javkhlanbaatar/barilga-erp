-- Phase 2A: warehouses (shop = warehouse), per-warehouse stock balances and an append-only stock ledger.
-- Purely additive: no column or row is dropped. inv_products.stock_quantity stays and is kept equal to the
-- sum of the warehouse balances by the application (it remains what POS, the public catalogue and old code read).

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'SALE', 'RETURN', 'RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'RECONCILE');

-- CreateTable
CREATE TABLE "inv_warehouses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inv_warehouses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inv_stock_balances" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inv_stock_balances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inv_stock_movements" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity_delta" DECIMAL(12,3) NOT NULL,
    "balance_after" DECIMAL(12,3) NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "reason" TEXT,
    "actor_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_stock_movements_pkey" PRIMARY KEY ("id")
);

-- AlterTable (nullable: existing users/orders keep working and resolve to the default warehouse)
ALTER TABLE "sys_users" ADD COLUMN "warehouse_id" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "warehouse_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inv_warehouses_code_key" ON "inv_warehouses"("code");
-- At most one default warehouse.
CREATE UNIQUE INDEX "inv_warehouses_single_default" ON "inv_warehouses"("is_default") WHERE "is_default";
CREATE UNIQUE INDEX "inv_stock_balances_warehouse_id_product_id_key" ON "inv_stock_balances"("warehouse_id", "product_id");
CREATE INDEX "inv_stock_balances_product_id_idx" ON "inv_stock_balances"("product_id");
CREATE INDEX "inv_stock_movements_warehouse_id_product_id_createdAt_idx" ON "inv_stock_movements"("warehouse_id", "product_id", "createdAt");
CREATE INDEX "inv_stock_movements_ref_type_ref_id_idx" ON "inv_stock_movements"("ref_type", "ref_id");
CREATE INDEX "inv_stock_movements_product_id_idx" ON "inv_stock_movements"("product_id");
CREATE INDEX "ord_orders_warehouse_id_idx" ON "ord_orders"("warehouse_id");

-- AddForeignKey
ALTER TABLE "inv_stock_balances" ADD CONSTRAINT "inv_stock_balances_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inv_stock_balances" ADD CONSTRAINT "inv_stock_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inv_stock_movements" ADD CONSTRAINT "inv_stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inv_stock_movements" ADD CONSTRAINT "inv_stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inv_stock_movements" ADD CONSTRAINT "inv_stock_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sys_users" ADD CONSTRAINT "sys_users_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (no data is removed or changed):
-- 1. The default warehouse. Existing stock is attributed to it; the business then redistributes real
--    quantities per shop with an opening count / transfers (Phase 2C).
INSERT INTO "inv_warehouses" ("id", "code", "name", "is_default", "updatedAt")
VALUES (gen_random_uuid()::text, 'MAIN', 'Үндсэн агуулах', true, CURRENT_TIMESTAMP);

-- 2. One balance + one OPENING ledger row per product, equal to today's stock_quantity.
INSERT INTO "inv_stock_balances" ("id", "warehouse_id", "product_id", "quantity", "updatedAt")
SELECT gen_random_uuid()::text, w."id", p."id", p."stock_quantity", CURRENT_TIMESTAMP
FROM "inv_products" p CROSS JOIN "inv_warehouses" w WHERE w."is_default";

INSERT INTO "inv_stock_movements" ("id", "warehouse_id", "product_id", "type", "quantity_delta", "balance_after", "ref_type", "reason")
SELECT gen_random_uuid()::text, w."id", p."id", 'OPENING', p."stock_quantity", p."stock_quantity", 'MIGRATION', 'Opening balance from pre-warehouse stock'
FROM "inv_products" p CROSS JOIN "inv_warehouses" w WHERE w."is_default";

-- 3. History belongs to the default warehouse.
UPDATE "ord_orders" SET "warehouse_id" = (SELECT "id" FROM "inv_warehouses" WHERE "is_default") WHERE "warehouse_id" IS NULL;
