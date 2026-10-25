-- When preparation of an order started and by whom ("being prepared" state, preparation time report).
-- Additive: two nullable columns, an index and a foreign key.

-- AlterTable
ALTER TABLE "ord_orders" ADD COLUMN     "picking_started_at" TIMESTAMP(3),
ADD COLUMN     "picking_started_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_picking_started_by_id_fkey" FOREIGN KEY ("picking_started_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

