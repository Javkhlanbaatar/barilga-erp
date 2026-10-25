import { BadRequestException } from '@nestjs/common';

export const UB_TZ = 'Asia/Ulaanbaatar';

/** Today (or `date`) as YYYY-MM-DD in Ulaanbaatar time. */
export function ymdInUlaanbaatar(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date);
}

/** Start or end of a YYYY-MM-DD day in Ulaanbaatar (UTC+8, no DST). */
export function parseDayBound(ymd: string, endOfDay: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new BadRequestException('Dates must be YYYY-MM-DD');
  }
  const iso = endOfDay ? `${ymd}T23:59:59.999+08:00` : `${ymd}T00:00:00.000+08:00`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid date');
  return parsed;
}
