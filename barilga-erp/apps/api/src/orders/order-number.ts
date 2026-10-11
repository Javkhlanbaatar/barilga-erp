import { ConflictException } from '@nestjs/common';

const UB_TZ = 'Asia/Ulaanbaatar';
const MAX_ATTEMPTS = 50;

/** YYYYMMDD in Ulaanbaatar time, independent of the server's own timezone. */
export function ulaanbaatarYmd(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date).replaceAll('-', '');
}

export function isOrderNumberConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes('orderNumber'));
  return String(target ?? '').includes('orderNumber');
}

/**
 * Allocates BR-YYYYMMDD-NNNN and creates the order with it.
 *
 * The number is only a *candidate*: `orderNumber` has a UNIQUE constraint, and that constraint (not the
 * count) is what guarantees uniqueness. When two requests race for the same candidate the loser gets a
 * unique violation, shifts to the next candidate and retries. Format is unchanged, so existing orders and
 * the BR-YYYYMMDD prefix keep working.
 */
export async function createWithUniqueOrderNumber<T>(
  prisma: { order: { count(args: { where: { orderNumber: { startsWith: string } } }): Promise<number> } },
  create: (orderNumber: string) => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const prefix = `BR-${ulaanbaatarYmd(now)}-`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await prisma.order.count({ where: { orderNumber: { startsWith: prefix } } });
    const orderNumber = `${prefix}${String(existing + 1 + attempt).padStart(4, '0')}`;
    try {
      return await create(orderNumber);
    } catch (err) {
      if (!isOrderNumberConflict(err)) throw err;
    }
  }
  throw new ConflictException('Could not allocate an order number; please retry');
}
