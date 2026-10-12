import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BillType, EbarimtStatus, OrderStatus, PayMethod, PaymentStatus, Prisma } from '@prisma/client';
import { EbarimtClient, EbarimtReceiptItem } from './ebarimt.client';
import { PrismaService } from '../prisma/prisma.service';

const VAT_RATE_INCLUSIVE = 10 / 110;
const DEFAULT_CLASSIFICATION = '2301010';
const RETRY_OFFSETS_MS = [60_000, 180_000, 300_000];
const STALE_PENDING_MS = 5 * 60_000;

function vatOf(amount: number) {
  return Math.round(amount * VAT_RATE_INCLUSIVE);
}

function payCode(method: PayMethod) {
  if (method === PayMethod.CASH) return 'CASH';
  if (method === PayMethod.CARD) return 'CARD';
  return 'PAYMENT_CARD';
}

@Injectable()
export class EbarimtService {
  private readonly log = new Logger(EbarimtService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: EbarimtClient,
  ) {}

  /**
   * Issue after full payment. Never throws for POSAPI/network failures so checkout is not blocked.
   */
  async issueAfterPaid(orderId: string) {
    try {
      return await this.issueForOrder(orderId, { quiet: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`E-Barimt auto-issue threw for ${orderId}: ${message}`);
      return { ok: false as const, error: message };
    }
  }

  async issueForOrder(orderId: string, opts: { quiet?: boolean } = {}) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } }, payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.ebarimtStatus === EbarimtStatus.ISSUED && order.receiptId) {
      return { ok: true as const, skipped: true, order };
    }

    // Invoices replaced by a fee override (EXPIRED) or that failed are not money owed; judge only the live ones.
    const live = order.payments.filter((p) => p.status !== PaymentStatus.EXPIRED && p.status !== PaymentStatus.FAILED);
    const allPaid = live.length > 0 && live.every((p) => p.status === PaymentStatus.PAID);
    const paidStatus = order.status === OrderStatus.READY_FOR_LOADING || order.status === OrderStatus.COMPLETED;
    if (!allPaid || !paidStatus) {
      if (opts.quiet) {
        this.log.log(`Skip E-Barimt for ${order.orderNumber}: not fully paid`);
        return { ok: false as const, error: 'not_fully_paid' };
      }
      throw new BadRequestException('E-Barimt can only be issued after the order is fully paid');
    }
    if (order.billType === BillType.COMPANY && !order.customerRegNumber) {
      const msg = 'Company receipt requires customerRegNumber (РД)';
      await this.markFailed(order.id, msg, order.ebarimtAttempts);
      if (opts.quiet) return { ok: false as const, error: msg };
      throw new BadRequestException(msg);
    }

    // Claim the issuance atomically so two concurrent callers cannot both send a receipt.
    // A PENDING claim older than STALE_PENDING_MS is treated as abandoned (process died mid-send).
    const claimed = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        OR: [
          { ebarimtStatus: { in: [EbarimtStatus.NOT_ISSUED, EbarimtStatus.FAILED] } },
          { ebarimtStatus: EbarimtStatus.PENDING, updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
        ],
      },
      data: { ebarimtStatus: EbarimtStatus.PENDING, ebarimtError: null },
    });
    if (claimed.count !== 1) {
      this.log.log(`E-Barimt for ${order.orderNumber} is already issued or being issued; skipping`);
      return { ok: true as const, skipped: true, order };
    }

    const totalVAT = vatOf(order.totalMnt);
    const items = this.buildItems(order.items, order.totalMnt, totalVAT);
    const payload = this.client.buildPosapiBody({
      orderNumber: order.orderNumber,
      totalAmount: order.totalMnt,
      totalVAT,
      totalCityTax: 0,
      billType: order.billType,
      customerRegNumber: order.customerRegNumber,
      customerName: order.customerName,
      items,
      payments: order.payments
        .filter((p) => p.status === PaymentStatus.PAID)
        .map((p) => ({ code: payCode(p.method), paidAmount: p.amountMnt })),
    });

    try {
      const result = await this.client.sendReceipt({
        orderNumber: order.orderNumber,
        totalAmount: order.totalMnt,
        totalVAT,
        totalCityTax: 0,
        billType: order.billType,
        customerRegNumber: order.customerRegNumber,
        customerName: order.customerName,
        items,
        payments: order.payments
          .filter((p) => p.status === PaymentStatus.PAID)
          .map((p) => ({ code: payCode(p.method), paidAmount: p.amountMnt })),
      });
      const updated = await this.prisma.order.update({
        where: { id: order.id },
        data: {
          receiptId: result.receiptId,
          lottery: result.lottery,
          qrCode: result.qrData,
          ebarimtStatus: EbarimtStatus.ISSUED,
          ebarimtError: null,
          ebarimtIssuedAt: new Date(),
          ebarimtNextRetryAt: null,
          ebarimtAttempts: { increment: 1 },
          ebarimtPayload: { request: payload, response: result.raw, mock: result.mock } as Prisma.InputJsonValue,
        },
        include: { items: { include: { product: true } }, payments: true },
      });
      this.log.log(`E-Barimt ISSUED ${updated.orderNumber} lottery=${updated.lottery}`);
      return { ok: true as const, skipped: false, order: updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(order.id, message, order.ebarimtAttempts);
      this.log.error(`E-Barimt FAILED ${order.orderNumber}: ${message}`);
      if (opts.quiet) return { ok: false as const, error: message };
      throw new BadRequestException(`E-Barimt issue failed: ${message}`);
    }
  }

  async refundForReturn(input: {
    returnId: string;
    orderNumber: string;
    receiptId?: string | null;
    amount: number;
    items: Array<{ name: string; qty: number; unitPrice: number; totalAmount: number }>;
  }) {
    try {
      const result = await this.client.returnReceipt({
        orderNumber: input.orderNumber,
        receiptId: input.receiptId,
        amount: input.amount,
        items: input.items,
      });
      await this.prisma.salesReturn.update({
        where: { id: input.returnId },
        data: {
          ebarimtRefundId: result.receiptId,
          // A mock receipt is not a real refund receipt; never label it as one.
          ebarimtStatus: result.mock ? 'MOCK_REFUNDED' : 'REFUNDED',
          ebarimtError: null,
        },
      });
      this.log.log(`E-Barimt refund ${result.receiptId} for return ${input.returnId}`);
      return { ok: true as const, receiptId: result.receiptId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.salesReturn.update({
        where: { id: input.returnId },
        data: { ebarimtStatus: 'FAILED', ebarimtError: message.slice(0, 500) },
      });
      this.log.error(`E-Barimt refund failed for ${input.returnId}: ${message}`);
      return { ok: false as const, error: message };
    }
  }

  async retryDue() {
    const due = await this.prisma.order.findMany({
      where: {
        ebarimtStatus: { in: [EbarimtStatus.FAILED, EbarimtStatus.PENDING] },
        ebarimtNextRetryAt: { lte: new Date() },
        status: { not: OrderStatus.CANCELLED },
      },
      take: 30,
    });
    for (const order of due) {
      await this.issueAfterPaid(order.id);
    }
    return { checked: due.length };
  }

  private async markFailed(orderId: string, message: string, attempts: number) {
    const next = attempts + 1;
    const nextPoll =
      next >= RETRY_OFFSETS_MS.length ? null : new Date(Date.now() + RETRY_OFFSETS_MS[Math.min(next - 1, RETRY_OFFSETS_MS.length - 1)]);
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        ebarimtStatus: EbarimtStatus.FAILED,
        ebarimtError: message.slice(0, 500),
        ebarimtAttempts: next,
        ebarimtNextRetryAt: nextPoll,
      },
    });
  }

  private buildItems(
    lines: Array<{
      quantity: Prisma.Decimal;
      unitPrice: number;
      lineTotal: number;
      product: { sku: string; nameMn: string; unit: string };
    }>,
    orderTotal: number,
    orderVat: number,
  ): EbarimtReceiptItem[] {
    const goods = lines.map((line) => ({
      name: line.product.nameMn,
      barCode: line.product.sku,
      classificationCode: DEFAULT_CLASSIFICATION,
      measureUnit: line.product.unit,
      qty: Number(line.quantity),
      unitPrice: line.unitPrice,
      totalAmount: line.lineTotal,
      totalVAT: vatOf(line.lineTotal),
      totalCityTax: 0,
    }));
    const fee = orderTotal - goods.reduce((s, i) => s + i.totalAmount, 0);
    if (fee > 0) {
      goods.push({
        name: 'Хүргэлт / буулгалт',
        barCode: 'LOGISTICS',
        classificationCode: DEFAULT_CLASSIFICATION,
        measureUnit: 'svc',
        qty: 1,
        unitPrice: fee,
        totalAmount: fee,
        totalVAT: vatOf(fee),
        totalCityTax: 0,
      });
    }
    const vatSum = goods.reduce((s, i) => s + i.totalVAT, 0);
    if (goods.length && vatSum !== orderVat) {
      goods[goods.length - 1].totalVAT += orderVat - vatSum;
    }
    return goods;
  }
}
