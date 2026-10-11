CREATE TYPE "SourceType" AS ENUM ('INTERNAL', 'EXTERNAL_SUPPLIER');
CREATE TYPE "PayableStatus" AS ENUM ('OPEN', 'VOID');

ALTER TABLE "inv_products" ADD COLUMN "source_type" "SourceType" NOT NULL DEFAULT 'INTERNAL';

ALTER TABLE "ord_order_items" ADD COLUMN "source_type" "SourceType" NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "ord_order_items" ADD COLUMN "supplier_name" TEXT;

CREATE TABLE "ord_returns" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "refund_amount" INTEGER NOT NULL,
    "refund_method" "PayMethod" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "ebarimt_refund_id" TEXT,
    "ebarimt_status" TEXT,
    "ebarimt_error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ord_returns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ord_return_items" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "line_refund" INTEGER NOT NULL,
    CONSTRAINT "ord_return_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "log_supplier_payables" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "amount_mnt" INTEGER NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "log_supplier_payables_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ord_returns_orderId_idx" ON "ord_returns"("orderId");
CREATE INDEX "ord_returns_createdAt_idx" ON "ord_returns"("createdAt");
CREATE INDEX "log_supplier_payables_orderId_idx" ON "log_supplier_payables"("orderId");

ALTER TABLE "ord_returns" ADD CONSTRAINT "ord_returns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ord_returns" ADD CONSTRAINT "ord_returns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ord_return_items" ADD CONSTRAINT "ord_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ord_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ord_return_items" ADD CONSTRAINT "ord_return_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "ord_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "log_supplier_payables" ADD CONSTRAINT "log_supplier_payables_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "log_supplier_payables" ADD CONSTRAINT "log_supplier_payables_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "ord_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
