import { Prisma } from '@prisma/client';
import { matchesSearch } from '../common/translit';

export function productSearchTerm(q?: string, search?: string) {
  return (q ?? search ?? '').trim();
}

/** Plain ILIKE match (ASCII case folding only on C-locale databases); prefer {@link productSearchFilter}. */
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

type ProductDb = {
  product: { findMany(args: { select: { id: true; sku: true; nameMn: true; nameEn: true; description: true } }): Promise<Array<{ id: string; sku: string; nameMn: string; nameEn: string; description: string | null }>> };
};

/**
 * Matches code, names and description in either alphabet ("tsement", "cement", "цемент" all find "Цемент"),
 * case-insensitively for every script. The catalog is small enough to compare in memory, which also keeps
 * the rule identical to the POS grid filter (both use matchesSearch).
 */
export async function productSearchFilter(db: ProductDb, raw?: string): Promise<Prisma.ProductWhereInput | undefined> {
  const q = raw?.trim();
  if (!q) return undefined;
  const rows = await db.product.findMany({ select: { id: true, sku: true, nameMn: true, nameEn: true, description: true } });
  const ids = rows.filter((p) => matchesSearch([p.sku, p.nameMn, p.nameEn, p.description ?? ''].join(' '), q)).map((p) => p.id);
  return { id: { in: ids } };
}
