import { ConflictException } from '@nestjs/common';

const UB_TZ = 'Asia/Ulaanbaatar';
const MAX_ATTEMPTS = 50;

/** YYYYMMDD in Ulaanbaatar time, independent of the server's own timezone. */
export function ulaanbaatarYmd(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date).replaceAll('-', '');
}

/** True when `err` is a unique violation on a column whose name contains `field`. */
export function isUniqueConflictOn(err: unknown, field: string): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(field));
  return String(target ?? '').includes(field);
}

export function isOrderNumberConflict(err: unknown): boolean {
  return isUniqueConflictOn(err, 'orderNumber');
}

/**
 * Allocates `<prefix>NNNN` (counting rows that already use today's prefix) and creates the row with it,
 * moving to the next candidate whenever the UNIQUE constraint rejects one. Same scheme as order numbers.
 */
export async function createWithUniqueNumber<T>(opts: {
  prefix: string;
  countExisting: (prefix: string) => Promise<number>;
  create: (number: string) => Promise<T>;
  isConflict: (err: unknown) => boolean;
  label: string;
}): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await opts.countExisting(opts.prefix);
    const number = `${opts.prefix}${String(existing + 1 + attempt).padStart(4, '0')}`;
    try {
      return await opts.create(number);
    } catch (err) {
      if (!opts.isConflict(err)) throw err;
    }
  }
  throw new ConflictException(`Could not allocate ${opts.label}; please retry`);
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
  return createWithUniqueNumber({
    prefix: `BR-${ulaanbaatarYmd(now)}-`,
    countExisting: (prefix) => prisma.order.count({ where: { orderNumber: { startsWith: prefix } } }),
    create,
    isConflict: isOrderNumberConflict,
    label: 'an order number',
  });
}
