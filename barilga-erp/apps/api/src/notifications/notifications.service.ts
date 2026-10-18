import { Injectable, Optional } from '@nestjs/common';
import {
  CashSessionStatus,
  OrderStatus,
  PaymentStatus,
  PayMethod,
  PayrollStatus,
  Prisma,
  RefundStatus,
  Role,
  TransferStatus,
} from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { FULFILLMENT_ROLES, POS_ROLES, TRANSFER_ROLES, WEBSHOP_USERNAME, roleAllowed } from '../auth/rbac';
import { FeatureKey } from '../features/feature-flags';
import { FeaturesService } from '../features/features.service';
import {
  assignedWarehouseIds,
  isManagerRole,
  isTopRole,
  orderWarehouseWhere,
  seesAllWarehouses,
  warehouseWhere,
} from '../inventory/warehouse-scope';
import { LATE_PAYMENT_MARKER } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';

export type Alert = {
  key: string;
  /** danger = money or stock is wrong now; warn = needs doing today; info = good to know. */
  level: 'danger' | 'warn' | 'info';
  title: string;
  detail?: string;
  count: number;
  href: string;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 } as const;

/**
 * Сануулга: things someone has to act on, worked out from the data each time (nothing is stored, so an alert
 * disappears by itself once the cause is fixed). Every check respects the role, the warehouse scope and the
 * module switches; a check that fails is skipped rather than breaking the bell.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly features?: FeaturesService,
  ) {}

  private on(key: FeatureKey) {
    return this.features ? this.features.isEnabled(key) : Promise.resolve(true);
  }

  async forUser(user: AuthUser): Promise<{ alerts: Alert[]; total: number; at: string }> {
    const now = Date.now();
    const def = (await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ?? null;
    const orderScope: Prisma.OrderWhereInput = seesAllWarehouses(user) ? {} : orderWarehouseWhere(user, def);
    const manager = isManagerRole(user.role);
    const checks: Array<() => Promise<Alert | Alert[] | null>> = [];

    // Stock moving between shops.
    if (roleAllowed(user.role, TRANSFER_ROLES)) {
      checks.push(async () => {
        if (!(await this.on('STOCK_TRANSFERS'))) return null;
        const mine = assignedWarehouseIds(user);
        if (mine && !mine.length) return null;
        const [toSend, toReceive] = await Promise.all([
          this.prisma.stockTransfer.count({ where: { status: TransferStatus.REQUESTED, ...(mine ? { fromWarehouseId: { in: mine } } : {}) } }),
          this.prisma.stockTransfer.count({ where: { status: TransferStatus.IN_TRANSIT, ...(mine ? { toWarehouseId: { in: mine } } : {}) } }),
        ]);
        const out: Alert[] = [];
        if (toSend) out.push({ key: 'transfer-requests', level: 'warn', title: 'Бараа илгээх хүсэлт ирсэн', count: toSend, href: '/inventory/transfers' });
        if (toReceive) out.push({ key: 'transfer-incoming', level: 'warn', title: 'Замд яваа бараа хүлээн авах', count: toReceive, href: '/inventory/transfers' });
        return out;
      });
    }

    // Stock below zero or below the minimum level, in the user's warehouses.
    if (manager || user.role === Role.ACHIGCH_BELTGEGCH) {
      checks.push(async () => {
        const where = warehouseWhere(user, def) as Prisma.StockBalanceWhereInput;
        const balances = await this.prisma.stockBalance.findMany({
          where: { ...where, warehouse: { isActive: true }, product: { active: true } },
          select: { quantity: true, product: { select: { minStockLevel: true } } },
        });
        const negative = balances.filter((b) => Number(b.quantity) < 0).length;
        const low = balances.filter((b) => Number(b.quantity) >= 0 && Number(b.quantity) < Number(b.product.minStockLevel)).length;
        const out: Alert[] = [];
        if (negative) {
          out.push({
            key: 'stock-negative',
            level: 'danger',
            title: 'Үлдэгдэл хасах гарсан бараа',
            detail: 'Тооллого хийж «Тохируулах»-аар засна уу',
            count: negative,
            href: '/inventory',
          });
        }
        if (low) out.push({ key: 'stock-low', level: 'info', title: 'Доод хэмжээнээс бага үлдсэн бараа', count: low, href: '/inventory' });
        return out;
      });
    }

    // Orders waiting for money for a long time.
    if (roleAllowed(user.role, POS_ROLES)) {
      checks.push(async () => {
        const n = await this.prisma.order.count({
          where: {
            AND: [orderScope],
            status: OrderStatus.PENDING_PAYMENT,
            createdAt: { lt: new Date(now - 2 * HOUR) },
            ...(user.role === Role.BORLUULAGCH ? { createdById: user.id } : {}),
          },
        });
        return n
          ? { key: 'orders-unpaid', level: 'warn', title: 'Төлбөр хүлээсэн хэвээр захиалга (2+ цаг)', detail: 'Төлүүлэх эсвэл цуцлах', count: n, href: '/orders' }
          : null;
      });
    }

    // Paid goods nobody has handed over.
    if (roleAllowed(user.role, FULFILLMENT_ROLES)) {
      checks.push(async () => {
        const n = await this.prisma.order.count({
          where: { AND: [orderScope], status: OrderStatus.READY_FOR_LOADING, updatedAt: { lt: new Date(now - DAY) } },
        });
        return n ? { key: 'orders-not-handed', level: 'warn', title: 'Төлөгдсөн ч олгоогүй захиалга (1+ хоног)', count: n, href: '/warehouse/tickets' } : null;
      });
    }

    // Invoices past their due date.
    if (roleAllowed(user.role, POS_ROLES)) {
      checks.push(async () => {
        if (!(await this.on('INVOICES'))) return null;
        const rows = await this.prisma.invoice.findMany({
          where: { cancelledAt: null, dueDate: { lt: new Date(now) }, order: orderScope },
          select: { order: { select: { totalMnt: true, payments: { where: { status: PaymentStatus.PAID }, select: { amountMnt: true } } } } },
        });
        const overdue = rows.filter((r) => r.order.payments.reduce((s, p) => s + p.amountMnt, 0) < r.order.totalMnt);
        return overdue.length
          ? { key: 'invoices-overdue', level: 'danger', title: 'Төлөх хугацаа хэтэрсэн нэхэмжлэх', count: overdue.length, href: '/invoices' }
          : null;
      });
    }

    // Debts on account older than 30 days.
    if (manager) {
      checks.push(async () => {
        if (!(await this.on('CREDIT_SALES'))) return null;
        const rows = await this.prisma.payment.findMany({
          where: {
            method: PayMethod.CREDIT,
            status: PaymentStatus.UNPAID,
            amountMnt: { gt: 0 },
            createdAt: { lt: new Date(now - 30 * DAY) },
            order: { AND: [orderScope], status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] } },
          },
          select: { amountMnt: true, order: { select: { customerId: true } } },
        });
        if (!rows.length) return null;
        const customers = new Set(rows.map((r) => r.order.customerId)).size;
        const sum = rows.reduce((s, r) => s + r.amountMnt, 0);
        return {
          key: 'debts-old',
          level: 'warn',
          title: '30 хоногоос дээш төлөгдөөгүй өр',
          detail: `${customers} харилцагч · ${sum.toLocaleString('mn-MN')}₮`,
          count: rows.length,
          href: '/customers',
        };
      });
    }

    // Cash drawers left open from an earlier day.
    if (roleAllowed(user.role, POS_ROLES)) {
      checks.push(async () => {
        if (!(await this.on('CASH_SESSIONS'))) return null;
        const startOfToday = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(now))}T00:00:00+08:00`);
        const who: Prisma.CashSessionWhereInput = !manager
          ? { userId: user.id }
          : seesAllWarehouses(user)
            ? {}
            : { user: warehouseWhere(user, def) as Prisma.UserWhereInput };
        const n = await this.prisma.cashSession.count({ where: { ...who, status: CashSessionStatus.OPEN, openedAt: { lt: startOfToday } } });
        return n
          ? {
              key: 'cash-open-old',
              level: 'danger',
              title: manager ? 'Өмнөх өдрөөс хаагаагүй касс' : 'Өчигдрийн кассаа хаагаагүй байна',
              detail: 'Мөнгөө тоолж хаана уу',
              count: n,
              href: manager ? '/reports/cash' : '/pos',
            }
          : null;
      });
    }

    // QPay money that arrived after the invoice was replaced: refund or reconcile by hand.
    if (manager) {
      checks.push(async () => {
        const n = await this.prisma.payment.count({ where: { lastPollError: { startsWith: LATE_PAYMENT_MARKER }, order: orderScope } });
        return n
          ? {
              key: 'qpay-late',
              level: 'danger',
              title: 'Хугацаа дууссаны дараа QPay-ээр орсон мөнгө',
              detail: 'Харилцагчид буцаах эсвэл тооцоо хийх',
              count: n,
              href: '/orders',
            }
          : null;
      });

      // Refunds by card / QPay / transfer that still have to be paid out.
      checks.push(async () => {
        const n = await this.prisma.salesReturn.count({
          where: { refundStatus: RefundStatus.PENDING_PAYOUT, refundAmount: { gt: 0 }, order: orderScope },
        });
        return n ? { key: 'refunds-pending', level: 'warn', title: 'Харилцагчид буцааж шилжүүлэх мөнгө', count: n, href: '/reports/refunds' } : null;
      });
    }

    // Last month's salaries not marked paid after the 5th.
    if (isTopRole(user.role)) {
      checks.push(async () => {
        if (!(await this.on('HR'))) return null;
        const ub = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(now));
        if (Number(ub.slice(8, 10)) <= 5) return null;
        const [y, m] = ub.slice(0, 7).split('-').map(Number);
        const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
        const n = await this.prisma.payroll.count({
          where: { periodMonth: prev, status: PayrollStatus.DRAFT, netSalary: { gt: 0 }, user: { username: { not: WEBSHOP_USERNAME } } },
        });
        return n ? { key: 'payroll-unpaid', level: 'warn', title: `${prev} сарын цалин олгоогүй`, count: n, href: '/admin/payroll' } : null;
      });
    }

    // Documents print without a seller until the company details are filled in.
    if (user.role === Role.ADMIN) {
      checks.push(async () => {
        const row = await this.prisma.appSetting.findUnique({ where: { key: 'COMPANY' } });
        const name = (row?.value as { name?: string } | null)?.name;
        return name
          ? null
          : { key: 'company-missing', level: 'info', title: 'Компанийн мэдээлэл бөглөөгүй', detail: 'Нэхэмжлэх, баримт дээр нэр, РД гарахгүй', count: 1, href: '/admin/settings' };
      });
    }

    const results = await Promise.all(checks.map((c) => c().catch(() => null)));
    const alerts = results
      .flatMap((r) => (r ? (Array.isArray(r) ? r : [r]) : []))
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    return { alerts, total: alerts.reduce((s, a) => s + a.count, 0), at: new Date(now).toISOString() };
  }
}
