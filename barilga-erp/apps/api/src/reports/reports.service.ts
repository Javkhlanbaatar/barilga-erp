import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EbarimtStatus, OrderStatus, PayMethod, PaymentStatus, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { DailyQueryDto } from './dto/daily-query.dto';

const UB_TZ = 'Asia/Ulaanbaatar';

export type PaymentMethodTotals = {
  method: PayMethod;
  /** Money received by this method in the period, before refunds. */
  grossMnt: number;
  /** Received minus refunds paid out by this method in the period (can be negative). */
  paidMnt: number;
  pendingMnt: number;
  paidCount: number;
};

export type DailyReport = {
  range: { startDate: string; endDate: string; startAt: string; endAt: string; timeZone: string };
  cashier: { id: string; name: string; fullName?: string; username?: string; email: string | null } | null;
  totals: {
    revenueMnt: number;
    cashMnt: number;
    qpayMnt: number;
    cardMnt: number;
    pendingMnt: number;
    deliveryFeesMnt: number;
    unloadingFeesMnt: number;
    refundsMnt: number;
    netRevenueMnt: number;
    orderCount: number;
  };
  refunds: {
    totalMnt: number;
    cashMnt: number;
    qpayMnt: number;
    cardMnt: number;
    count: number;
  };
  payments: PaymentMethodTotals[];
  logistics: {
    deliveryFeesMnt: number;
    unloadingFeesMnt: number;
    timeAdjustmentMnt: number;
  };
  topProducts: Array<{
    productId: string;
    sku: string;
    nameMn: string;
    nameEn: string;
    quantity: number;
    amountMnt: number;
  }>;
  ordersByStatus: Record<OrderStatus, number>;
  ebarimt: {
    issued: number;
    failed: number;
    pending: number;
    receipts: Array<{
      orderNumber: string;
      lottery: string | null;
      receiptId: string | null;
      billType: string;
      totalMnt: number;
    }>;
  };
};

function ymdInUlaanbaatar(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date);
}

function parseDayBound(ymd: string, endOfDay: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new BadRequestException('Dates must be YYYY-MM-DD');
  }
  const iso = endOfDay ? `${ymd}T23:59:59.999+08:00` : `${ymd}T00:00:00.000+08:00`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid date');
  return parsed;
}

@Injectable()
export class ReportsService {
  private readonly log = new Logger(ReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async daily(query: DailyQueryDto, user: AuthUser): Promise<DailyReport> {
    const startDate = query.startDate ?? ymdInUlaanbaatar();
    const endDate = query.endDate ?? startDate;
    const startAt = parseDayBound(startDate, false);
    const endAt = parseDayBound(endDate, true);
    if (endAt < startAt) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    let cashierId: string | undefined;
    if (user.role === Role.BORLUULAGCH) {
      if (query.cashierId && query.cashierId !== user.id) {
        throw new ForbiddenException('Cashiers can only view their own daily summary');
      }
      cashierId = user.id;
    } else if (user.role === Role.ADMIN || user.role === Role.MANAGER) {
      cashierId = query.cashierId;
    } else {
      throw new ForbiddenException('Role is not allowed to view sales reports');
    }

    const orderWhere: Prisma.OrderWhereInput = {
      createdAt: { gte: startAt, lte: endAt },
      ...(cashierId ? { createdById: cashierId } : {}),
    };
    // Sales figures (order count, fees, products, E-Barimt) count only orders that were actually paid.
    const billedWhere: Prisma.OrderWhereInput = {
      ...orderWhere,
      status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] },
    };
    // Money is booked on the day it was received, not the day the order was created (a QPay invoice paid
    // after midnight belongs to the next day). Rows from before paidAt was recorded fall back to createdAt.
    const inRange = { gte: startAt, lte: endAt };
    const paidWhere: Prisma.PaymentWhereInput = {
      status: PaymentStatus.PAID,
      OR: [{ paidAt: inRange }, { paidAt: null, createdAt: inRange }],
      ...(cashierId ? { order: { createdById: cashierId } } : {}),
    };

    const refundWhere: Prisma.SalesReturnWhereInput = {
      createdAt: { gte: startAt, lte: endAt },
      ...(cashierId ? { createdById: cashierId } : {}),
    };

    const [cashier, statusGroups, logisticsAgg, paidSplits, pendingSplits, soldLines, ebarimtGroups, ebarimtReceipts, refundGroups] =
      await Promise.all([
        cashierId
          ? this.prisma.user.findUnique({
              where: { id: cashierId },
              select: { id: true, fullName: true, username: true, email: true },
            })
          : Promise.resolve(null),
        this.prisma.order.groupBy({
          by: ['status'],
          where: orderWhere,
          _count: { _all: true },
        }),
        this.prisma.order.aggregate({
          where: billedWhere,
          _sum: {
            deliveryFeeMnt: true,
            unloadingFeeMnt: true,
            timeAdjustmentMnt: true,
            totalMnt: true,
          },
          _count: { _all: true },
        }),
        this.prisma.payment.groupBy({
          by: ['method'],
          where: paidWhere,
          _sum: { amountMnt: true },
          _count: { _all: true },
        }),
        this.prisma.payment.groupBy({
          by: ['method'],
          where: { status: PaymentStatus.UNPAID, order: { ...orderWhere, status: OrderStatus.PENDING_PAYMENT } },
          _sum: { amountMnt: true },
        }),
        this.prisma.orderItem.findMany({
          where: { order: billedWhere },
          select: { productId: true, quantity: true, lineTotal: true, returnItems: { select: { quantity: true, lineRefund: true } } },
        }),
        this.prisma.order.groupBy({
          by: ['ebarimtStatus'],
          where: billedWhere,
          _count: { _all: true },
        }),
        this.prisma.order.findMany({
          where: { ...billedWhere, ebarimtStatus: EbarimtStatus.ISSUED },
          select: {
            orderNumber: true,
            lottery: true,
            receiptId: true,
            billType: true,
            totalMnt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
        this.prisma.salesReturn.groupBy({
          by: ['refundMethod'],
          where: refundWhere,
          _sum: { refundAmount: true },
          _count: { _all: true },
        }),
      ]);

    const ordersByStatus: Record<OrderStatus, number> = {
      PENDING_PAYMENT: 0,
      READY_FOR_LOADING: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const row of statusGroups) {
      ordersByStatus[row.status] = row._count._all;
    }

    const refundByMethod = new Map(refundGroups.map((row) => [row.refundMethod, row]));
    const refunds = {
      cashMnt: refundByMethod.get(PayMethod.CASH)?._sum.refundAmount ?? 0,
      qpayMnt: refundByMethod.get(PayMethod.QPAY)?._sum.refundAmount ?? 0,
      cardMnt: refundByMethod.get(PayMethod.CARD)?._sum.refundAmount ?? 0,
      count: refundGroups.reduce((s, r) => s + r._count._all, 0),
      totalMnt: 0,
    };
    refunds.totalMnt = refunds.cashMnt + refunds.qpayMnt + refunds.cardMnt;

    const paidMap = new Map(paidSplits.map((row) => [row.method, row]));
    const pendingMap = new Map(pendingSplits.map((row) => [row.method, row]));
    const payments: PaymentMethodTotals[] = [PayMethod.CASH, PayMethod.QPAY, PayMethod.CARD].map(
      (method) => {
        const refunded =
          method === PayMethod.CASH ? refunds.cashMnt : method === PayMethod.QPAY ? refunds.qpayMnt : refunds.cardMnt;
        const grossMnt = paidMap.get(method)?._sum.amountMnt ?? 0;
        // Net of refunds paid out the same way. Not clamped at zero: a day with more refunds than takings
        // must show the shortfall, not hide it.
        return {
          method,
          grossMnt,
          paidMnt: grossMnt - refunded,
          pendingMnt: pendingMap.get(method)?._sum.amountMnt ?? 0,
          paidCount: paidMap.get(method)?._count._all ?? 0,
        };
      },
    );

    const cashMnt = payments.find((p) => p.method === PayMethod.CASH)?.paidMnt ?? 0;
    const qpayMnt = payments.find((p) => p.method === PayMethod.QPAY)?.paidMnt ?? 0;
    const cardMnt = payments.find((p) => p.method === PayMethod.CARD)?.paidMnt ?? 0;
    const revenueMnt = cashMnt + qpayMnt + cardMnt;
    const pendingMnt = payments.reduce((sum, p) => sum + p.pendingMnt, 0);

    // Products sold, net of anything already returned.
    const sold = new Map<string, { quantity: number; amountMnt: number }>();
    for (const line of soldLines) {
      const returnedQty = line.returnItems.reduce((s, r) => s + Number(r.quantity), 0);
      const returnedMnt = line.returnItems.reduce((s, r) => s + r.lineRefund, 0);
      const row = sold.get(line.productId) ?? { quantity: 0, amountMnt: 0 };
      row.quantity += Number(line.quantity) - returnedQty;
      row.amountMnt += line.lineTotal - returnedMnt;
      sold.set(line.productId, row);
    }
    const productGroups = [...sold.entries()]
      .filter(([, v]) => v.quantity > 0 || v.amountMnt > 0)
      .map(([productId, v]) => ({ productId, ...v }));
    const productIds = productGroups.map((g) => g.productId);
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, nameMn: true, nameEn: true },
        })
      : [];
    const productById = new Map(products.map((p) => [p.id, p]));
    const topProducts = productGroups
      .map((g) => {
        const product = productById.get(g.productId);
        return {
          productId: g.productId,
          sku: product?.sku ?? '',
          nameMn: product?.nameMn ?? 'Unknown product',
          nameEn: product?.nameEn ?? '',
          quantity: Math.round(g.quantity * 1000) / 1000,
          amountMnt: g.amountMnt,
        };
      })
      .sort((a, b) => b.amountMnt - a.amountMnt)
      .slice(0, 20);

    const deliveryFeesMnt = logisticsAgg._sum.deliveryFeeMnt ?? 0;
    const unloadingFeesMnt = logisticsAgg._sum.unloadingFeeMnt ?? 0;

    this.log.log(
      `Daily report ${startDate}..${endDate} cashier=${cashierId ?? 'ALL'} by ${user.email} revenue=${revenueMnt} refunds=${refunds.totalMnt}`,
    );

    return {
      range: {
        startDate,
        endDate,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timeZone: UB_TZ,
      },
      cashier: cashier
        ? { id: cashier.id, name: cashier.fullName, fullName: cashier.fullName, username: cashier.username, email: cashier.email }
        : null,
      totals: {
        revenueMnt,
        cashMnt,
        qpayMnt,
        cardMnt,
        pendingMnt,
        deliveryFeesMnt,
        unloadingFeesMnt,
        refundsMnt: refunds.totalMnt,
        netRevenueMnt: revenueMnt,
        orderCount: logisticsAgg._count._all,
      },
      refunds,
      payments,
      logistics: {
        deliveryFeesMnt,
        unloadingFeesMnt,
        timeAdjustmentMnt: logisticsAgg._sum.timeAdjustmentMnt ?? 0,
      },
      topProducts,
      ordersByStatus,
      ebarimt: {
        issued: ebarimtGroups.find((g) => g.ebarimtStatus === EbarimtStatus.ISSUED)?._count._all ?? 0,
        failed: ebarimtGroups.find((g) => g.ebarimtStatus === EbarimtStatus.FAILED)?._count._all ?? 0,
        pending:
          (ebarimtGroups.find((g) => g.ebarimtStatus === EbarimtStatus.PENDING)?._count._all ?? 0) +
          (ebarimtGroups.find((g) => g.ebarimtStatus === EbarimtStatus.NOT_ISSUED)?._count._all ?? 0),
        receipts:
          user.role === Role.BORLUULAGCH
            ? ebarimtReceipts.map((row) => ({ ...row, lottery: null }))
            : ebarimtReceipts,
      },
    };
  }

  async listCashiers(user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only ADMIN and MANAGER can list cashiers');
    }
    const rows = await this.prisma.user.findMany({
      where: { role: Role.BORLUULAGCH, isActive: true, username: { not: WEBSHOP_USERNAME } },
      select: { id: true, fullName: true, username: true, email: true },
      orderBy: { fullName: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.fullName, fullName: r.fullName, username: r.username, email: r.email }));
  }
}
