import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuthUser } from '../auth/current-user.decorator';
import { can } from '../auth/permissions';
import { FeaturesService } from '../features/features.service';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, isManagerRole, orderWarehouseWhere, seesAllWarehouses } from '../inventory/warehouse-scope';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { createWithUniqueNumber, isUniqueConflictOn, ulaanbaatarYmd } from './order-number';

export type InvoiceState = 'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIAL' | 'OVERDUE' | 'PAID' | 'CANCELLED';

const INVOICE_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalMnt: true,
      customerName: true,
      customerPhone: true,
      warehouseId: true,
      createdAt: true,
      payments: { select: { method: true, status: true, amountMnt: true } },
    },
  },
  customer: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;
type MoneyInput = {
  dueDate: Date | null;
  sentAt: Date | null;
  viewedAt: Date | null;
  cancelledAt: Date | null;
  order: { status: OrderStatus; totalMnt: number; payments: Array<{ status: PaymentStatus; amountMnt: number }> };
};

/**
 * Invoices sent to buyers. One per order; the money side (paid / still owed) always comes from the order's
 * payments, so an invoice can never disagree with the till.
 */
@Injectable()
export class InvoicesService {
  private readonly log = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settings: SettingsService,
    private readonly features?: FeaturesService,
    /** Cancels the order behind a cancelled invoice when nothing was paid on it. */
    private readonly payments?: PaymentService,
  ) {}

  /** What is still owed (open on-account part, awaited transfer, unpaid QPay) and the resulting state. */
  static money(row: MoneyInput, now = new Date()) {
    const live = row.order.payments.filter((p) => p.status !== PaymentStatus.EXPIRED && p.status !== PaymentStatus.FAILED);
    const owedMnt = live.filter((p) => p.status === PaymentStatus.UNPAID).reduce((s, p) => s + p.amountMnt, 0);
    // What was actually settled (money or offset); goods returned against the debt are not "paid".
    const paidMnt = live.filter((p) => p.status === PaymentStatus.PAID).reduce((s, p) => s + p.amountMnt, 0);
    let state: InvoiceState;
    if (row.cancelledAt || row.order.status === OrderStatus.CANCELLED) state = 'CANCELLED';
    else if (owedMnt === 0 && live.length > 0) state = 'PAID';
    else if (row.dueDate && row.dueDate.getTime() < now.getTime()) state = 'OVERDUE';
    else if (paidMnt > 0) state = 'PARTIAL';
    else if (row.viewedAt) state = 'VIEWED';
    else if (row.sentAt) state = 'SENT';
    else state = 'DRAFT';
    return { paidMnt, owedMnt, state };
  }

  /**
   * The list's state filter as a query (the same rules as `money`), so it runs before the row limit and an old
   * open invoice is not cut off by newer ones. The exact state is still checked on each row afterwards.
   */
  static stateWhere(state: string, now = new Date()): Prisma.InvoiceWhereInput {
    const cancelled: Prisma.InvoiceWhereInput = { OR: [{ cancelledAt: { not: null } }, { order: { status: OrderStatus.CANCELLED } }] };
    const notCancelled: Prisma.InvoiceWhereInput = { cancelledAt: null, order: { status: { not: OrderStatus.CANCELLED } } };
    const live: Prisma.PaymentWhereInput = { status: { notIn: [PaymentStatus.EXPIRED, PaymentStatus.FAILED] } };
    const owing: Prisma.PaymentWhereInput = { status: PaymentStatus.UNPAID, amountMnt: { gt: 0 } };
    // Paid: something live was recorded and nothing is still owed.
    const paid: Prisma.InvoiceWhereInput = { order: { payments: { some: live, none: owing } } };
    const unpaid: Prisma.InvoiceWhereInput = { OR: [{ order: { payments: { some: owing } } }, { order: { payments: { none: live } } }] };
    switch (state) {
      case 'CANCELLED':
        return cancelled;
      case 'PAID':
        return { AND: [notCancelled, paid] };
      case 'OPEN':
        return { AND: [notCancelled, unpaid] };
      case 'OVERDUE':
        return { AND: [notCancelled, unpaid, { dueDate: { lt: now } }] };
      default:
        // DRAFT / SENT / VIEWED / PARTIAL: still owed and not past due.
        return { AND: [notCancelled, unpaid, { OR: [{ dueDate: null }, { dueDate: { gte: now } }] }] };
    }
  }

  private present(row: InvoiceRow) {
    const { token, ...rest } = row;
    return { ...rest, publicPath: `/invoice/${token}`, ...InvoicesService.money(row) };
  }

  private async assertOn() {
    if (this.features) await this.features.assertEnabled('INVOICES');
  }

  private async assertAccess(user: AuthUser, warehouseId: string | null) {
    if (seesAllWarehouses(user)) return;
    const fallback = warehouseId ? undefined : await this.inventory.defaultWarehouseId();
    assertWarehouseAccess(user, warehouseId, fallback);
  }

  /** Creates the order's invoice, or updates where it goes and when it is due if it already exists. */
  async create(dto: CreateInvoiceDto, user: AuthUser) {
    await this.assertOn();
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId }, include: { customer: true, invoice: true } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertAccess(user, order.warehouseId);
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Цуцлагдсан захиалгад нэхэмжлэх илгээхгүй / Order is cancelled');
    }
    const fields = {
      recipientEmail: dto.recipientEmail ?? order.invoice?.recipientEmail ?? order.customer?.email ?? null,
      recipientPhone: dto.recipientPhone ?? order.invoice?.recipientPhone ?? order.customerPhone ?? null,
      // The whole due day counts, in Ulaanbaatar time. A new invoice is due in 7 days unless told otherwise.
      dueDate: dto.dueDate
        ? new Date(`${dto.dueDate.slice(0, 10)}T23:59:59+08:00`)
        : (order.invoice?.dueDate ?? InvoicesService.endOfDayIn(7)),
      note: dto.note ?? order.invoice?.note ?? null,
    };
    if (order.invoice) {
      if (order.invoice.cancelledAt) throw new BadRequestException('Энэ нэхэмжлэх цуцлагдсан / Invoice was cancelled');
      const updated = await this.prisma.invoice.update({ where: { id: order.invoice.id }, data: fields, include: INVOICE_INCLUDE });
      return this.present(updated);
    }
    let created: InvoiceRow;
    try {
      created = await createWithUniqueNumber({
        prefix: `NH-${ulaanbaatarYmd()}-`,
        label: 'invoice number',
        countExisting: (p) => this.prisma.invoice.count({ where: { invoiceNumber: { startsWith: p } } }),
        isConflict: (err) => isUniqueConflictOn(err, 'invoice_number') || isUniqueConflictOn(err, 'invoiceNumber'),
        create: (invoiceNumber) =>
          this.prisma.invoice.create({
            data: {
              invoiceNumber,
              orderId: order.id,
              customerId: order.customerId,
              token: randomBytes(24).toString('base64url'),
              createdById: user.id,
              ...fields,
            },
            include: INVOICE_INCLUDE,
          }),
      });
    } catch (err) {
      // Two people pressing "send" at once: the order already has its invoice, so hand that one back.
      if (!isUniqueConflictOn(err, 'order_id') && !isUniqueConflictOn(err, 'orderId')) throw err;
      created = await this.prisma.invoice.findUniqueOrThrow({ where: { orderId: order.id }, include: INVOICE_INCLUDE });
    }
    this.log.log(`Invoice ${created.invoiceNumber} for ${order.orderNumber} by ${user.id}`);
    return this.present(created);
  }

  /**
   * The invoice made at the till together with the order (also "задгай нэхэмжлэх", no buyer chosen): its number
   * and link key, so the till can print or send it right away.
   */
  async createForNewOrder(orderId: string, user: AuthUser) {
    const invoice = await this.create({ orderId }, user);
    const { token } = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { token: true } });
    return { id: invoice.id, invoiceNumber: invoice.invoiceNumber, token };
  }

  /** 23:59:59 Ulaanbaatar time, `days` days from today. */
  static endOfDayIn(days: number, from = new Date()) {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(from.getTime() + days * 86_400_000));
    return new Date(`${ymd}T23:59:59+08:00`);
  }

  /** More time to pay: from the later of today and the current due date, by `days` (default 7). */
  async extend(id: string, days: number, user: AuthUser) {
    await this.assertOn();
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
    if (!row) throw new NotFoundException('Invoice not found');
    await this.assertAccess(user, row.order.warehouseId);
    if (row.cancelledAt) throw new BadRequestException('Энэ нэхэмжлэх цуцлагдсан / Invoice was cancelled');
    const base = row.dueDate && row.dueDate.getTime() > Date.now() ? row.dueDate : new Date();
    const dueDate = InvoicesService.endOfDayIn(days, base);
    const updated = await this.prisma.invoice.update({ where: { id }, data: { dueDate }, include: INVOICE_INCLUDE });
    this.log.log(`Invoice ${row.invoiceNumber} due date ${row.dueDate?.toISOString() ?? '—'} → ${dueDate.toISOString()} by ${user.id}`);
    return this.present(updated);
  }

  /** The order's invoice with its link key, for staff who may see that order. */
  async forOrder(orderId: string, user: AuthUser) {
    await this.assertOn();
    const row = await this.prisma.invoice.findUnique({ where: { orderId }, include: INVOICE_INCLUDE });
    if (!row) return null;
    await this.assertAccess(user, row.order.warehouseId);
    return { ...this.present(row), token: row.token };
  }

  /** Recorded when staff copy the link, open the e-mail, or print it. */
  async markSent(id: string, via: string, user: AuthUser) {
    await this.assertOn();
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
    if (!row) throw new NotFoundException('Invoice not found');
    await this.assertAccess(user, row.order.warehouseId);
    if (row.cancelledAt) throw new BadRequestException('Invoice was cancelled');
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { sentAt: new Date(), lastSentVia: via, sendCount: { increment: 1 } },
      include: INVOICE_INCLUDE,
    });
    return this.present(updated);
  }

  /**
   * Cancels the invoice. When its order still waits for payment and nothing on it is paid (e.g. a standalone
   * invoice the buyer will not pay), the order is cancelled too, through the usual unpaid-order cancel, so it does
   * not wait forever. Otherwise only the invoice is cancelled, as before. The answer says which happened.
   */
  async cancel(id: string, user: AuthUser) {
    await this.assertOn();
    if (!isManagerRole(user.role)) throw new ForbiddenException();
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
    if (!row) throw new NotFoundException('Invoice not found');
    await this.assertAccess(user, row.order.warehouseId);
    // The order first: if the provider cannot be asked about a waiting QPay part, nothing changes and it can be retried.
    const order = await this.cancelUnpaidOrderToo(row, user);
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { cancelledAt: row.cancelledAt ?? new Date() },
      include: INVOICE_INCLUDE,
    });
    this.log.log(`Invoice ${row.invoiceNumber} cancelled by ${user.id}${order.cancelled ? `; order ${row.order.orderNumber} cancelled with it` : ''}`);
    return { ...this.present(updated), orderCancelled: order.cancelled, orderNote: order.note };
  }

  /** `note` (Mongolian, for the screen) says why the order was left as it is, when it matters. */
  private async cancelUnpaidOrderToo(row: InvoiceRow, user: AuthUser): Promise<{ cancelled: boolean; note: string | null }> {
    const o = row.order;
    if (o.status === OrderStatus.CANCELLED || !this.payments) return { cancelled: false, note: null };
    if (o.status !== OrderStatus.PENDING_PAYMENT || o.payments.some((p) => p.status === PaymentStatus.PAID)) {
      return { cancelled: false, note: 'Захиалгад төлбөр орсон тул зөвхөн нэхэмжлэх цуцлагдлаа' };
    }
    if (!can(user, 'ORDER_CANCEL')) {
      return { cancelled: false, note: 'Танд захиалга цуцлах эрх байхгүй тул зөвхөн нэхэмжлэх цуцлагдлаа' };
    }
    const who = user.fullName ?? user.name ?? user.email ?? user.id;
    try {
      await this.payments.cancelUnpaidOrder(o.id, `Нэхэмжлэх ${row.invoiceNumber} цуцлагдсан (by ${who})`);
      return { cancelled: true, note: null };
    } catch (err) {
      // Money was confirmed meanwhile, or the order moved on: as before, only the invoice is cancelled.
      if (err instanceof BadRequestException || err instanceof ConflictException) {
        this.log.warn(`Invoice ${row.invoiceNumber}: order ${o.orderNumber} not cancelled (${err.message})`);
        return { cancelled: false, note: 'Захиалгад төлбөр дөнгөж орсон тул зөвхөн нэхэмжлэх цуцлагдлаа' };
      }
      throw err;
    }
  }

  async list(user: AuthUser, filter: { state?: string; customerId?: string; q?: string }) {
    await this.assertOn();
    const and: Prisma.InvoiceWhereInput[] = [];
    if (!seesAllWarehouses(user)) and.push({ order: orderWarehouseWhere(user, await this.inventory.defaultWarehouseId()) });
    if (filter.customerId) and.push({ customerId: filter.customerId });
    // In the query, before the limit: an old invoice still open must not drop out behind 500 newer ones.
    if (filter.state) and.push(InvoicesService.stateWhere(filter.state));
    const rows = await this.prisma.invoice.findMany({ where: { AND: and }, include: INVOICE_INCLUDE, orderBy: { createdAt: 'desc' }, take: 500 });
    const q = filter.q?.trim().toLowerCase();
    const invoices = rows
      .map((r) => this.present(r))
      .filter((r) => !filter.state || (filter.state === 'OPEN' ? r.state !== 'PAID' && r.state !== 'CANCELLED' : r.state === filter.state))
      .filter(
        (r) =>
          !q ||
          r.invoiceNumber.toLowerCase().includes(q) ||
          r.order.orderNumber.toLowerCase().includes(q) ||
          r.order.customerName.toLowerCase().includes(q) ||
          (r.recipientEmail ?? '').includes(q),
      );
    const totals = { totalMnt: 0, owedMnt: 0, overdueMnt: 0 };
    for (const r of invoices) {
      if (r.state === 'CANCELLED') continue;
      totals.totalMnt += r.order.totalMnt;
      totals.owedMnt += r.owedMnt;
      if (r.state === 'OVERDUE') totals.overdueMnt += r.owedMnt;
    }
    return { invoices, totals };
  }

  /** What the buyer sees behind the link: this invoice only, without internal ids or other staff data. */
  async publicView(token: string) {
    await this.assertOn();
    if (!token || token.length < 20) throw new NotFoundException('Invoice not found');
    const row = await this.prisma.invoice.findUnique({
      where: { token },
      include: {
        order: {
          include: {
            items: { include: { product: { select: { nameMn: true, sku: true, unit: true } } } },
            payments: { select: { method: true, status: true, amountMnt: true } },
            createdBy: { select: { fullName: true } },
          },
        },
      },
    });
    if (!row || row.cancelledAt || row.order.status === OrderStatus.CANCELLED) throw new NotFoundException('Invoice not found');
    if (!row.viewedAt) {
      await this.prisma.invoice.updateMany({ where: { id: row.id, viewedAt: null }, data: { viewedAt: new Date() } });
    }
    const o = row.order;
    const [company, documents] = await Promise.all([this.settings.company(), this.settings.documents()]);
    return {
      template: documents.invoice,
      invoiceNumber: row.invoiceNumber,
      dueDate: row.dueDate,
      note: row.note,
      createdAt: row.createdAt,
      ...InvoicesService.money(row),
      company,
      order: {
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        customerRegNumber: o.customerRegNumber,
        deliveryAddress: o.deliveryAddress,
        subtotalMnt: o.subtotalMnt,
        deliveryFeeMnt: o.deliveryFeeMnt,
        unloadingFeeMnt: o.unloadingFeeMnt,
        timeAdjustmentMnt: o.timeAdjustmentMnt,
        totalMnt: o.totalMnt,
        payments: o.payments,
        createdBy: { fullName: o.createdBy?.fullName ?? '' },
        items: o.items.map((i, idx) => ({
          id: String(idx + 1),
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
          product: i.product,
        })),
      },
    };
  }
}
