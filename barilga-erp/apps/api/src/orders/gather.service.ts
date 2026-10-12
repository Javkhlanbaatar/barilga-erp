import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { FeaturesService } from '../features/features.service';
import { InventoryService } from '../inventory/inventory.service';
import { TransfersService } from '../inventory/transfers.service';
import { PrismaService } from '../prisma/prisma.service';
import { planFulfillment } from './fulfillment-plan';
import { planGather } from './gather-plan';

/**
 * Collecting one order's stock from several warehouses into the warehouse it ships from (its dispatch
 * warehouse, Order.warehouseId — the default warehouse for web orders).
 *
 * Gathering only creates ordinary stock transfers (linked to the order) into the dispatch warehouse, so the
 * existing completion, return and supplier-reconciliation logic, which all work on the dispatch warehouse,
 * stay exactly as they are. Sending takes the stock out of the source at once, so it cannot be sold there
 * while it is on its way.
 */
@Injectable()
export class GatherService {
  private readonly log = new Logger(GatherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly transfers: TransfersService,
    private readonly features: FeaturesService,
  ) {}

  /** Net quantities still to be handed over by other paid orders, per warehouse and product. */
  private async committedElsewhere(orderId: string, productIds: string[]) {
    const out = new Map<string, Prisma.Decimal>();
    if (!productIds.length) return out;
    const others = await this.prisma.order.findMany({
      where: { id: { not: orderId }, status: OrderStatus.READY_FOR_LOADING, items: { some: { productId: { in: productIds } } } },
      include: { items: true },
    });
    if (!others.length) return out;
    const fallback = await this.inventory.defaultWarehouseId();
    const returned = await this.prisma.returnItem.findMany({ where: { orderItem: { orderId: { in: others.map((o) => o.id) } } } });
    for (const o of others) {
      const wh = o.warehouseId ?? fallback;
      const mine = returned.filter((r) => o.items.some((i) => i.id === r.orderItemId));
      for (const d of planFulfillment(o.items, mine).deductions) {
        const key = `${wh}|${d.productId}`;
        out.set(key, (out.get(key) ?? new Prisma.Decimal(0)).plus(d.quantity));
      }
    }
    return out;
  }

  /** Read-only: what the order needs and where it would be collected from. */
  async plan(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    const dispatchWarehouseId = order.warehouseId ?? (await this.inventory.defaultWarehouseId());

    const returned = await this.prisma.returnItem.findMany({ where: { orderItem: { orderId } } });
    const needs = planFulfillment(order.items, returned).deductions.map((d) => ({
      productId: d.productId,
      quantity: d.quantity,
    }));
    const productIds = [...new Set(needs.map((n) => n.productId))];

    const [warehouses, balances, inTransit, products] = await Promise.all([
      this.prisma.warehouse.findMany({ where: { isActive: true } }),
      productIds.length
        ? this.prisma.stockBalance.findMany({ where: { productId: { in: productIds } } })
        : Promise.resolve([]),
      this.prisma.stockTransferItem.findMany({
        where: { transfer: { orderId, status: TransferStatus.IN_TRANSIT, toWarehouseId: dispatchWarehouseId } },
      }),
      productIds.length
        ? this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, nameMn: true, unit: true } })
        : Promise.resolve([]),
    ]);

    // Stock other paid orders will take out of a warehouse is not free to count for this one (stock only
    // leaves the ledger when an order is handed over).
    const committed = await this.committedElsewhere(orderId, productIds);
    const plan = planGather({
      dispatchWarehouseId,
      needs,
      balances: balances.map((b) => ({
        ...b,
        quantity: new Prisma.Decimal(b.quantity.toString()).minus(committed.get(`${b.warehouseId}|${b.productId}`) ?? 0),
      })),
      inTransitToDispatch: inTransit.map((i) => ({ productId: i.productId, quantity: new Prisma.Decimal(i.quantity.toString()) })),
      sourceWarehouseIds: warehouses.map((w) => w.id),
    });

    const wName = new Map(warehouses.map((w) => [w.id, { id: w.id, code: w.code, name: w.name }]));
    const product = new Map(products.map((p) => [p.id, p]));
    return {
      orderId,
      orderNumber: order.orderNumber,
      status: order.status,
      dispatchWarehouse: wName.get(dispatchWarehouseId) ?? { id: dispatchWarehouseId, code: '?', name: '?' },
      complete: plan.lines.every((l) => l.unavailable.isZero()),
      lines: plan.lines.map((l) => ({
        product: product.get(l.productId) ?? { id: l.productId },
        needed: Number(l.needed),
        atDispatch: Number(l.atDispatch),
        inTransit: Number(l.inTransit),
        toGather: Number(l.toGather),
        unavailable: Number(l.unavailable),
      })),
      transfers: plan.transfers.map((t) => ({
        from: wName.get(t.fromWarehouseId),
        items: t.items.map((i) => ({ product: product.get(i.productId) ?? { id: i.productId }, quantity: Number(i.quantity) })),
      })),
    };
  }

  /**
   * Creates the transfers from the plan. Only for paid orders that are waiting to be loaded. Safe to run
   * again: stock already in transit for this order is subtracted, so nothing is gathered twice.
   */
  async gather(orderId: string, user: AuthUser) {
    await this.features.assertEnabled('STOCK_TRANSFERS');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException('Only a paid order waiting for loading (READY_FOR_LOADING) can be gathered');
    }
    const plan = await this.plan(orderId);
    if (plan.transfers.length === 0) {
      throw new BadRequestException(
        plan.complete
          ? 'Nothing to gather: the dispatch warehouse already has (or is receiving) everything'
          : 'Nothing can be gathered: no other warehouse holds the missing stock',
      );
    }

    // One transfer per source warehouse, each in its own transaction (TransfersService.send). If stock
    // changes between planning and sending, that send fails and the earlier ones stand; running gather
    // again then plans only what is still missing.
    const created = [];
    for (const t of plan.transfers) {
      created.push(
        await this.transfers.send(
          {
            fromWarehouseId: t.from!.id,
            toWarehouseId: plan.dispatchWarehouse.id,
            items: t.items.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
            notes: `Gather for order ${plan.orderNumber}`,
          },
          user,
          { orderId },
        ),
      );
    }
    this.log.log(`Order ${plan.orderNumber}: ${created.length} gather transfer(s) by ${user.id}`);
    return { transfers: created, plan: await this.plan(orderId) };
  }
}
