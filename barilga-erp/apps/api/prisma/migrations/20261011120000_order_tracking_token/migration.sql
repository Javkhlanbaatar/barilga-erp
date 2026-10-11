ALTER TABLE "ord_orders" ADD COLUMN "tracking_token" TEXT;
UPDATE "ord_orders" SET "tracking_token" = replace(gen_random_uuid()::text, '-', '') WHERE "tracking_token" IS NULL;
ALTER TABLE "ord_orders" ALTER COLUMN "tracking_token" SET NOT NULL;
CREATE UNIQUE INDEX "ord_orders_tracking_token_key" ON "ord_orders"("tracking_token");
