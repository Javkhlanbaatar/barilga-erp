-- Rights added to or taken from one person on top of their role.
ALTER TABLE "sys_users" ADD COLUMN "permissions" JSONB;

-- Base salary from a month on, so changing a salary never rewrites earlier months.
CREATE TABLE "hr_salary_rates" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "from_month" TEXT NOT NULL,
    "base_salary_mnt" INTEGER,
    "reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_salary_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hr_salary_rates_user_id_from_month_key" ON "hr_salary_rates"("user_id", "from_month");
ALTER TABLE "hr_salary_rates" ADD CONSTRAINT "hr_salary_rates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_salary_rates" ADD CONSTRAINT "hr_salary_rates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Salaries set before keep applying to every month, exactly as they did.
INSERT INTO "hr_salary_rates" ("id", "user_id", "from_month", "base_salary_mnt", "reason", "created_by_id")
SELECT gen_random_uuid()::text, "id", '2000-01', "base_salary_mnt", 'Өмнө тогтоосон үндсэн цалин', "id"
FROM "sys_users" WHERE "base_salary_mnt" IS NOT NULL;

-- Product size: width and height; volume kept to 6 decimals (small items no longer round to 0).
ALTER TABLE "inv_products" ADD COLUMN "width_m" DECIMAL(10,2);
ALTER TABLE "inv_products" ADD COLUMN "height_m" DECIMAL(10,2);
ALTER TABLE "inv_products" ALTER COLUMN "volumeM3" SET DATA TYPE DECIMAL(14,6);
ALTER TABLE "ord_order_items" ALTER COLUMN "volumeM3" SET DATA TYPE DECIMAL(14,6);
ALTER TABLE "ord_orders" ALTER COLUMN "totalVolumeM3" SET DATA TYPE DECIMAL(14,6);
