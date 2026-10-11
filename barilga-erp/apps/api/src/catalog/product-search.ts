import { Prisma } from '@prisma/client';

export function productSearchTerm(q?: string, search?: string) {
  return (q ?? search ?? '').trim();
}

/** Case-insensitive OR match across sku/code, names, and description. */
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
