-- Payroll: per-employee base salary, a stored breakdown per month, and one-off bonuses/deductions. Additive.

-- AlterTable
ALTER TABLE "sys_users" ADD COLUMN "base_salary_mnt" INTEGER;

-- AlterTable
ALTER TABLE "hr_payrolls" ADD COLUMN "ticket_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sales_amount_mnt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "ticket_bonus" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sales_bonus" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "worked_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "working_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "earned_base" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "adjustments_mnt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "gross_salary" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "social_insurance_mnt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "income_tax_mnt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "paid_at" TIMESTAMP(3),
ADD COLUMN "paid_by_id" TEXT;

-- CreateTable
CREATE TABLE "hr_payroll_adjustments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "period_month" TEXT NOT NULL,
    "amount_mnt" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_payroll_adjustments_user_id_period_month_idx" ON "hr_payroll_adjustments"("user_id", "period_month");

-- AddForeignKey
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
