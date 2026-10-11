/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../../src/payment/payment.service';
import { QpayClient } from '../../src/payment/qpay.client';
import { FakeDb, tick } from './fake-db';

export type ProviderState = {
  /** invoiceId -> money the (fake) provider reports as paid. */
  paid: Map<string, number>;
  checks: number;
  created: Array<{ senderInvoiceNo: string; amount: number }>;
  mock: boolean;
  failChecks: boolean;
};

export function makeConfig(env: Record<string, string | undefined> = {}) {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

export function makePaymentWorld(env: Record<string, string | undefined> = { NODE_ENV: 'development' }) {
  const db = new FakeDb();
  const provider: ProviderState = { paid: new Map(), checks: 0, created: [], mock: true, failChecks: false };
  const receipts: string[] = [];

  const qpay = {
    isMock: () => provider.mock,
    createInvoice: async (params: { senderInvoiceNo: string; amount: number }) => {
      provider.created.push({ senderInvoiceNo: params.senderInvoiceNo, amount: params.amount });
      return {
        invoiceId: `INV-${params.senderInvoiceNo}`,
        qrText: 'qr',
        qrImage: 'img',
        raw: { fake: true },
        mock: provider.mock,
      };
    },
    checkPayment: async (invoiceId: string, expected: number) => {
      provider.checks += 1;
      await tick();
      if (provider.failChecks) throw new Error('provider down');
      const paidAmountMnt = provider.paid.get(invoiceId) ?? 0;
      return { paid: paidAmountMnt >= expected && paidAmountMnt > 0, paidAmountMnt, raw: { invoiceId } };
    },
  } as unknown as QpayClient;

  const ebarimt = { issueAfterPaid: async (id: string) => void receipts.push(id) } as any;
  const service = new PaymentService(db as any, qpay, makeConfig(env), ebarimt);
  return { db, provider, receipts, service, qpay };
}

/** An order awaiting payment with one unpaid QPay invoice. */
export async function seedQpayOrder(
  world: ReturnType<typeof makePaymentWorld>,
  opts: { total?: number; orderNumber?: string; orderId?: string } = {},
) {
  const total = opts.total ?? 26_000;
  const orderNumber = opts.orderNumber ?? 'BR-20261011-0001';
  const order = await world.db.order.create({
    data: { id: opts.orderId, orderNumber, totalMnt: total, status: 'PENDING_PAYMENT' },
  });
  const payment = await world.db.payment.create({
    data: { orderId: order.id, amountMnt: total, qpayInvoiceId: `INV-${orderNumber}`, status: 'UNPAID' },
  });
  return { order, payment, invoiceId: `INV-${orderNumber}` };
}
