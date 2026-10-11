ALTER TABLE "sys_users" ADD COLUMN "username" TEXT;
UPDATE "sys_users"
SET "username" = split_part(lower(COALESCE("email", id)), '@', 1)
WHERE "username" IS NULL;
ALTER TABLE "sys_users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "sys_users_username_key" ON "sys_users"("username");
ALTER TABLE "sys_users" ALTER COLUMN "email" DROP NOT NULL;
