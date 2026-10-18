-- Barcode scanned at the till (manufacturer EAN/UPC or an in-store 200… EAN-13).
ALTER TABLE "inv_products" ADD COLUMN "barcode" TEXT;
CREATE UNIQUE INDEX "inv_products_barcode_key" ON "inv_products"("barcode");
