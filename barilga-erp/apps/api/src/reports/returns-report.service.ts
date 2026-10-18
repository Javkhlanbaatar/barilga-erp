import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { isManagerRole, orderWarehouseWhere, seesAllWarehouses } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { parseDayBound, UB_TZ, ymdInUlaanbaatar } from './report-dates';

/**
 * Буцаалтын тайлан: every return in a date range — what came back, why, how much money went back and how,
 * whether a card / transfer refund has actually been sent — with totals by method, reason, product and person.
 * Managers see their own warehouses.
 */
@Injectable()
export class ReturnsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: { startDate?: string; endDate?: string }, user: AuthUser) {
    if (!isManagerRole(user.role)) throw new ForbiddenException('Only managers can view the returns report');
    const endDate = query.endDate ?? ymdInUlaanbaatar();
    const startDate = query.startDate ?? endDate;
    const startAt = parseDayBound(startDate, false);
    const endAt = parseDayBound(endDate, true);
    if (endAt < startAt) throw new BadRequestException('endDate must be on or after startDate');
    const def = (await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ?? null;
    const scope: Prisma.OrderWhereInput = seesAllWarehouses(user) ? {} : orderWarehouseWhere(user, def);

    const rows = await this.prisma.salesReturn.findMany({
      where: { createdAt: { gte: startAt, lte: endAt }, order: scope },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: {
        id: true,
        createdAt: true,
        reason: true,
        refundAmount: true,
        refundMethod: true,
        refundStatus: true,
        refundAccount: true,
        paidOutAt: true,
        createdBy: { select: { fullName: true } },
        order: { select: { id: true, orderNumber: true, customerName: true, warehouse: { select: { name: true } } } },
        items: {
          select: {
            quantity: true,
            lineRefund: true,
            orderItem: { select: { product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
          },
        },
      },
    });

    const byMethod = new Map<string, { count: number; amountMnt: number }>();
    const byReason = new Map<string, { count: number; amountMnt: number }>();
    const byPerson = new Map<string, { count: number; amountMnt: number }>();
    const byProduct = new Map<string, { sku: string; nameMn: string; unit: string; quantity: number; amountMnt: number }>();
    const add = (m: Map<string, { count: number; amountMnt: number }>, k: string, amt: number) => {
      const cur = m.get(k) ?? { count: 0, amountMnt: 0 };
      m.set(k, { count: cur.count + 1, amountMnt: cur.amountMnt + amt });
    };
    let pendingMnt = 0;
    for (const r of rows) {
      add(byMethod, r.refundMethod, r.refundAmount);
      add(byReason, r.reason.trim().toLowerCase() || '—', r.refundAmount);
      add(byPerson, r.createdBy?.fullName ?? '—', r.refundAmount);
      if (r.refundStatus === 'PENDING_PAYOUT' && r.refundMethod !== 'CREDIT') pendingMnt += r.refundAmount;
      for (const i of r.items) {
        const p = i.orderItem.product;
        const cur = byProduct.get(p.id) ?? { sku: p.sku, nameMn: p.nameMn, unit: p.unit, quantity: 0, amountMnt: 0 };
        byProduct.set(p.id, { ...cur, quantity: cur.quantity + Number(i.quantity), amountMnt: cur.amountMnt + i.lineRefund });
      }
    }
    const list = <T>(m: Map<string, T>) => [...m.entries()].map(([key, v]) => ({ key, ...v }));

    return {
      range: { startDate, endDate, timeZone: UB_TZ },
      totals: { count: rows.length, amountMnt: rows.reduce((s, r) => s + r.refundAmount, 0), pendingMnt },
      byMethod: list(byMethod),
      byReason: list(byReason).sort((a, b) => b.amountMnt - a.amountMnt),
      byPerson: list(byPerson).sort((a, b) => b.amountMnt - a.amountMnt),
      byProduct: list(byProduct).sort((a, b) => b.amountMnt - a.amountMnt),
      returns: rows.map((r) => ({
        id: r.id,
        at: r.createdAt,
        orderId: r.order.id,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customerName,
        warehouse: r.order.warehouse?.name ?? null,
        reason: r.reason,
        refundAmount: r.refundAmount,
        refundMethod: r.refundMethod,
        refundStatus: r.refundStatus,
        refundAccount: r.refundAccount,
        paidOutAt: r.paidOutAt,
        by: r.createdBy?.fullName ?? '',
        items: r.items.map((i) => ({ nameMn: i.orderItem.product.nameMn, sku: i.orderItem.product.sku, quantity: Number(i.quantity), lineRefund: i.lineRefund })),
      })),
    };
  }
}
