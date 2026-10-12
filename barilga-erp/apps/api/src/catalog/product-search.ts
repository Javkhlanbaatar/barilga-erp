import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const log = new Logger('ProductSearch');

export function productSearchTerm(q?: string, search?: string) {
  return (q ?? search ?? '').trim();
}

/**
 * Case-insensitive OR match across sku/code, names, and description, using Postgres ILIKE.
 * ILIKE folds case by the database locale: on a database created with the C locale it only folds ASCII, so
 * "хөөсөн" does not find "Хөөсөн". Prefer {@link productSearchFilter}, which handles Cyrillic everywhere.
 */
export function productSearchWhere(raw?: string): Prisma.ProductWhereInput | undefined {
  const q = raw?.trim();
  if (!q) return undefined;
  return {
    OR: [
      { sku: { contains: q, mode: 'insensitive' } },
      { nameMn: { contains: q, mode: 'insensitive' } },
      { nameEn: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ],
  };
}

/** Escapes LIKE wildcards so a typed "%" or "_" is matched literally. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

let icuUnavailable = false;

type RawDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> };

/**
 * Same match as {@link productSearchWhere}, but case-insensitive for Cyrillic regardless of the database
 * locale: the text is lower-cased with the ICU root collation ("und-x-icu"), which folds every script.
 * If the server has no ICU collation it falls back to ILIKE (and stops trying).
 */
export async function productSearchFilter(db: RawDb, raw?: string): Promise<Prisma.ProductWhereInput | undefined> {
  const q = raw?.trim();
  if (!q) return undefined;
  if (icuUnavailable) return productSearchWhere(q);
  const pattern = `%${escapeLike(q)}%`;
  try {
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "inv_products"
      WHERE lower(concat_ws(' ', "sku", "nameMn", "nameEn", "description") COLLATE "und-x-icu")
            LIKE lower(${pattern} COLLATE "und-x-icu")`);
    return { id: { in: rows.map((r) => r.id) } };
  } catch (err) {
    const code = (err as { meta?: { code?: string }; code?: string }).meta?.code;
    const message = String((err as Error)?.message ?? '');
    if (code === '42704' || /collation .*und-x-icu/i.test(message)) {
      icuUnavailable = true;
      log.warn('ICU collation "und-x-icu" is not available; product search falls back to ILIKE (ASCII-only case folding on C-locale databases)');
      return productSearchWhere(q);
    }
    throw err;
  }
}
