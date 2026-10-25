import { BadRequestException } from '@nestjs/common';
import { CashMovementKind, CashSessionStatus } from '@prisma/client';
import { FEATURES } from '../features/feature-flags';

type Db = {
  featureFlag: { findUnique(args: { where: { key: string } }): Promise<{ enabled: boolean } | null> };
  cashSession: { findFirst(args: { where: { userId: string; status: CashSessionStatus } }): Promise<{ id: string } | null> };
};

/**
 * Cash may only be taken (or handed back) by someone with an open drawer, so every tugrik lands in a shift
 * that is counted at the end. Switching the CASH_SESSIONS module off removes the rule.
 */
export async function assertCashDrawerOpen(db: Db, userId: string) {
  const flag = await db.featureFlag.findUnique({ where: { key: 'CASH_SESSIONS' } });
  const on = flag ? flag.enabled : FEATURES.CASH_SESSIONS.default;
  if (!on) return;
  const open = await db.cashSession.findFirst({ where: { userId, status: CashSessionStatus.OPEN } });
  if (!open) {
    throw new BadRequestException('Касс нээгээгүй байна: бэлэн мөнгө авахын өмнө «Касс нээх» дарна уу / Open the cash drawer first');
  }
}

type MoveDb = {
  cashSession: { findFirst(args: { where: { userId: string; status: CashSessionStatus } }): Promise<{ id: string } | null> };
  cashMovement: { create(args: { data: { sessionId: string; kind: CashMovementKind; amountMnt: number; reason: string; createdById: string } }): Promise<unknown> };
};

/**
 * Cash that leaves or enters the drawer outside a sale (paying a supplier, a partner's advance): written as a
 * drawer movement of the person's open shift so the end-of-shift count still matches. No open shift (module
 * off) = nothing to record.
 */
export async function recordDrawerMovement(db: MoveDb, userId: string, kind: CashMovementKind, amountMnt: number, reason: string) {
  const open = await db.cashSession.findFirst({ where: { userId, status: CashSessionStatus.OPEN } });
  if (!open || amountMnt <= 0) return false;
  await db.cashMovement.create({ data: { sessionId: open.id, kind, amountMnt, reason: reason.slice(0, 200), createdById: userId } });
  return true;
}
