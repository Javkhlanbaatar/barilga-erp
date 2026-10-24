-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('MANAGER', 'SELF', 'FIX', 'AUTO_CLOSE');

-- CreateEnum
CREATE TYPE "DayMark" AS ENUM ('PAID_LEAVE', 'UNPAID_LEAVE', 'SICK', 'ANNUAL_LEAVE', 'BUSINESS_TRIP', 'ABSENT', 'DAY_OFF');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "hr_attendance" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_by_id" TEXT,
ADD COLUMN     "recorded_by_id" TEXT,
ADD COLUMN     "source" "AttendanceSource" NOT NULL DEFAULT 'MANAGER',
ADD COLUMN     "warehouse_id" TEXT;

-- CreateTable
CREATE TABLE "hr_attendance_days" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "mark" "DayMark" NOT NULL,
    "note" TEXT,
    "request_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "DayMark" NOT NULL,
    "from_date" TEXT NOT NULL,
    "to_date" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "warehouse_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_price_shares" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "price_list_id" TEXT,
    "product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "include_unlisted" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" DATE,
    "revoked_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_price_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_attendance_days_date_idx" ON "hr_attendance_days"("date");

-- CreateIndex
CREATE UNIQUE INDEX "hr_attendance_days_user_id_date_key" ON "hr_attendance_days"("user_id", "date");

-- CreateIndex
CREATE INDEX "hr_leave_requests_status_warehouse_id_idx" ON "hr_leave_requests"("status", "warehouse_id");

-- CreateIndex
CREATE INDEX "hr_leave_requests_user_id_from_date_idx" ON "hr_leave_requests"("user_id", "from_date");

-- CreateIndex
CREATE UNIQUE INDEX "crm_price_shares_token_key" ON "crm_price_shares"("token");

-- CreateIndex
CREATE INDEX "crm_price_shares_price_list_id_idx" ON "crm_price_shares"("price_list_id");

-- AddForeignKey
ALTER TABLE "hr_attendance_days" ADD CONSTRAINT "hr_attendance_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_attendance_days" ADD CONSTRAINT "hr_attendance_days_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_price_shares" ADD CONSTRAINT "crm_price_shares_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "crm_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_price_shares" ADD CONSTRAINT "crm_price_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Links already sent keep working: each list's link becomes a share of the whole list (listed products only,
-- no end date — exactly what the link showed before). The old column stays for now and is no longer used.
INSERT INTO "crm_price_shares" ("id", "token", "price_list_id", "include_unlisted")
SELECT gen_random_uuid()::text, "share_token", "id", false
FROM "crm_price_lists" WHERE "share_token" IS NOT NULL;
