-- General manager role; branch managers get explicit warehouse access.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_MANAGER' BEFORE 'MANAGER';

-- Shop or warehouse.
CREATE TYPE "WarehouseKind" AS ENUM ('SHOP', 'WAREHOUSE');
ALTER TABLE "inv_warehouses" ADD COLUMN "kind" "WarehouseKind" NOT NULL DEFAULT 'SHOP';

CREATE TABLE "usr_warehouse_access" (
    "user_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usr_warehouse_access_pkey" PRIMARY KEY ("user_id", "warehouse_id")
);
CREATE INDEX "usr_warehouse_access_warehouse_id_idx" ON "usr_warehouse_access"("warehouse_id");
ALTER TABLE "usr_warehouse_access" ADD CONSTRAINT "usr_warehouse_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usr_warehouse_access" ADD CONSTRAINT "usr_warehouse_access_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Items that go out with a product (hardener with resin paint …).
ALTER TABLE "inv_products" ADD COLUMN "companions" JSONB;
