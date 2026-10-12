import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseDayBound, UB_TZ, ymdInUlaanbaatar } from './report-dates';

const minutesBetween = (a?: Date | null, b?: Date | null) =>
  a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000)) : null;
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

/**
 * Preparation times for orders completed in a date range:
 *   wait    = paid → "Би бэлдье" (how long the order sat in the queue)
 *   prepare = "Би бэлдье" → completed (how long preparing took)
 * plus per-person totals and what is being prepared right now.
 */
@Injectable()
export class FulfillmentReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: { startDate?: string; endDate?: string; warehouseId?: string }) {
    const startDate = query.startDate ?? ymdInUlaanbaatar();
    const endDate = query.endDate ?? startDate;
    const startAt = parseDayBound(startDate, false);
    const endAt = parseDayBound(endDate, true);
    if (endAt < startAt) throw new BadRequestException('endDate must be on or after startDate');
    const whereWh: Prisma.OrderWhereInput = query.warehouseId ? { warehouseId: query.warehouseId } : {};

    const include = {
      pickingStartedBy: { select: { id: true, fullName: true } },
      preparedBy: { select: { id: true, fullName: true } },
      warehouse: { select: { name: true } },
      payments: { where: { status: PaymentStatus.PAID }, select: { paidAt: true } },
      items: { select: { pickedById: true, pickedBy: { select: { id: true, fullName: true } } } },
    } as const;

    const [done, inProgress, waiting] = await Promise.all([
      this.prisma.order.findMany({
        where: { ...whereWh, status: OrderStatus.COMPLETED, completedAt: { gte: startAt, lte: endAt } },
        include,
        orderBy: { completedAt: 'asc' },
        take: 2000,
      }),
      this.prisma.order.findMany({
        where: { ...whereWh, status: OrderStatus.READY_FOR_LOADING, pickingStartedAt: { not: null } },
        include,
        orderBy: { pickingStartedAt: 'asc' },
      }),
      this.prisma.order.count({ where: { ...whereWh, status: OrderStatus.READY_FOR_LOADING, pickingStartedAt: null } }),
    ]);

    const paidAt = (o: (typeof done)[number]) =>
      o.payments.reduce<Date | null>((latest, p) => (p.paidAt && (!latest || p.paidAt > latest) ? p.paidAt : latest), null);

    const orders = done.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      warehouse: o.warehouse?.name ?? null,
      lines: o.items.length,
      paidAt: paidAt(o),
      startedAt: o.pickingStartedAt,
      completedAt: o.completedAt,
      startedBy: o.pickingStartedBy?.fullName ?? null,
      completedBy: o.preparedBy?.fullName ?? null,
      pickers: [...new Set(o.items.map((i) => i.pickedBy?.fullName).filter(Boolean))] as string[],
      waitMinutes: minutesBetween(paidAt(o), o.pickingStartedAt),
      prepareMinutes: minutesBetween(o.pickingStartedAt, o.completedAt),
    }));

    // Per person: orders they completed, and lines they ticked (several people can share one order).
    const people = new Map<string, { name: string; ordersCompleted: number; linesPicked: number; prepare: number[] }>();
    const person = (id: string, name: string) => {
      let p = people.get(id);
      if (!p) people.set(id, (p = { name, ordersCompleted: 0, linesPicked: 0, prepare: [] }));
      return p;
    };
    done.forEach((o, idx) => {
      if (o.preparedBy) {
        const p = person(o.preparedBy.id, o.preparedBy.fullName);
        p.ordersCompleted += 1;
        if (orders[idx].prepareMinutes !== null) p.prepare.push(orders[idx].prepareMinutes!);
      }
      for (const i of o.items) if (i.pickedBy) person(i.pickedBy.id, i.pickedBy.fullName).linesPicked += 1;
    });

    const prepare = orders.map((o) => o.prepareMinutes).filter((m): m is number => m !== null);
    const wait = orders.map((o) => o.waitMinutes).filter((m): m is number => m !== null);
    const now = new Date();
    return {
      range: { startDate, endDate, timeZone: UB_TZ },
      summary: {
        completed: orders.length,
        avgPrepareMinutes: avg(prepare),
        maxPrepareMinutes: prepare.length ? Math.max(...prepare) : null,
        avgWaitMinutes: avg(wait),
        withoutStart: orders.filter((o) => !o.startedAt).length,
        waitingNow: waiting,
        preparingNow: inProgress.length,
      },
      people: [...people.values()]
        .map((p) => ({ name: p.name, ordersCompleted: p.ordersCompleted, linesPicked: p.linesPicked, avgPrepareMinutes: avg(p.prepare) }))
        .sort((a, b) => b.ordersCompleted - a.ordersCompleted || b.linesPicked - a.linesPicked),
      inProgress: inProgress.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        startedBy: o.pickingStartedBy?.fullName ?? null,
        startedAt: o.pickingStartedAt,
        minutesSoFar: minutesBetween(o.pickingStartedAt, now),
        lines: o.items.length,
        linesPicked: o.items.filter((i) => i.pickedById).length,
      })),
      orders,
    };
  }
}
