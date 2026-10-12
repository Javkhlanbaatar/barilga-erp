-- Invoices sent to buyers (one per order) with a public read-only link. Additive only.

-- CreateTable
CREATE TABLE "ord_invoices" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "token" TEXT NOT NULL,
    "recipient_email" TEXT,
    "recipient_phone" TEXT,
    "due_date" TIMESTAMP(3),
    "note" TEXT,
    "last_sent_via" TEXT,
    "sent_at" TIMESTAMP(3),
    "send_count" INTEGER NOT NULL DEFAULT 0,
    "viewed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ord_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ord_invoices_invoice_number_key" ON "ord_invoices"("invoice_number");
CREATE UNIQUE INDEX "ord_invoices_order_id_key" ON "ord_invoices"("order_id");
CREATE UNIQUE INDEX "ord_invoices_token_key" ON "ord_invoices"("token");
CREATE INDEX "ord_invoices_customer_id_idx" ON "ord_invoices"("customer_id");
CREATE INDEX "ord_invoices_createdAt_idx" ON "ord_invoices"("createdAt");

-- AddForeignKey
ALTER TABLE "ord_invoices" ADD CONSTRAINT "ord_invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ord_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ord_invoices" ADD CONSTRAINT "ord_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ord_invoices" ADD CONSTRAINT "ord_invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
