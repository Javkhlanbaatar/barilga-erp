import { BadRequestException } from '@nestjs/common';
import { CashSessionStatus } from '@prisma/client';
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
