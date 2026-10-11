import { Prisma } from '@prisma/client';

type Dec = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export type GatherNeed = { productId: string; quantity: Dec };
export type GatherBalance = { warehouseId: string; productId: string; quantity: Dec };

export type GatherPlan = {
  /** One transfer per source warehouse: what to send to the dispatch warehouse. */
  transfers: Array<{ fromWarehouseId: string; items: Array<{ productId: string; quantity: Dec }> }>;
  /** Per product: what the order needs, what is already at / on its way to the dispatch warehouse, what is missing. */
  lines: Array<{ productId: string; needed: Dec; atDispatch: Dec; inTransit: Dec; toGather: Dec; unavailable: Dec }>;
};

/**
 * Works out how to collect an order's stock at its dispatch warehouse from the other warehouses.
 *
 * Shortfall = needed − (stock already at dispatch) − (stock already in transit to dispatch for this order).
 * Each shortfall is taken from the other warehouses holding the most of that product first, so the order is
 * collected from as few places as possible. Whatever no warehouse holds is reported as `unavailable`
 * (it needs a supplier or a purchase; the plan never sends stock a warehouse does not have).
 */
export function planGather(input: {
  dispatchWarehouseId: string;
  needs: GatherNeed[];
  balances: GatherBalance[];
  inTransitToDispatch: Array<{ productId: string; quantity: Dec }>;
  /** Warehouses allowed to send (active, not the dispatch warehouse). */
  sourceWarehouseIds: string[];
}): GatherPlan {
  const sum = (rows: Array<{ productId: string; quantity: Dec }>, productId: string) =>
    rows.filter((r) => r.productId === productId).reduce((s, r) => s.plus(r.quantity), ZERO);

  const needed = new Map<string, Dec>();
  for (const n of input.needs) needed.set(n.productId, (needed.get(n.productId) ?? ZERO).plus(n.quantity));

  const sources = new Set(input.sourceWarehouseIds.filter((id) => id !== input.dispatchWarehouseId));
  const byWarehouse = new Map<string, Map<string, Dec>>();
  const lines: GatherPlan['lines'] = [];

  for (const [productId, need] of needed) {
    const atDispatch = Prisma.Decimal.max(
      ZERO,
      sum(input.balances.filter((b) => b.warehouseId === input.dispatchWarehouseId), productId),
    );
    const inTransit = sum(input.inTransitToDispatch, productId);
    let shortfall = Prisma.Decimal.max(ZERO, need.minus(atDispatch).minus(inTransit));
    let toGather = ZERO;

    const candidates = input.balances
      .filter((b) => b.productId === productId && sources.has(b.warehouseId) && b.quantity.gt(0))
      .sort((a, b) => b.quantity.comparedTo(a.quantity) || a.warehouseId.localeCompare(b.warehouseId));
    for (const c of candidates) {
      if (shortfall.lte(0)) break;
      const take = Prisma.Decimal.min(shortfall, c.quantity);
      const items = byWarehouse.get(c.warehouseId) ?? new Map<string, Dec>();
      items.set(productId, (items.get(productId) ?? ZERO).plus(take));
      byWarehouse.set(c.warehouseId, items);
      shortfall = shortfall.minus(take);
      toGather = toGather.plus(take);
    }
    lines.push({ productId, needed: need, atDispatch, inTransit, toGather, unavailable: shortfall });
  }

  const transfers = [...byWarehouse.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fromWarehouseId, items]) => ({
      fromWarehouseId,
      items: [...items.entries()].map(([productId, quantity]) => ({ productId, quantity })),
    }));
  return { transfers, lines };
}
