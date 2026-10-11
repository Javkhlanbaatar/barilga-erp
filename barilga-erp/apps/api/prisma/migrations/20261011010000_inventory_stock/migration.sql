-- Rename stock column and add low-stock threshold on inv_products.
ALTER TABLE "inv_products" RENAME COLUMN "stockQty" TO "stock_quantity";
ALTER TABLE "inv_products" ADD COLUMN "min_stock_level" DECIMAL(12,3) NOT NULL DEFAULT 0;
