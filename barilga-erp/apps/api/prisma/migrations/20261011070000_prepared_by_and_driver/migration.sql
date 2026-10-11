ALTER TABLE "ord_orders" ADD COLUMN "driver_name" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "prepared_by_id" TEXT;
ALTER TABLE "ord_orders" ADD COLUMN "prepared_at" TIMESTAMP(3);

UPDATE "ord_orders"
SET "prepared_by_id" = "completedById", "prepared_at" = "completedAt"
WHERE "completedById" IS NOT NULL;

ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_prepared_by_id_fkey" FOREIGN KEY ("prepared_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
