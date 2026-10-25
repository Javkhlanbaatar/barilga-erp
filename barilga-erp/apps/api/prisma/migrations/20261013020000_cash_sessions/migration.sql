-- Cash register sessions (open with a counted float, cash in/out, close with a count). Additive only.

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "CashMovementKind" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_float_mnt" INTEGER NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by_id" TEXT,
    "expected_cash_mnt" INTEGER,
    "counted_cash_mnt" INTEGER,
    "difference_mnt" INTEGER,
    "closing_note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_sessions_float_not_negative" CHECK ("opening_float_mnt" >= 0)
);

CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind" "CashMovementKind" NOT NULL,
    "amount_mnt" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_movements_positive" CHECK ("amount_mnt" > 0)
);

-- CreateIndex
CREATE INDEX "cash_sessions_user_id_status_idx" ON "cash_sessions"("user_id", "status");
CREATE INDEX "cash_sessions_opened_at_idx" ON "cash_sessions"("opened_at");
-- At most one open drawer per cashier.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_user" ON "cash_sessions"("user_id") WHERE "status" = 'OPEN';
CREATE INDEX "cash_movements_session_id_idx" ON "cash_movements"("session_id");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "sys_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "sys_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
