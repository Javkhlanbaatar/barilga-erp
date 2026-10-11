CREATE TYPE "AttendanceStatus" AS ENUM ('ON_TIME', 'LATE', 'OVERTIME');
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'PAID');

CREATE TABLE "hr_attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkIn" TIMESTAMP(3) NOT NULL,
    "checkOut" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ON_TIME',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_attendance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hr_attendance_userId_checkIn_idx" ON "hr_attendance"("userId", "checkIn");
ALTER TABLE "hr_attendance" ADD CONSTRAINT "hr_attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "hr_payrolls" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period_month" TEXT NOT NULL,
    "base_salary" INTEGER NOT NULL,
    "fulfillment_bonus" INTEGER NOT NULL,
    "net_salary" INTEGER NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_payrolls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hr_payrolls_userId_period_month_key" ON "hr_payrolls"("userId", "period_month");
CREATE INDEX "hr_payrolls_period_month_idx" ON "hr_payrolls"("period_month");
ALTER TABLE "hr_payrolls" ADD CONSTRAINT "hr_payrolls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
