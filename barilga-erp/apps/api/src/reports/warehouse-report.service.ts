import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, Role, StockMovementType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { lockedWarehouseId, seesAllWarehouses } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { parseDayBound, UB_TZ, ymdInUlaanbaatar } from './report-dates';

type Totals = {
  opening: number;
  receipts: number;
  transfersIn: number;
  transfersOut: number;
  sales: number;
  returns: number;
  adjustments: number;
  closing: number;
};

const ZERO_TOTALS = (): Totals => ({
  opening: 0,
  receipts: 0,
  transfersIn: 0,
  transfersOut: 0,
  sales: 0,
  returns: 0,
  adjustments: 0,
  closing: 0,
});

/** Which column each ledger type is reported in. OPENING/RECONCILE/ADJUSTMENT are corrections. */
const COLUMN: Record<StockMovementType, keyof Totals> = {
  OPENING: 'adjustments',
  SALE: 'sales',
  RETURN: 'returns',
  RECEIPT: 'receipts',
  TRANSFER_OUT: 'transfersOut',
  TRANSFER_IN: 'transfersIn',
  ADJUSTMENT: 'adjustments',
  RECONCILE: 'adjustments',
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Stock movement report for one warehouse (or all) over a date range, computed from the append-only ledger:
 *   opening = current balance − everything that moved since the start
 *   closing = opening + everything that moved inside the range
 * so it agrees with the ledger by construction, for any past range.
 */
@Injectable()
export class WarehouseReportService {
  private readonly log = new Logger(WarehouseReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async report(query: { warehouseId?: string; startDate?: string; endDate?: string }, user: AuthUser) {
    if (!seesAllWarehouses(user.role) && user.role !== Role.ACHIGCH_BELTGEGCH) {
      throw new ForbiddenException('Only managers, admin or warehouse staff can view the warehouse report');
    }
    const locked = lockedWarehouseId(user);
    if (!seesAllWarehouses(user.role) && !locked) {
      throw new ForbiddenException('You must be assigned to a warehouse to view its report');
    }
    if (locked && query.warehouseId && query.warehouseId !== locked) {
      throw new ForbiddenException('You can only view your own warehouse');
    }
    const warehouseId = locked ?? query.warehouseId ?? null;

    const startDate = query.startDate ?? ymdInUlaanbaatar();
    const endDate = query.endDate ?? startDate;
    const startAt = parseDayBound(startDate, false);
    const endAt = parseDayBound(endDate, true);
    if (endAt < startAt) throw new BadRequestException('endDate must be on or after startDate');

    const whereWh = warehouseId ? { warehouseId } : {};
    const [warehouse, balances, sinceStart, inRange, inTransit] = await Promise.all([
      warehouseId ? this.prisma.warehouse.findUnique({ where: { id: warehouseId } }) : Promise.resolve(null),
      this.prisma.stockBalance.groupBy({ by: ['productId'], where: whereWh, _sum: { quantity: true } }),
      this.prisma.stockMovement.groupBy({
        by: ['productId'],
        where: { ...whereWh, createdAt: { gte: startAt } },
        _sum: { quantityDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['productId', 'type'],
        where: { ...whereWh, createdAt: { gte: startAt, lte: endAt } },
        _sum: { quantityDelta: true },
      }),
      this.prisma.stockTransfer.findMany({
        where: {
          status: TransferStatus.IN_TRANSIT,
          ...(warehouseId ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] } : {}),
        },
        include: {
          fromWarehouse: { select: { name: true } },
          toWarehouse: { select: { name: true } },
          items: { include: { product: { select: { sku: true, nameMn: true, unit: true } } } },
        },
        orderBy: { sentAt: 'asc' },
      }),
    ]);
    if (warehouseId && !warehouse) throw new BadRequestException('Warehouse not found');

    const num = (d: Prisma.Decimal | null | undefined) => Number(d ?? 0);
    const rows = new Map<string, Totals>();
    const row = (productId: string) => {
      let r = rows.get(productId);
      if (!r) rows.set(productId, (r = ZERO_TOTALS()));
      return r;
    };
    const current = new Map(balances.map((b) => [b.productId, num(b._sum.quantity)]));
    const movedSinceStart = new Map(sinceStart.map((m) => [m.productId, num(m._sum.quantityDelta)]));
    for (const m of inRange) row(m.productId)[COLUMN[m.type]] += num(m._sum.quantityDelta);
    for (const productId of new Set([...current.keys(), ...movedSinceStart.keys()])) {
      const r = row(productId);
      r.opening = (current.get(productId) ?? 0) - (movedSinceStart.get(productId) ?? 0);
    }
    for (const r of rows.values()) {
      r.closing = r.opening + r.receipts + r.transfersIn + r.transfersOut + r.sales + r.returns + r.adjustments;
    }

    const productIds = [...rows.keys()];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, nameMn: true, unit: true, category: true, priceMnt: true, lastCostMnt: true, minStockLevel: true },
        })
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = [...rows.entries()]
      .filter(([, r]) => Object.values(r).some((v) => Math.abs(v) > 1e-9))
      .map(([productId, r]) => {
        const p = byId.get(productId);
        const closing = round3(r.closing);
        return {
          productId,
          sku: p?.sku ?? '',
          nameMn: p?.nameMn ?? '',
          unit: p?.unit ?? '',
          category: p?.category ?? '',
          opening: round3(r.opening),
          receipts: round3(r.receipts),
          transfersIn: round3(r.transfersIn),
          // Out-going columns are reported as positive amounts.
          transfersOut: round3(-r.transfersOut),
          sales: round3(-r.sales),
          returns: round3(r.returns),
          adjustments: round3(r.adjustments),
          closing,
          minStockLevel: Number(p?.minStockLevel ?? 0),
          lowStock: closing <= Number(p?.minStockLevel ?? 0),
          valueAtPriceMnt: Math.round(closing * (p?.priceMnt ?? 0)),
          valueAtCostMnt: p?.lastCostMnt != null ? Math.round(closing * p.lastCostMnt) : null,
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));

    const sum = (key: 'receipts' | 'transfersIn' | 'transfersOut' | 'sales' | 'returns' | 'adjustments' | 'valueAtPriceMnt') =>
      round3(lines.reduce((s, l) => s + l[key], 0));

    this.log.log(`Warehouse report ${warehouse?.code ?? 'ALL'} ${startDate}..${endDate} by ${user.id}: ${lines.length} products`);
    return {
      range: { startDate, endDate, startAt: startAt.toISOString(), endAt: endAt.toISOString(), timeZone: UB_TZ },
      warehouse: warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name } : null,
      lines,
      totals: {
        products: lines.length,
        receipts: sum('receipts'),
        transfersIn: sum('transfersIn'),
        transfersOut: sum('transfersOut'),
        sales: sum('sales'),
        returns: sum('returns'),
        adjustments: sum('adjustments'),
        valueAtPriceMnt: sum('valueAtPriceMnt'),
        lowStock: lines.filter((l) => l.lowStock).length,
      },
      inTransit: inTransit.map((t) => ({
        id: t.id,
        transferNumber: t.transferNumber,
        from: t.fromWarehouse.name,
        to: t.toWarehouse.name,
        sentAt: t.sentAt,
        items: t.items.map((i) => ({ sku: i.product.sku, nameMn: i.product.nameMn, unit: i.product.unit, quantity: Number(i.quantity) })),
      })),
    };
  }
}
