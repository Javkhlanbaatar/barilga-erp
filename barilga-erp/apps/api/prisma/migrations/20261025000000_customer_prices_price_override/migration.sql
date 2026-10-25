-- AlterTable
ALTER TABLE "ord_order_items" ADD COLUMN     "list_price_mnt" INTEGER;

-- CreateTable
CREATE TABLE "crm_customer_prices" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "price_mnt" INTEGER NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_customer_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_customer_prices_product_id_idx" ON "crm_customer_prices"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_customer_prices_customer_id_product_id_key" ON "crm_customer_prices"("customer_id", "product_id");

-- AddForeignKey
ALTER TABLE "crm_customer_prices" ADD CONSTRAINT "crm_customer_prices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_customer_prices" ADD CONSTRAINT "crm_customer_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

