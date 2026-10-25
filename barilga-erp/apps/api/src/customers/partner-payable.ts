import { Prisma } from '@prisma/client';

type Db = { accountEntry: { aggregate(args: { where: { customerId: string }; _sum: { amountMnt: true } }): Promise<{ _sum: { amountMnt: number | null } }> } };

/**
 * What we owe a partner: purchases minus our payments and offsets (positive = we owe them). The one place
 * this rule lives; pass a transaction client to read it inside a Serializable transaction.
 */
export async function partnerPayable(db: Db | Prisma.TransactionClient, customerId: string): Promise<number> {
  const agg = await (db as Db).accountEntry.aggregate({ where: { customerId }, _sum: { amountMnt: true } });
  return agg._sum.amountMnt ?? 0;
}
