import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuthUser } from '../auth/current-user.decorator';
import { FeaturesService } from '../features/features.service';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, isManagerRole, orderWarehouseWhere, seesAllWarehouses } from '../inventory/warehouse-scope';
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
      // The whole due day counts, in Ulaanbaatar time.
      dueDate: dto.dueDate ? new Date(`${dto.dueDate.slice(0, 10)}T23:59:59+08:00`) : (order.invoice?.dueDate ?? null),
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

  async cancel(id: string, user: AuthUser) {
    await this.assertOn();
    if (!isManagerRole(user.role)) throw new ForbiddenException();
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
    if (!row) throw new NotFoundException('Invoice not found');
    await this.assertAccess(user, row.order.warehouseId);
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { cancelledAt: row.cancelledAt ?? new Date() },
      include: INVOICE_INCLUDE,
    });
    this.log.log(`Invoice ${row.invoiceNumber} cancelled by ${user.id}`);
    return this.present(updated);
  }

  async list(user: AuthUser, filter: { state?: string; customerId?: string; q?: string }) {
    await this.assertOn();
    const where: Prisma.InvoiceWhereInput = {};
    if (!seesAllWarehouses(user)) where.order = orderWarehouseWhere(user, await this.inventory.defaultWarehouseId());
    if (filter.customerId) where.customerId = filter.customerId;
    const rows = await this.prisma.invoice.findMany({ where, include: INVOICE_INCLUDE, orderBy: { createdAt: 'desc' }, take: 500 });
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
