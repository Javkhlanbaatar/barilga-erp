import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Payment, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { EbarimtService } from '../ebarimt/ebarimt.service';
import { PrismaService } from '../prisma/prisma.service';
import { CheckoutPaymentMethod } from '../orders/dto/order.dto';
import { QpayClient } from './qpay.client';

export const POLL_OFFSETS_MS = [60_000, 180_000, 300_000];

export const LATE_PAYMENT_MARKER = 'LATE_PAYMENT_AFTER_EXPIRY';

export type SplitInput = {
  method: CheckoutPaymentMethod | PayMethod | string;
  amount: number;
};

export type VerifyOutcome = 'paid' | 'late' | 'not_paid' | 'skipped';

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      const text = String(value).trim();
      if (text.length <= 120) return text;
    }
  }
  return null;
}

function appendNote(existing: string | null | undefined, line: string) {
  return [existing?.trim(), line].filter(Boolean).join('\n');
}

/** How an on-account debt is paid: money (cash, card, bank transfer) or netting against what we owe them. */
export type SettleMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'OFFSET';

@Injectable()
export class PaymentService {
  private readonly log = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qpay: QpayClient,
    private readonly config: ConfigService,
    private readonly ebarimt: EbarimtService,
  ) {}

  /**
   * simulate-paid is a development aid only: it is available when NODE_ENV is not "production"
   * AND the QPay adapter is in mock mode. Never in production, whatever the QPay settings are.
   */
  simulationEnabled(): boolean {
    const env = String(this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development')
      .trim()
      .toLowerCase();
    return env !== 'production' && this.qpay.isMock();
  }

  async settleOrder(orderId: string, method: 'QPAY' | 'CASH' | 'CARD' = 'QPAY') {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    return this.settleSplits(orderId, [{ method, amount: order.totalMnt }]);
  }

  /**
   * Persist one row per split. Cash/Card are PAID immediately (cashier recorded).
   * QPay invoices are created only for the QPay slice, not the order total.
   */
  async settleSplits(orderId: string, splits: SplitInput[]) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    const normalized = splits
      .map((s) => ({
        method: this.toPayMethod(s.method),
        amount: Math.round(Number(s.amount)),
        // Sent an invoice: a bank transfer the buyer has not made yet. Held UNPAID until someone confirms it arrived.
        awaiting: s.method === 'INVOICE',
      }))
      .filter((s) => s.amount > 0);

    if (!normalized.length) {
      throw new BadRequestException('At least one payment split with amount > 0 is required');
    }

    if (normalized.filter((s) => s.method === PayMethod.CREDIT).length > 1) {
      throw new BadRequestException('Only one on-account (CREDIT) part per order');
    }
    const sum = normalized.reduce((acc, s) => acc + s.amount, 0);
    if (sum !== order.totalMnt) {
      throw new BadRequestException(
        `Payment splits ${sum}₮ do not equal order total ${order.totalMnt}₮`,
      );
    }

    // 1. All provider calls first. If any QPay invoice cannot be created, nothing has been written yet, so a
    //    cash/card split can never be left recorded as PAID on an order that is then cancelled.
    let qpayIndex = 0;
    const rows: Prisma.PaymentUncheckedCreateInput[] = [];
    for (const split of normalized) {
      if (split.method === PayMethod.QPAY) {
        qpayIndex += 1;
        const invoiceNo = qpayIndex === 1 ? order.orderNumber : `${order.orderNumber}-Q${qpayIndex}`;
        const invoice = await this.qpay.createInvoice({
          senderInvoiceNo: invoiceNo,
          amount: split.amount,
          description: `Barilga ERP ${order.orderNumber} QPay ${split.amount}₮`,
          callbackUrl: this.callbackUrl(),
        });
        rows.push(this.qpayRowData(order.id, split.amount, invoice) as Prisma.PaymentUncheckedCreateInput);
        this.log.log(
          `QPay split invoice ${invoice.invoiceId} for ${order.orderNumber} amount=${split.amount}`,
        );
        continue;
      }
      if (split.method === PayMethod.CREDIT) {
        // Released on account: an UNPAID row holding what the customer still owes. E-Barimt waits until it is paid.
        rows.push({
          orderId: order.id,
          method: PayMethod.CREDIT,
          provider: 'CREDIT',
          amountMnt: split.amount,
          status: PaymentStatus.UNPAID,
          paidAt: null,
          nextPollAt: null,
          qpayPayload: { channel: 'CREDIT', originalMnt: split.amount, settlements: [] },
        });
        continue;
      }
      if (split.awaiting) {
        rows.push({
          orderId: order.id,
          method: PayMethod.TRANSFER,
          provider: 'INVOICE',
          amountMnt: split.amount,
          status: PaymentStatus.UNPAID,
          paidAt: null,
          nextPollAt: null,
          qpayPayload: { channel: 'INVOICE', awaitingTransfer: true },
        });
        continue;
      }
      rows.push({
        orderId: order.id,
        method: split.method,
        provider: split.method,
        amountMnt: split.amount,
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        nextPollAt: null,
        qpayPayload: { channel: split.method, immediate: true, cashierRecorded: true },
      });
    }

    // 2. Every row in one transaction: either all splits are recorded or none are.
    await this.prisma.$transaction(async (tx) => {
      for (const data of rows) await tx.payment.create({ data });
    });
    for (const r of rows) {
      if (r.method !== PayMethod.QPAY) this.log.log(`Cashier recorded ${r.method} ${r.amountMnt}₮ on ${order.orderNumber}`);
    }

    await this.syncOrderStatus(order.id);
    return this.prisma.payment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
  }

  // ---------------------------------------------------------------------------------------------
  // Confirmation: nothing is marked PAID from request data. The provider is always asked.
  // ---------------------------------------------------------------------------------------------

  /**
   * QPay callback. The body is untrusted: it is only used to find which stored invoices to re-check
   * with the provider. It cannot mark anything paid, and repeated callbacks are harmless.
   * No signature/header scheme is assumed: none is documented in this repository.
   */
  async handleWebhook(body: Record<string, unknown>) {
    const invoiceId = firstString(body.object_id, body.invoice_id, body.qpayInvoiceId);
    const senderInvoiceNo = firstString(body.sender_invoice_no);
    this.log.log(`QPay webhook received invoice=${invoiceId ?? 'n/a'} sender=${senderInvoiceNo ?? 'n/a'}`);
    if (!invoiceId && !senderInvoiceNo) {
      return { received: true };
    }

    const or: Prisma.PaymentWhereInput[] = [];
    if (invoiceId) or.push({ qpayInvoiceId: invoiceId });
    if (senderInvoiceNo) {
      or.push({
        order: { orderNumber: senderInvoiceNo.replace(/-[QR]\d+$/, '') },
        status: PaymentStatus.UNPAID,
      });
    }
    const candidates = await this.prisma.payment.findMany({
      where: {
        method: PayMethod.QPAY,
        qpayInvoiceId: { not: null },
        status: { in: [PaymentStatus.UNPAID, PaymentStatus.EXPIRED] },
        OR: or,
      },
      take: 5,
    });

    for (const payment of candidates) {
      try {
        const outcome = await this.verifyAndSettle(payment, 'webhook');
        this.log.log(`Webhook verification for payment ${payment.id}: ${outcome}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Webhook verification failed for payment ${payment.id}: ${message}`);
      }
    }
    return { received: true };
  }

  /**
   * Re-check one QPay split with the provider and, only if the provider confirms the full invoice
   * amount, move it to PAID exactly once. Throws if the provider cannot be reached.
   */
  async verifyAndSettle(payment: Payment, source: string): Promise<VerifyOutcome> {
    if (payment.method !== PayMethod.QPAY || !payment.qpayInvoiceId) return 'skipped';
    if (payment.status !== PaymentStatus.UNPAID && payment.status !== PaymentStatus.EXPIRED) return 'skipped';

    const check = await this.qpay.checkPayment(payment.qpayInvoiceId, payment.amountMnt);
    if (!check.paid) return 'not_paid';

    if (payment.status === PaymentStatus.EXPIRED) {
      await this.recordLatePayment(payment, check.raw);
      return 'late';
    }
    const { transitioned } = await this.settle(payment.id, {
      confirmedBy: source,
      paidAmountMnt: check.paidAmountMnt,
      provider: check.raw,
    });
    return transitioned ? 'paid' : 'skipped';
  }

  /**
   * UNPAID → PAID in a single conditional update, so concurrent webhook/poll/simulate calls
   * cannot both win. Only the winner advances the order (and therefore issues the receipt).
   */
  private async settle(paymentId: string, confirmation: Record<string, unknown>) {
    const current = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!current) throw new NotFoundException('Payment not found');
    const previous =
      current.qpayPayload && typeof current.qpayPayload === 'object' && !Array.isArray(current.qpayPayload)
        ? (current.qpayPayload as Record<string, unknown>)
        : {};
    const claimed = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.UNPAID },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        nextPollAt: null,
        lastPollError: null,
        qpayPayload: { ...previous, confirmation } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count !== 1) {
      return { transitioned: false };
    }
    await this.syncOrderStatus(current.orderId);
    this.log.log(`Split ${paymentId} marked PAID (${current.amountMnt}₮)`);
    return { transitioned: true };
  }

  /** Provider says an invoice we already expired/cancelled was paid. Money moved; do not hide it. */
  private async recordLatePayment(payment: Payment, raw: unknown) {
    if (payment.lastPollError?.startsWith(LATE_PAYMENT_MARKER)) return;
    const message = `${LATE_PAYMENT_MARKER}: provider confirmed ${payment.amountMnt}₮ on expired invoice ${payment.qpayInvoiceId}; reconcile or refund manually`;
    this.log.error(message);
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { lastPollError: message, nextPollAt: null },
    });
    const order = await this.prisma.order.findUnique({ where: { id: payment.orderId } });
    if (order) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { notes: appendNote(order.notes, `[${LATE_PAYMENT_MARKER}] ${payment.amountMnt}₮ ${payment.qpayInvoiceId}`) },
      });
    }
    void raw;
  }

  async simulatePaid(orderId: string) {
    if (!this.simulationEnabled()) {
      throw new ForbiddenException('Payment simulation is disabled outside local development with QPay in mock mode');
    }
    this.log.warn(`Simulated PAID for remaining QPay splits on order ${orderId} (development only)`);
    const pending = await this.prisma.payment.findMany({
      where: { orderId, method: PayMethod.QPAY, status: PaymentStatus.UNPAID },
    });
    for (const p of pending) {
      await this.settle(p.id, { simulated: true });
    }
    return this.prisma.payment.findMany({ where: { orderId } });
  }

  async pollDuePayments() {
    const due = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.UNPAID,
        method: PayMethod.QPAY,
        nextPollAt: { lte: new Date() },
        qpayInvoiceId: { not: null },
      },
      take: 50,
    });

    for (const payment of due) {
      await this.pollOne(payment.id);
    }
    return { checked: due.length };
  }

  /**
   * Order becomes READY_FOR_LOADING only when every live split is PAID and the paid money equals the
   * order total. EXPIRED/FAILED splits (replaced invoices) are ignored. The status flip is a conditional
   * update, so the receipt is requested by exactly one caller.
   */
  private async syncOrderStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return;
    const splits = await this.prisma.payment.findMany({ where: { orderId } });
    const live = splits.filter((s) => s.status !== PaymentStatus.EXPIRED && s.status !== PaymentStatus.FAILED);
    // An open CREDIT row is the part released on account: it does not hold the order back, every other
    // split must be paid. Paid + still-owed must equal the order total.
    const owed = live.filter((s) => s.method === PayMethod.CREDIT && s.status === PaymentStatus.UNPAID);
    const rest = live.filter((s) => !owed.includes(s));
    if (!live.length || !rest.every((s) => s.status === PaymentStatus.PAID)) return;

    const coveredTotal = live.reduce((sum, s) => sum + s.amountMnt, 0);
    if (coveredTotal !== order.totalMnt) {
      this.log.error(
        `Order ${order.orderNumber}: paid+owed ${coveredTotal}₮ != total ${order.totalMnt}₮; not releasing for loading`,
      );
      return;
    }

    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.READY_FOR_LOADING },
    });
    if (claimed.count !== 1) return;
    if (owed.length) {
      const due = owed.reduce((sum, s) => sum + s.amountMnt, 0);
      this.log.log(`Order ${order.orderNumber} released on account (${due}₮ owed) -> READY_FOR_LOADING; E-Barimt after payment`);
      return;
    }
    this.log.log(`Order ${order.orderNumber} all splits PAID -> READY_FOR_LOADING`);
    await this.ebarimt.issueAfterPaid(orderId);
  }

  // ---------------------------------------------------------------------------------------------
  // Goods released on account: collecting what is owed
  // ---------------------------------------------------------------------------------------------

  /** What is still owed on an order released on account (0 when nothing is owed). */
  async outstandingCredit(orderId: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const rows = await db.payment.findMany({ where: { orderId, method: PayMethod.CREDIT, status: PaymentStatus.UNPAID } });
    return { row: rows[0] ?? null, amountMnt: rows.reduce((s, r) => s + r.amountMnt, 0) };
  }

  /**
   * The customer pays (part of) what they owe. Recorded as a normal PAID cash/card row dated today, and the
   * open CREDIT row shrinks by the same amount, so paid + owed always equals the order total. When nothing is
   * owed any more the CREDIT row is closed (PAID at 0₮) and the E-Barimt is issued, because the sale is now
   * fully paid.
   */
  /**
   * A staff member saw the invoiced bank transfer arrive: the awaiting transfer rows become PAID and the order is
   * released. Conditional on the rows still being UNPAID, so two people confirming at once record it once.
   */
  async confirmTransfer(orderId: string, actorId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.CANCELLED) throw new BadRequestException('Order is cancelled');
    const now = new Date();
    const res = await this.prisma.payment.updateMany({
      where: { orderId, method: PayMethod.TRANSFER, status: PaymentStatus.UNPAID },
      data: { status: PaymentStatus.PAID, paidAt: now, qpayPayload: { channel: 'INVOICE', confirmedBy: actorId, confirmedAt: now.toISOString() } },
    });
    if (res.count === 0) throw new BadRequestException('Шилжүүлэг хүлээж буй төлбөр алга / No transfer is awaited on this order');
    this.log.log(`Invoice transfer confirmed on ${order.orderNumber} by ${actorId}`);
    await this.syncOrderStatus(orderId);
    return { confirmed: res.count };
  }

  async settleCredit(orderId: string, method: SettleMethod, amountMnt: number, actorId: string) {
    if (!Number.isInteger(amountMnt) || amountMnt <= 0) throw new BadRequestException('Amount must be a positive whole number');
    const result = await this.prisma.$transaction(
      async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');
        if (order.status === OrderStatus.CANCELLED) throw new BadRequestException('Order is cancelled');
        const { row, amountMnt: owed } = await this.outstandingCredit(orderId, tx);
        if (!row || owed <= 0) throw new BadRequestException('Nothing is owed on this order');
        if (amountMnt > owed) throw new BadRequestException(`Only ${owed}₮ is owed on this order`);
        const now = new Date();
        await tx.payment.create({
          data: {
            orderId,
            method: PayMethod[method],
            provider: method,
            amountMnt,
            status: PaymentStatus.PAID,
            paidAt: now,
            nextPollAt: null,
            qpayPayload: { channel: method, cashierRecorded: true, settlesCredit: row.id, actorId },
          },
        });
        const left = owed - amountMnt;
        const payload = (row.qpayPayload ?? {}) as Prisma.JsonObject;
        const settlements = Array.isArray(payload.settlements) ? payload.settlements : [];
        // Conditional on the amount we read: two cashiers taking the same debt at once cannot both succeed.
        const updated = await tx.payment.updateMany({
          where: { id: row.id, status: PaymentStatus.UNPAID, amountMnt: owed },
          data: {
            amountMnt: left,
            ...(left === 0 ? { status: PaymentStatus.PAID, paidAt: now } : {}),
            qpayPayload: { ...payload, settlements: [...settlements, { at: now.toISOString(), amountMnt, method, actorId }] },
          },
        });
        if (updated.count !== 1) throw new ConflictException('This debt was just changed by someone else; reload and try again');
        return { orderNumber: order.orderNumber, left };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Credit payment ${amountMnt}₮ ${method} on ${result.orderNumber} by ${actorId}; still owed ${result.left}₮`);
    if (result.left === 0) await this.ebarimt.issueAfterPaid(orderId);
    return { owedMnt: result.left };
  }

  // ---------------------------------------------------------------------------------------------
  // Cancel / expire / re-issue (only ever for orders with no confirmed money)
  // ---------------------------------------------------------------------------------------------

  /**
   * Cancel an order that is still awaiting payment and has no PAID split. Unpaid QPay splits become
   * EXPIRED. Orders with any PAID split are refused: refund rules are not defined in this system.
   * Stock is untouched because it is only deducted when the order is COMPLETED.
   */
  async cancelUnpaidOrder(orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException(`Only orders awaiting payment can be cancelled (current: ${order.status})`);
    }
    if (order.payments.some((p) => p.status === PaymentStatus.PAID)) {
      throw new BadRequestException(
        'Order has recorded payments. Cancelling paid money needs a refund process, which is not defined.',
      );
    }

    for (const payment of order.payments) {
      if (payment.status !== PaymentStatus.UNPAID) continue;
      let outcome: VerifyOutcome;
      try {
        outcome = await this.verifyAndSettle(payment, 'cancel-guard');
      } catch {
        throw new ServiceUnavailableException('Cannot confirm payment status with the provider right now; try again');
      }
      if (outcome === 'paid') {
        throw new ConflictException('A payment was just confirmed for this order, so it cannot be cancelled');
      }
    }

    await this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.order.findUnique({ where: { id: orderId } });
        const claimed = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
          data: {
            status: OrderStatus.CANCELLED,
            notes: appendNote(fresh?.notes, `[CANCELLED] ${reason}`),
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Order is no longer awaiting payment');
        }
        await tx.payment.updateMany({
          where: { orderId, status: PaymentStatus.UNPAID },
          data: { status: PaymentStatus.EXPIRED, nextPollAt: null },
        });
        const paid = await tx.payment.count({ where: { orderId, status: PaymentStatus.PAID } });
        if (paid > 0) {
          throw new ConflictException('A payment was confirmed while cancelling; order left unchanged');
        }
        // A supplier assigned before payment is not owed anything for a cancelled order.
        await tx.supplierPayable.updateMany({ where: { orderId, status: 'OPEN' }, data: { status: 'VOID' } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Order ${order.orderNumber} CANCELLED (${reason}); unpaid splits expired`);
  }

  /**
   * Cancels orders left awaiting payment longer than ORDER_PAYMENT_TTL_MINUTES. The TTL is a business
   * decision, so the feature is OFF unless that variable is set to a positive number.
   */
  async expireStaleOrders() {
    const ttlMinutes = Number(this.config.get<string>('ORDER_PAYMENT_TTL_MINUTES') ?? 0);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      return { enabled: false, expired: 0 };
    }
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
    const stale = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: { lt: cutoff },
        payments: { some: {}, none: { status: PaymentStatus.PAID } },
      },
      select: { id: true, payments: { select: { method: true, status: true } } },
      take: 50,
    });
    let expired = 0;
    // An invoiced order waits for the buyer's bank transfer for days, not minutes: the QPay window does not apply.
    for (const { id } of stale.filter((o) => !o.payments.some((p) => p.method === PayMethod.TRANSFER && p.status === PaymentStatus.UNPAID))) {
      try {
        await this.cancelUnpaidOrder(id, `Payment window of ${ttlMinutes} min expired`);
        expired += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`Not expiring order ${id}: ${message}`);
      }
    }
    return { enabled: true, expired };
  }

  /**
   * Replace the order's only unpaid QPay invoice with one for `newTotalMnt`. `applyInTx` must update the
   * order (guarded by status/total) inside the same transaction. Refuses when the old invoice turns out
   * to be paid, or when the payment layout is anything other than one unpaid QPay split.
   */
  async replaceSoleQpayInvoice(
    orderId: string,
    newTotalMnt: number,
    applyInTx: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Fees can only be overridden before payment');
    }
    const live = order.payments.filter((p) => p.status !== PaymentStatus.EXPIRED && p.status !== PaymentStatus.FAILED);
    if (live.some((p) => p.status === PaymentStatus.PAID)) {
      throw new BadRequestException('Fees cannot be changed once any payment has been received');
    }
    if (live.length !== 1 || live[0].method !== PayMethod.QPAY || live[0].status !== PaymentStatus.UNPAID) {
      throw new BadRequestException(
        'Fee override needs exactly one unpaid QPay invoice; cancel and recreate the order for other payment layouts',
      );
    }
    const old = live[0];

    let outcome: VerifyOutcome;
    try {
      outcome = await this.verifyAndSettle(old, 'override-guard');
    } catch {
      throw new ServiceUnavailableException('Cannot confirm payment status with the provider right now; try again');
    }
    if (outcome === 'paid') {
      throw new ConflictException('The invoice was just paid; fees can no longer be changed');
    }

    const attempt = order.payments.filter((p) => p.method === PayMethod.QPAY).length;
    const invoice = await this.qpay.createInvoice({
      senderInvoiceNo: `${order.orderNumber}-R${attempt}`,
      amount: newTotalMnt,
      description: `Barilga ERP ${order.orderNumber} QPay ${newTotalMnt}₮`,
      callbackUrl: this.callbackUrl(),
    });

    await this.prisma.$transaction(
      async (tx) => {
        const expired = await tx.payment.updateMany({
          where: { id: old.id, status: PaymentStatus.UNPAID },
          data: { status: PaymentStatus.EXPIRED, nextPollAt: null },
        });
        if (expired.count !== 1) {
          throw new ConflictException('The payment changed while updating fees; nothing was changed');
        }
        await applyInTx(tx);
        await tx.payment.create({ data: this.qpayRowData(orderId, newTotalMnt, invoice) });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Order ${order.orderNumber}: QPay invoice replaced ${old.qpayInvoiceId} -> ${invoice.invoiceId} (${newTotalMnt}₮)`);
  }

  // ---------------------------------------------------------------------------------------------

  private callbackUrl() {
    return this.config.get<string>('QPAY_CALLBACK_URL') ?? `http://localhost:4000/api/payment/qpay/webhook`;
  }

  private qpayRowData(
    orderId: string,
    amount: number,
    invoice: { invoiceId: string; qrText: string; qrImage: string; raw: unknown },
  ): Prisma.PaymentUncheckedCreateInput {
    return {
      orderId,
      method: PayMethod.QPAY,
      provider: 'QPAY',
      amountMnt: amount,
      status: PaymentStatus.UNPAID,
      qpayInvoiceId: invoice.invoiceId,
      qpayQrText: invoice.qrText,
      qpayQrImage: invoice.qrImage,
      qpayPayload: invoice.raw as Prisma.InputJsonValue,
      pollAttempts: 0,
      nextPollAt: new Date(Date.now() + POLL_OFFSETS_MS[0]),
    };
  }

  private toPayMethod(raw: string): PayMethod {
    if (raw === 'CASH') return PayMethod.CASH;
    if (raw === 'CARD') return PayMethod.CARD;
    if (raw === 'QPAY') return PayMethod.QPAY;
    if (raw === 'CREDIT') return PayMethod.CREDIT;
    if (raw === 'TRANSFER' || raw === 'INVOICE') return PayMethod.TRANSFER;
    throw new BadRequestException(`Unsupported payment method ${raw}`);
  }

  private async pollOne(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== PaymentStatus.UNPAID || !payment.qpayInvoiceId) return;

    try {
      const outcome = await this.verifyAndSettle(payment, 'poll');
      if (outcome === 'paid') return;
      await this.scheduleNextPoll(payment.id, payment.pollAttempts + 1, payment.createdAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`QPay poll failed for ${payment.qpayInvoiceId}: ${message}`);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { lastPollError: message },
      });
      await this.scheduleNextPoll(payment.id, payment.pollAttempts + 1, payment.createdAt);
    }
  }

  private async scheduleNextPoll(paymentId: string, attempts: number, createdAt: Date) {
    if (attempts >= POLL_OFFSETS_MS.length) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { pollAttempts: attempts, nextPollAt: null },
      });
      this.log.warn(`QPay poll exhausted (1m/3m/5m) for payment ${paymentId}`);
      return;
    }
    const nextPollAt = new Date(createdAt.getTime() + POLL_OFFSETS_MS[attempts]);
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { pollAttempts: attempts, nextPollAt },
    });
    this.log.log(`Next QPay poll for ${paymentId} at ${nextPollAt.toISOString()} (attempt ${attempts})`);
  }
}
