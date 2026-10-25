import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { OrderStatus, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { FeaturesService } from '../features/features.service';
import { isManagerRole, orderWarehouseWhere, seesAllWarehouses, warehouseWhere } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

/** YYYY-MM-DD → start / end of that day in Ulaanbaatar; nothing = unbounded. */
export function dayRange(from?: string, to?: string) {
  const ok = (d?: string) => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const gte = ok(from) ? new Date(`${from}T00:00:00.000+08:00`) : undefined;
  const lte = ok(to) ? new Date(`${to}T23:59:59.999+08:00`) : undefined;
  if (gte && lte && lte < gte) throw new BadRequestException('endDate must be on or after startDate');
  return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
}

/** How a sale was settled, for the trade view: real money, still owed, or taken off what we owed them. */
const MONEY: PayMethod[] = [PayMethod.CASH, PayMethod.CARD, PayMethod.QPAY, PayMethod.TRANSFER];

/**
 * Худалдаа / худалдан авалт with one partner: what we sold them (orders with their goods, how each was paid,
 * returns) and what we bought from them (goods receipts with quantity × cost) in a period. Sales follow the
 * user's warehouses; purchases (costs) are for managers only.
 */
@Injectable()
export class PartnerTradeService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly features?: FeaturesService,
  ) {}

  async trade(customerId: string, range: { from?: string; to?: string }, user: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
    if (!customer) throw new NotFoundException('Customer not found');
    const when = dayRange(range.from, range.to);
    const def = seesAllWarehouses(user) ? null : (await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id;
    const scope: Prisma.OrderWhereInput = seesAllWarehouses(user) ? {} : orderWarehouseWhere(user, def);
    const showPurchases = isManagerRole(user.role) && (!this.features || (await this.features.isEnabled('STOCK_RECEIPTS')));

    const [orders, receipts] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          AND: [scope],
          customerId,
          status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] },
          ...(when ? { createdAt: when } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          status: true,
          totalMnt: true,
          warehouse: { select: { name: true } },
          items: { select: { quantity: true, unitPrice: true, lineTotal: true, product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
          payments: { select: { method: true, status: true, amountMnt: true } },
          returns: { select: { refundAmount: true, refundMethod: true, createdAt: true } },
        },
      }),
      showPurchases
        ? this.prisma.stockReceipt.findMany({
            // Same rule as the receipts page: a branch manager sees the receipts of their own warehouses.
            where: { AND: [warehouseWhere(user) as Prisma.StockReceiptWhereInput], supplierCustomerId: customerId, ...(when ? { receivedAt: when } : {}) },
            orderBy: { receivedAt: 'desc' },
            take: 500,
            select: {
              id: true,
              receiptNumber: true,
              receivedAt: true,
              supplierInvoiceNo: true,
              warehouse: { select: { name: true } },
              items: { select: { id: true, quantity: true, unitCostMnt: true, product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
            },
          })
        : Promise.resolve([]),
    ]);

    const sales = orders.map((o) => {
      const paid = o.payments.filter((p) => p.status === PaymentStatus.PAID);
      const moneyMnt = paid.filter((p) => MONEY.includes(p.method)).reduce((s, p) => s + p.amountMnt, 0);
      const offsetMnt = paid.filter((p) => p.method === PayMethod.OFFSET).reduce((s, p) => s + p.amountMnt, 0);
      const owedMnt = o.payments
        .filter((p) => p.method === PayMethod.CREDIT && p.status === PaymentStatus.UNPAID)
        .reduce((s, p) => s + p.amountMnt, 0);
      const returnedMnt = o.returns.reduce((s, r) => s + r.refundAmount, 0);
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        at: o.createdAt,
        status: o.status,
        warehouse: o.warehouse?.name ?? null,
        totalMnt: o.totalMnt,
        moneyMnt,
        offsetMnt,
        owedMnt,
        returnedMnt,
        items: o.items.map((i) => ({ ...i.product, quantity: Number(i.quantity), unitPrice: i.unitPrice, lineTotal: i.lineTotal })),
      };
    });
    const purchases = receipts.map((r) => {
      const lines = r.items.map((i) => ({
        ...i.product,
        itemId: i.id,
        quantity: Number(i.quantity),
        unitCostMnt: i.unitCostMnt,
        lineMnt: i.unitCostMnt == null ? null : Math.round(Number(i.quantity) * i.unitCostMnt),
      }));
      return {
        id: r.id,
        receiptNumber: r.receiptNumber,
        at: r.receivedAt,
        warehouse: r.warehouse.name,
        supplierInvoiceNo: r.supplierInvoiceNo,
        totalMnt: lines.reduce((s, l) => s + (l.lineMnt ?? 0), 0),
        unpricedLines: lines.filter((l) => l.lineMnt == null).length,
        items: lines,
      };
    });

    // Goods per product in both directions, for "what do we trade with them".
    const goods = new Map<string, { id: string; sku: string; nameMn: string; unit: string; soldQty: number; soldMnt: number; boughtQty: number; boughtMnt: number }>();
    const g = (p: { id: string; sku: string; nameMn: string; unit: string }) => {
      let row = goods.get(p.id);
      if (!row) goods.set(p.id, (row = { id: p.id, sku: p.sku, nameMn: p.nameMn, unit: p.unit, soldQty: 0, soldMnt: 0, boughtQty: 0, boughtMnt: 0 }));
      return row;
    };
    for (const s of sales) for (const i of s.items) Object.assign(g(i), { soldQty: g(i).soldQty + i.quantity, soldMnt: g(i).soldMnt + i.lineTotal });
    for (const p of purchases) for (const i of p.items) Object.assign(g(i), { boughtQty: g(i).boughtQty + i.quantity, boughtMnt: g(i).boughtMnt + (i.lineMnt ?? 0) });

    const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
    return {
      customer,
      range: { from: range.from ?? null, to: range.to ?? null },
      purchasesShown: showPurchases,
      totals: {
        salesCount: sales.length,
        salesMnt: sum(sales, (s) => s.totalMnt),
        returnedMnt: sum(sales, (s) => s.returnedMnt),
        netSalesMnt: sum(sales, (s) => s.totalMnt - s.returnedMnt),
        moneyMnt: sum(sales, (s) => s.moneyMnt),
        offsetMnt: sum(sales, (s) => s.offsetMnt),
        owedMnt: sum(sales, (s) => s.owedMnt),
        purchasesCount: purchases.length,
        purchasesMnt: sum(purchases, (p) => p.totalMnt),
        unpricedLines: sum(purchases, (p) => p.unpricedLines),
      },
      sales,
      purchases,
      goods: [...goods.values()].sort((a, b) => b.soldMnt + b.boughtMnt - (a.soldMnt + a.boughtMnt)),
      truncated: orders.length === 500 || receipts.length === 500,
    };
  }
}
