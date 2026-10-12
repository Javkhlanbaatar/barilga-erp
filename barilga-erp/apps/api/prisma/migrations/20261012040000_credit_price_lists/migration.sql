-- Credit sales (goods released on account: PayMethod CREDIT), customer price lists, unique customer email
-- (future online-shop login). Additive: a new enum value, new tables, nullable columns, a unique index on a
-- column of a table introduced in this release.

-- AlterEnum
ALTER TYPE "PayMethod" ADD VALUE 'CREDIT';

-- AlterTable
ALTER TABLE "ord_orders" ADD COLUMN     "price_list_id" TEXT;

-- AlterTable
ALTER TABLE "crm_customers" ADD COLUMN     "price_list_id" TEXT;

-- CreateTable
CREATE TABLE "crm_price_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_price_list_items" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "price_mnt" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_price_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_price_lists_name_key" ON "crm_price_lists"("name");

-- CreateIndex
CREATE UNIQUE INDEX "crm_price_list_items_price_list_id_product_id_key" ON "crm_price_list_items"("price_list_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_customers_email_key" ON "crm_customers"("email");

-- AddForeignKey
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "crm_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_customers" ADD CONSTRAINT "crm_customers_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "crm_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_price_list_items" ADD CONSTRAINT "crm_price_list_items_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "crm_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_price_list_items" ADD CONSTRAINT "crm_price_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard the application also enforces.
ALTER TABLE "crm_price_list_items" ADD CONSTRAINT "crm_price_list_items_price_not_negative" CHECK ("price_mnt" >= 0);
