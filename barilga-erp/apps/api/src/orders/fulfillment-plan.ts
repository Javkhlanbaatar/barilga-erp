import { Prisma, SourceType } from '@prisma/client';

type Dec = Prisma.Decimal | string | number;

export type PlanItem = {
  id: string;
  productId: string;
  quantity: Dec;
  lineTotal: number;
  sourceType: SourceType | string;
  supplierName: string | null;
};

export type PlanReturn = { orderItemId: string; quantity: Dec; lineRefund: number };

export type FulfillmentPlan = {
  /** What actually leaves the warehouse: ordered quantity minus anything already returned. */
  deductions: Array<{ productId: string; quantity: Prisma.Decimal; sourceType: SourceType | string }>;
  /** Supplier payables for external lines, net of returned quantity/refund. */
  payables: Array<{ orderItemId: string; supplierName: string; quantity: Prisma.Decimal; amountMnt: number }>;
};

/**
 * Returns recorded while an order was still READY_FOR_LOADING never had stock deducted, so completing the
 * order must only deduct the net quantity. Returns recorded after COMPLETED already restore stock in the
 * return flow, which is consistent because the completion deducted the net quantity too.
 */
export function planFulfillment(items: PlanItem[], returns: PlanReturn[]): FulfillmentPlan {
  const returnedQty = new Map<string, Prisma.Decimal>();
  const returnedMoney = new Map<string, number>();
  for (const r of returns) {
    returnedQty.set(
      r.orderItemId,
      (returnedQty.get(r.orderItemId) ?? new Prisma.Decimal(0)).plus(new Prisma.Decimal(r.quantity.toString())),
    );
    returnedMoney.set(r.orderItemId, (returnedMoney.get(r.orderItemId) ?? 0) + r.lineRefund);
  }

  const plan: FulfillmentPlan = { deductions: [], payables: [] };
  for (const item of items) {
    const remaining = new Prisma.Decimal(item.quantity.toString()).minus(returnedQty.get(item.id) ?? 0);
    if (remaining.lte(0)) continue;
    if (item.sourceType === SourceType.EXTERNAL_SUPPLIER) {
      plan.payables.push({
        orderItemId: item.id,
        supplierName: item.supplierName?.trim() || 'Өөр дэлгүүр',
        quantity: remaining,
        amountMnt: Math.max(0, item.lineTotal - (returnedMoney.get(item.id) ?? 0)),
      });
    } else {
      plan.deductions.push({ productId: item.productId, quantity: remaining, sourceType: item.sourceType });
    }
  }
  return plan;
}
