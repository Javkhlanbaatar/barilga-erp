-- Bank transfer and offset payment methods, partner kinds on customers, the two-way partner account
-- (crm_account_entries), supplier partner on goods receipts, and an audit of later money edits. Additive only.

-- CreateEnum
CREATE TYPE "AccountEntryKind" AS ENUM ('PURCHASE', 'PAYMENT_TO_PARTNER', 'OFFSET', 'ADJUSTMENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayMethod" ADD VALUE 'TRANSFER';
ALTER TYPE "PayMethod" ADD VALUE 'OFFSET';

-- AlterTable
ALTER TABLE "crm_customers" ADD COLUMN     "barter_contract" TEXT,
ADD COLUMN     "buys_from_us" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "credit_allowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sells_to_us" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "inv_stock_receipts" ADD COLUMN     "supplier_customer_id" TEXT;

-- CreateTable
CREATE TABLE "crm_account_entries" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" "AccountEntryKind" NOT NULL,
    "amount_mnt" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_account_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aud_edits" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aud_edits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_account_entries_customer_id_occurred_at_idx" ON "crm_account_entries"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "crm_account_entries_ref_type_ref_id_idx" ON "crm_account_entries"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "aud_edits_entity_type_entity_id_idx" ON "aud_edits"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "aud_edits_createdAt_idx" ON "aud_edits"("createdAt");

-- AddForeignKey
ALTER TABLE "inv_stock_receipts" ADD CONSTRAINT "inv_stock_receipts_supplier_customer_id_fkey" FOREIGN KEY ("supplier_customer_id") REFERENCES "crm_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_account_entries" ADD CONSTRAINT "crm_account_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_account_entries" ADD CONSTRAINT "crm_account_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aud_edits" ADD CONSTRAINT "aud_edits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

