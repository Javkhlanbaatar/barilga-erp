-- Partner ledger: receivable-side entries, payment method on money lines, purchases by supplier.
ALTER TYPE "AccountEntryKind" ADD VALUE IF NOT EXISTS 'CHARGE';
ALTER TYPE "AccountEntryKind" ADD VALUE IF NOT EXISTS 'PAYMENT_FROM_PARTNER';
ALTER TABLE "crm_account_entries" ADD COLUMN "method" "PayMethod";
CREATE INDEX "inv_stock_receipts_supplier_customer_id_received_at_idx" ON "inv_stock_receipts"("supplier_customer_id", "received_at");
