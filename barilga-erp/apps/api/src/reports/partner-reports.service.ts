import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { OrderStatus, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { dayRange } from '../customers/partner-trade.service';
import { FeaturesService } from '../features/features.service';
import { isManagerRole, orderWarehouseWhere, seesAllWarehouses, warehouseWhere } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { ymdInUlaanbaatar } from './report-dates';

const DAY = 86_400_000;
const MONEY: PayMethod[] = [PayMethod.CASH, PayMethod.CARD, PayMethod.QPAY, PayMethod.TRANSFER];
const BUCKETS = [
  { key: 'd0_30', max: 30 },
  { key: 'd31_60', max: 60 },
  { key: 'd61_90', max: 90 },
  { key: 'd90p', max: Infinity },
] as const;
type BucketKey = (typeof BUCKETS)[number]['key'];

/**
 * Partner reports for managers: who owes us and for how long (aging), sales by customer and purchases by
 * supplier for a period. Sales and order debts follow the manager's warehouses; the partner ledger
 * (purchases, advances, charges) is company-wide, as in the partner account.
 */
@Injectable()
export class PartnerReportsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly features?: FeaturesService,
  ) {}

  /** A switched-off module hides its data here too (partner ledger, goods receipts). */
  private async on(key: 'PARTNER_ACCOUNTS' | 'STOCK_RECEIPTS') {
    return !this.features || this.features.isEnabled(key);
  }

  private assert(user: AuthUser) {
    if (!isManagerRole(user.role)) throw new ForbiddenException('Only managers can view partner reports');
  }

  private async scope(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    if (seesAllWarehouses(user)) return {};
    const def = (await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id;
    return orderWarehouseWhere(user, def);
  }

  /**
   * Авлагын насжилт: every unpaid on-account amount, aged from the sale date (or the invoice due date when the
   * order has one), in 0–30 / 31–60 / 61–90 / 90+ day buckets, per customer.
   */
  async aging(user: AuthUser) {
    this.assert(user);
    const now = Date.now();
    const rows = await this.prisma.payment.findMany({
      where: {
        method: PayMethod.CREDIT,
        status: PaymentStatus.UNPAID,
        amountMnt: { gt: 0 },
        order: { AND: [await this.scope(user)], status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] }, customerId: { not: null } },
      },
      select: {
        amountMnt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            createdAt: true,
            customerId: true,
            customerName: true,
            invoice: { select: { dueDate: true, cancelledAt: true } },
          },
        },
      },
    });
    const ledgerOn = await this.on('PARTNER_ACCOUNTS');
    const ledger = ledgerOn ? await this.prisma.accountEntry.groupBy({ by: ['customerId'], _sum: { amountMnt: true } }) : [];
    const ledgerBy = new Map(ledger.map((l) => [l.customerId, l._sum.amountMnt ?? 0]));
    type Row = { customerId: string; name: string; totalMnt: number; oldestDays: number; orders: number } & Record<BucketKey, number>;
    const byCustomer = new Map<string, Row>();
    for (const p of rows) {
      const o = p.order;
      const id = o.customerId!;
      const from = o.invoice && !o.invoice.cancelledAt && o.invoice.dueDate ? o.invoice.dueDate.getTime() : o.createdAt.getTime();
      const days = Math.max(0, Math.floor((now - from) / DAY));
      const bucket = BUCKETS.find((b) => days <= b.max)!.key;
      let r = byCustomer.get(id);
      if (!r) byCustomer.set(id, (r = { customerId: id, name: o.customerName, totalMnt: 0, oldestDays: 0, orders: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 }));
      r[bucket] += p.amountMnt;
      r.totalMnt += p.amountMnt;
      r.orders += 1;
      r.oldestDays = Math.max(r.oldestDays, days);
    }
    // Registered names (the order snapshot may be old) and the ledger position next to the order debt.
    const ids = [...byCustomer.keys()];
    const names = ids.length ? await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const nameBy = new Map(names.map((n) => [n.id, n]));
    const list = [...byCustomer.values()]
      .map((r) => ({ ...r, name: nameBy.get(r.customerId)?.name ?? r.name, phone: nameBy.get(r.customerId)?.phone ?? '', ledgerMnt: ledgerBy.get(r.customerId) ?? 0 }))
      .sort((a, b) => b.d90p - a.d90p || b.totalMnt - a.totalMnt);
    const totals = { totalMnt: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
    for (const r of list) for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r[k];
    return { asOf: ymdInUlaanbaatar(), customers: list, totals, ledgerShown: ledgerOn };
  }

  /** Борлуулалт харилцагчаар: released orders in the period per customer (walk-in sales grouped as one row). */
  async salesByCustomer(query: { startDate?: string; endDate?: string }, user: AuthUser) {
    this.assert(user);
    const endDate = query.endDate ?? ymdInUlaanbaatar();
    const startDate = query.startDate ?? endDate;
    const when = dayRange(startDate, endDate);
    const orders = await this.prisma.order.findMany({
      where: { AND: [await this.scope(user)], status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] }, createdAt: when },
      select: {
        customerId: true,
        totalMnt: true,
        payments: { select: { method: true, status: true, amountMnt: true } },
        returns: { select: { refundAmount: true } },
      },
    });
    type Row = { customerId: string | null; orders: number; grossMnt: number; returnedMnt: number; netMnt: number; moneyMnt: number; creditMnt: number; offsetMnt: number };
    const by = new Map<string, Row>();
    for (const o of orders) {
      const key = o.customerId ?? '__walkin';
      let r = by.get(key);
      if (!r) by.set(key, (r = { customerId: o.customerId, orders: 0, grossMnt: 0, returnedMnt: 0, netMnt: 0, moneyMnt: 0, creditMnt: 0, offsetMnt: 0 }));
      const returned = o.returns.reduce((s, x) => s + x.refundAmount, 0);
      r.orders += 1;
      r.grossMnt += o.totalMnt;
      r.returnedMnt += returned;
      r.netMnt += o.totalMnt - returned;
      for (const p of o.payments) {
        if (p.method === PayMethod.CREDIT) {
          // What was given on account (original amount; payments later come back as money).
          if (p.status === PaymentStatus.UNPAID || p.status === PaymentStatus.PAID) r.creditMnt += p.amountMnt;
        } else if (p.status === PaymentStatus.PAID) {
          if (MONEY.includes(p.method)) r.moneyMnt += p.amountMnt;
          if (p.method === PayMethod.OFFSET) r.offsetMnt += p.amountMnt;
        }
      }
    }
    const ids = [...by.keys()].filter((k) => k !== '__walkin');
    const names = ids.length ? await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true } }) : [];
    const nameBy = new Map(names.map((n) => [n.id, n]));
    const list = [...by.entries()]
      .map(([k, r]) => ({ ...r, name: k === '__walkin' ? 'Бүртгэлгүй (энгийн) харилцагч' : (nameBy.get(k)?.name ?? '—'), type: nameBy.get(k)?.type ?? null }))
      .sort((a, b) => b.netMnt - a.netMnt);
    const totals = list.reduce(
      (t, r) => ({ orders: t.orders + r.orders, grossMnt: t.grossMnt + r.grossMnt, returnedMnt: t.returnedMnt + r.returnedMnt, netMnt: t.netMnt + r.netMnt }),
      { orders: 0, grossMnt: 0, returnedMnt: 0, netMnt: 0 },
    );
    return { range: { startDate, endDate }, customers: list, totals };
  }

  /**
   * Худалдан авалт нийлүүлэгчээр: goods receipts in the period per supplier partner (or by the typed supplier
   * name when not registered), with unpriced lines counted, plus amount-only purchases written on partner
   * accounts (services). Receipt purchases are not counted twice.
   */
  async purchasesBySupplier(query: { startDate?: string; endDate?: string }, user: AuthUser) {
    this.assert(user);
    const endDate = query.endDate ?? ymdInUlaanbaatar();
    const startDate = query.startDate ?? endDate;
    const when = dayRange(startDate, endDate);
    // Receipts always have a warehouse, so the receipts page's rule applies (no "no warehouse" branch).
    const whScope = warehouseWhere(user) as Prisma.StockReceiptWhereInput;
    const [receiptsOn, ledgerOn] = await Promise.all([this.on('STOCK_RECEIPTS'), this.on('PARTNER_ACCOUNTS')]);
    if (!receiptsOn && !ledgerOn) throw new ForbiddenException('Module STOCK_RECEIPTS is switched off');
    const [receipts, manualAll] = await Promise.all([
      receiptsOn
        ? this.prisma.stockReceipt.findMany({
            where: { AND: [whScope], receivedAt: when },
            select: { supplierCustomerId: true, supplierName: true, items: { select: { quantity: true, unitCostMnt: true } } },
          })
        : Promise.resolve([]),
      ledgerOn
        ? this.prisma.accountEntry.findMany({
            where: { kind: 'PURCHASE', refType: null, occurredAt: when },
            select: { id: true, customerId: true, amountMnt: true },
          })
        : Promise.resolve([]),
    ]);
    // A cancelled purchase is not a purchase, whenever it was cancelled.
    const voided = manualAll.length
      ? new Set(
          (await this.prisma.accountEntry.findMany({ where: { refType: 'VOID', refId: { in: manualAll.map((m) => m.id) } }, select: { refId: true } })).map(
            (v) => v.refId,
          ),
        )
      : new Set<string | null>();
    const manual = manualAll.filter((m) => !voided.has(m.id));
    type Row = { key: string; customerId: string | null; name: string; receipts: number; goodsMnt: number; unpricedLines: number; otherMnt: number };
    const by = new Map<string, Row>();
    const row = (key: string, customerId: string | null, name: string) => {
      let r = by.get(key);
      if (!r) by.set(key, (r = { key, customerId, name, receipts: 0, goodsMnt: 0, unpricedLines: 0, otherMnt: 0 }));
      return r;
    };
    for (const rc of receipts) {
      const key = rc.supplierCustomerId ?? `name:${rc.supplierName.trim().toLowerCase()}`;
      const r = row(key, rc.supplierCustomerId, rc.supplierName);
      r.receipts += 1;
      for (const i of rc.items) {
        if (i.unitCostMnt == null) r.unpricedLines += 1;
        else r.goodsMnt += Math.round(Number(i.quantity) * i.unitCostMnt);
      }
    }
    for (const m of manual) row(m.customerId, m.customerId, '').otherMnt += m.amountMnt;
    const ids = [...by.values()].map((r) => r.customerId).filter((x): x is string => Boolean(x));
    const names = ids.length ? await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameBy = new Map(names.map((n) => [n.id, n.name]));
    const list = [...by.values()]
      .map((r) => ({ ...r, name: (r.customerId && nameBy.get(r.customerId)) || r.name || '—', totalMnt: r.goodsMnt + r.otherMnt, registered: Boolean(r.customerId) }))
      .sort((a, b) => b.totalMnt - a.totalMnt);
    const totals = list.reduce(
      (t, r) => ({ receipts: t.receipts + r.receipts, goodsMnt: t.goodsMnt + r.goodsMnt, otherMnt: t.otherMnt + r.otherMnt, unpricedLines: t.unpricedLines + r.unpricedLines }),
      { receipts: 0, goodsMnt: 0, otherMnt: 0, unpricedLines: 0 },
    );
    return { range: { startDate, endDate }, suppliers: list, totals, receiptsShown: receiptsOn, ledgerShown: ledgerOn };
  }
}
