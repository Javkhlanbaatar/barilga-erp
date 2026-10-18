-- Price list sheet: validity date and a read-only link for the customer.
ALTER TABLE "crm_price_lists" ADD COLUMN "valid_until" DATE;
ALTER TABLE "crm_price_lists" ADD COLUMN "share_token" TEXT;
CREATE UNIQUE INDEX "crm_price_lists_share_token_key" ON "crm_price_lists"("share_token");
