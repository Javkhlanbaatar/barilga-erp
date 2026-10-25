-- AlterTable
ALTER TABLE "sys_users" ADD COLUMN     "google_email" TEXT,
ADD COLUMN     "google_sub" TEXT,
ADD COLUMN     "sessions_valid_from" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "sys_users_google_sub_key" ON "sys_users"("google_sub");

