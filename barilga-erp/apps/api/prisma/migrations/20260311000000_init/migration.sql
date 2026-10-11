-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH');
CREATE TYPE "ZoneCode" AS ENUM ('ZONE_A', 'ZONE_B', 'ZONE_RESORT', 'RURAL_TERMINAL');
CREATE TYPE "DeliveryMethod" AS ENUM ('OUR_DELIVERY', 'SELF_PICKUP', 'CUSTOMER_DRIVER');
CREATE TYPE "TimeCondition" AS ENUM ('STANDARD', 'NIGHT', 'EXPRESS');
CREATE TYPE "VehicleCode" AS ENUM ('PORTER', 'DUMP', 'MANIPULATOR');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'READY_FOR_LOADING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'FAILED', 'EXPIRED');

CREATE TABLE "sys_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sys_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sys_users_email_key" ON "sys_users"("email");

CREATE TABLE "log_delivery_zones" (
    "id" TEXT NOT NULL,
    "code" "ZoneCode" NOT NULL,
    "nameMn" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "baseDeliveryFeeMnt" INTEGER NOT NULL,
    "nightDiscountApplies" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "log_delivery_zones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "log_delivery_zones_code_key" ON "log_delivery_zones"("code");

CREATE TABLE "log_vehicles" (
    "id" TEXT NOT NULL,
    "code" "VehicleCode" NOT NULL,
    "nameMn" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "maxWeightKg" INTEGER NOT NULL,
    "maxLengthM" DECIMAL(10,2) NOT NULL,
    "maxVolumeM3" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "log_vehicles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "log_vehicles_code_key" ON "log_vehicles"("code");

CREATE TABLE "inv_products" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "nameMn" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "priceMnt" INTEGER NOT NULL,
    "weightKg" DECIMAL(12,3) NOT NULL,
    "lengthM" DECIMAL(10,2) NOT NULL,
    "volumeM3" DECIMAL(10,3) NOT NULL,
    "stockQty" DECIMAL(12,3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inv_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inv_products_sku_key" ON "inv_products"("sku");

CREATE TABLE "ord_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "zoneId" TEXT NOT NULL,
    "deliveryMethod" "DeliveryMethod" NOT NULL,
    "timeCondition" "TimeCondition" NOT NULL DEFAULT 'STANDARD',
    "unloadingRequested" BOOLEAN NOT NULL DEFAULT false,
    "totalWeightKg" DECIMAL(12,3) NOT NULL,
    "maxLengthM" DECIMAL(10,2) NOT NULL,
    "totalVolumeM3" DECIMAL(12,3) NOT NULL,
    "assignedVehicle" "VehicleCode",
    "subtotalMnt" INTEGER NOT NULL,
    "deliveryFeeMnt" INTEGER NOT NULL,
    "unloadingFeeMnt" INTEGER NOT NULL,
    "timeAdjustmentMnt" INTEGER NOT NULL,
    "totalMnt" INTEGER NOT NULL,
    "feesOverridden" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ord_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ord_orders_orderNumber_key" ON "ord_orders"("orderNumber");
CREATE INDEX "ord_orders_status_idx" ON "ord_orders"("status");
CREATE INDEX "ord_orders_orderNumber_idx" ON "ord_orders"("orderNumber");

CREATE TABLE "ord_order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "weightKg" DECIMAL(12,3) NOT NULL,
    "lengthM" DECIMAL(10,2) NOT NULL,
    "volumeM3" DECIMAL(10,3) NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    CONSTRAINT "ord_order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pay_qpay_invoices" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'QPAY',
    "status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "amountMnt" INTEGER NOT NULL,
    "qpayInvoiceId" TEXT,
    "qpayQrText" TEXT,
    "qpayQrImage" TEXT,
    "qpayPayload" JSONB,
    "paidAt" TIMESTAMP(3),
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "lastPollError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pay_qpay_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pay_qpay_invoices_orderId_key" ON "pay_qpay_invoices"("orderId");
CREATE INDEX "pay_qpay_invoices_status_nextPollAt_idx" ON "pay_qpay_invoices"("status", "nextPollAt");

CREATE TABLE "aud_fee_overrides" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousDeliveryFee" INTEGER NOT NULL,
    "previousUnloadingFee" INTEGER NOT NULL,
    "previousTimeAdj" INTEGER NOT NULL,
    "previousTotal" INTEGER NOT NULL,
    "newDeliveryFee" INTEGER NOT NULL,
    "newUnloadingFee" INTEGER NOT NULL,
    "newTimeAdj" INTEGER NOT NULL,
    "newTotal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aud_fee_overrides_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "log_delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ord_orders" ADD CONSTRAINT "ord_orders_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ord_order_items" ADD CONSTRAINT "ord_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ord_order_items" ADD CONSTRAINT "ord_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "inv_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pay_qpay_invoices" ADD CONSTRAINT "pay_qpay_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aud_fee_overrides" ADD CONSTRAINT "aud_fee_overrides_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ord_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aud_fee_overrides" ADD CONSTRAINT "aud_fee_overrides_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
