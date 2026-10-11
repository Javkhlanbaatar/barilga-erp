/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { LATE_PAYMENT_MARKER } from '../src/payment/payment.service';
import { QpayClient, assertProductionQpayConfig, extractPaidAmountMnt } from '../src/payment/qpay.client';
import { makeConfig, makePaymentWorld, seedQpayOrder } from './helpers/payment-fixtures';

describe('QPay webhook is an untrusted hint', () => {
  it('does not mark an order paid just because the webhook body says PAID', async () => {
    const w = makePaymentWorld();
    const { order, invoiceId } = await seedQpayOrder(w);
    await w.service.handleWebhook({ object_id: invoiceId, payment_status: 'PAID', amount: 26000 });
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');
    assert.equal(w.receipts.length, 0);
    assert.equal(w.provider.checks, 1, 'the provider must have been asked');
  });

  it('ignores a webhook with no usable invoice reference and never calls the provider', async () => {
    const w = makePaymentWorld();
    await seedQpayOrder(w);
    const res = await w.service.handleWebhook({ payment_status: 'PAID' });
    assert.deepEqual(res, { received: true });
    assert.equal(w.provider.checks, 0);
  });

  it('marks PAID only when the provider confirms the full invoice amount', async () => {
    const w = makePaymentWorld();
    const { order, invoiceId } = await seedQpayOrder(w, { total: 26_000 });
    w.provider.paid.set(invoiceId, 10_000); // underpaid
    await w.service.handleWebhook({ object_id: invoiceId });
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');

    w.provider.paid.set(invoiceId, 26_000);
    await w.service.handleWebhook({ object_id: invoiceId });
    assert.equal(w.db.payment.rows[0].status, 'PAID');
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'READY_FOR_LOADING');
  });

  it('a repeated webhook does not re-process the payment or issue a second receipt', async () => {
    const w = makePaymentWorld();
    const { invoiceId } = await seedQpayOrder(w);
    w.provider.paid.set(invoiceId, 26_000);
    await w.service.handleWebhook({ object_id: invoiceId });
    const checksAfterFirst = w.provider.checks;
    await w.service.handleWebhook({ object_id: invoiceId });
    await w.service.handleWebhook({ object_id: invoiceId });
    assert.equal(w.receipts.length, 1);
    assert.equal(w.provider.checks, checksAfterFirst, 'PAID payments are not re-checked');
  });

  it('concurrent webhooks for the same invoice issue exactly one receipt', async () => {
    const w = makePaymentWorld();
    const { invoiceId } = await seedQpayOrder(w);
    w.provider.paid.set(invoiceId, 26_000);
    await Promise.all(Array.from({ length: 8 }, () => w.service.handleWebhook({ object_id: invoiceId })));
    assert.equal(w.db.payment.rows.filter((p) => p.status === 'PAID').length, 1);
    assert.equal(w.receipts.length, 1);
  });

  it('can map a callback by sender_invoice_no but still verifies with the provider', async () => {
    const w = makePaymentWorld();
    const { invoiceId } = await seedQpayOrder(w, { orderNumber: 'BR-20261011-0042' });
    await w.service.handleWebhook({ sender_invoice_no: 'BR-20261011-0042', payment_status: 'PAID' });
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');
    w.provider.paid.set(invoiceId, 26_000);
    await w.service.handleWebhook({ sender_invoice_no: 'BR-20261011-0042' });
    assert.equal(w.db.payment.rows[0].status, 'PAID');
  });

  it('a provider outage leaves the payment unpaid and does not throw to the caller', async () => {
    const w = makePaymentWorld();
    const { invoiceId } = await seedQpayOrder(w);
    w.provider.failChecks = true;
    const res = await w.service.handleWebhook({ object_id: invoiceId });
    assert.deepEqual(res, { received: true });
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');
  });

  it('holds the order back when paid money does not equal the order total', async () => {
    const w = makePaymentWorld();
    const { order, invoiceId } = await seedQpayOrder(w, { total: 26_000 });
    await w.db.order.update({ where: { id: order.id }, data: { totalMnt: 31_000 } }); // total drifted
    w.provider.paid.set(invoiceId, 26_000);
    await w.service.handleWebhook({ object_id: invoiceId });
    assert.equal(w.db.payment.rows[0].status, 'PAID');
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');
    assert.equal(w.receipts.length, 0);
  });

  it('records, but does not apply, a payment that arrives after the invoice expired', async () => {
    const w = makePaymentWorld();
    const { order, invoiceId } = await seedQpayOrder(w);
    await w.service.cancelUnpaidOrder(order.id, 'test');
    w.provider.paid.set(invoiceId, 26_000);
    await w.service.handleWebhook({ object_id: invoiceId });
    const payment = w.db.payment.rows[0];
    assert.equal(payment.status, 'EXPIRED');
    assert.ok(String(payment.lastPollError).startsWith(LATE_PAYMENT_MARKER));
    const o = (await w.db.order.findUnique({ where: { id: order.id } }))!;
    assert.equal(o.status, 'CANCELLED');
    assert.match(String(o.notes), new RegExp(LATE_PAYMENT_MARKER));
    assert.equal(w.receipts.length, 0);
  });
});

describe('QpayClient.checkPayment amount verification', () => {
  function client(responseData: unknown) {
    const c = new QpayClient(makeConfig({ QPAY_USERNAME: 'u', QPAY_PASSWORD: 'p', QPAY_MOCK: 'false' }));
    (c as any).authenticate = async () => 'token';
    (c as any).http = { post: async () => ({ data: responseData }) };
    return c;
  }

  it('confirms only PAID rows that cover the expected amount', async () => {
    const ok = await client({ count: 1, rows: [{ payment_status: 'PAID', payment_amount: 26000 }] }).checkPayment('i', 26000);
    assert.equal(ok.paid, true);
    const short = await client({ count: 1, rows: [{ payment_status: 'PAID', payment_amount: 1000 }] }).checkPayment('i', 26000);
    assert.equal(short.paid, false);
    const notPaid = await client({ count: 1, rows: [{ payment_status: 'NEW', payment_amount: 26000 }] }).checkPayment('i', 26000);
    assert.equal(notPaid.paid, false);
    const empty = await client({ count: 0, rows: [] }).checkPayment('i', 26000);
    assert.equal(empty.paid, false);
  });

  it('fails closed when a PAID row has no readable amount', async () => {
    const res = await client({ count: 1, rows: [{ payment_status: 'PAID' }] }).checkPayment('i', 26000);
    assert.equal(res.paid, false);
    assert.equal(res.paidAmountMnt, null);
    assert.equal(extractPaidAmountMnt({ rows: [{ payment_status: 'PAID', payment_amount: 'x' }] }), null);
  });

  it('mock mode never confirms a payment', async () => {
    const mock = new QpayClient(makeConfig({ QPAY_MOCK: 'true' }));
    assert.equal((await mock.checkPayment('MOCK-1', 1)).paid, false);
    const noCreds = new QpayClient(makeConfig({}));
    assert.equal((await noCreds.checkPayment('MOCK-1', 1)).paid, false);
  });

  it('a webhook cannot settle an order while QPay is in mock mode', async () => {
    const w = makePaymentWorld();
    const mockClient = new QpayClient(makeConfig({ QPAY_MOCK: 'true' }));
    (w.service as any).qpay = mockClient;
    const { invoiceId } = await seedQpayOrder(w);
    await w.service.handleWebhook({ object_id: invoiceId, payment_status: 'PAID' });
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');
  });
});

describe('QPay production configuration', () => {
  const live = {
    NODE_ENV: 'production',
    QPAY_MOCK: 'false',
    QPAY_USERNAME: 'configured',
    QPAY_PASSWORD: 'configured',
    QPAY_INVOICE_CODE: 'configured',
    QPAY_CALLBACK_URL: 'https://erp.example.com/api/payment/qpay/webhook',
  };

  it('accepts a complete live production configuration', () => {
    assert.doesNotThrow(() => assertProductionQpayConfig(makeConfig(live)));
  });

  it('refuses explicit mock mode in production', () => {
    assert.throws(
      () => new QpayClient(makeConfig({ ...live, QPAY_MOCK: 'true' })),
      /QPAY_MOCK must be false/,
    );
  });

  it('refuses missing production credentials without exposing configured values', () => {
    const secret = 'do-not-print-this-secret';
    assert.throws(
      () => new QpayClient(makeConfig({ ...live, QPAY_PASSWORD: secret, QPAY_USERNAME: '   ' })),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /QPAY_USERNAME is required/);
        assert.doesNotMatch(message, new RegExp(secret));
        return true;
      },
    );
  });
});

describe('simulate-paid is development-only', () => {
  it('is refused in production, even with QPay mock on', async () => {
    const w = makePaymentWorld({ NODE_ENV: 'production' });
    w.provider.mock = true;
    const { order } = await seedQpayOrder(w);
    assert.equal(w.service.simulationEnabled(), false);
    await assert.rejects(() => w.service.simulatePaid(order.id), ForbiddenException);
    assert.equal(w.db.payment.rows[0].status, 'UNPAID');
  });

  it('is refused when QPay is configured for real, even outside production', async () => {
    const w = makePaymentWorld({ NODE_ENV: 'development' });
    w.provider.mock = false;
    const { order } = await seedQpayOrder(w);
    await assert.rejects(() => w.service.simulatePaid(order.id), ForbiddenException);
  });

  it('works in development with mock QPay, and still issues one receipt', async () => {
    const w = makePaymentWorld({ NODE_ENV: 'development' });
    w.provider.mock = true;
    const { order } = await seedQpayOrder(w);
    await w.service.simulatePaid(order.id);
    await w.service.simulatePaid(order.id);
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'READY_FOR_LOADING');
    assert.equal(w.receipts.length, 1);
  });

  it('treats an unset NODE_ENV as non-production only when env also says so', async () => {
    const w = makePaymentWorld({ NODE_ENV: ' Production ' });
    assert.equal(w.service.simulationEnabled(), false);
  });
});

describe('cancel and expire never touch money that was received', () => {
  it('cancels an unpaid order and expires its invoice', async () => {
    const w = makePaymentWorld();
    const { order } = await seedQpayOrder(w);
    await w.service.cancelUnpaidOrder(order.id, 'customer left');
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'CANCELLED');
    assert.equal(w.db.payment.rows[0].status, 'EXPIRED');
  });

  it('refuses to cancel an order that has a paid split', async () => {
    const w = makePaymentWorld();
    const { order } = await seedQpayOrder(w);
    await w.db.payment.create({ data: { orderId: order.id, method: 'CASH', provider: 'CASH', amountMnt: 100, status: 'PAID' } });
    await assert.rejects(() => w.service.cancelUnpaidOrder(order.id, 'x'), BadRequestException);
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');
  });

  it('turns a last-second provider payment into PAID instead of cancelling', async () => {
    const w = makePaymentWorld();
    const { order, invoiceId } = await seedQpayOrder(w);
    w.provider.paid.set(invoiceId, 26_000);
    await assert.rejects(() => w.service.cancelUnpaidOrder(order.id, 'x'), ConflictException);
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'READY_FOR_LOADING');
  });

  it('does not cancel when the provider cannot be reached', async () => {
    const w = makePaymentWorld();
    const { order } = await seedQpayOrder(w);
    w.provider.failChecks = true;
    await assert.rejects(() => w.service.cancelUnpaidOrder(order.id, 'x'));
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');
  });

  it('refuses to cancel an order that is no longer awaiting payment', async () => {
    const w = makePaymentWorld();
    const { order } = await seedQpayOrder(w);
    await w.db.order.update({ where: { id: order.id }, data: { status: 'READY_FOR_LOADING' } });
    await assert.rejects(() => w.service.cancelUnpaidOrder(order.id, 'x'), BadRequestException);
  });

  it('expiry is OFF unless ORDER_PAYMENT_TTL_MINUTES is set', async () => {
    const w = makePaymentWorld({ NODE_ENV: 'development' });
    const { order } = await seedQpayOrder(w);
    await w.db.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    assert.deepEqual(await w.service.expireStaleOrders(), { enabled: false, expired: 0 });
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');
  });

  it('with a TTL, expires only stale unpaid orders', async () => {
    const w = makePaymentWorld({ NODE_ENV: 'development', ORDER_PAYMENT_TTL_MINUTES: '30' });
    const stale = await seedQpayOrder(w, { orderNumber: 'BR-20261011-0001' });
    const fresh = await seedQpayOrder(w, { orderNumber: 'BR-20261011-0002' });
    const partlyPaid = await seedQpayOrder(w, { orderNumber: 'BR-20261011-0003' });
    const old = new Date(Date.now() - 3 * 3_600_000);
    await w.db.order.update({ where: { id: stale.order.id }, data: { createdAt: old } });
    await w.db.order.update({ where: { id: partlyPaid.order.id }, data: { createdAt: old } });
    await w.db.payment.create({
      data: { orderId: partlyPaid.order.id, method: 'CASH', provider: 'CASH', amountMnt: 5, status: 'PAID' },
    });
    const res = await w.service.expireStaleOrders();
    assert.deepEqual(res, { enabled: true, expired: 1 });
    const status = async (id: string) => (await w.db.order.findUnique({ where: { id } }))!.status;
    assert.equal(await status(stale.order.id), 'CANCELLED');
    assert.equal(await status(fresh.order.id), 'PENDING_PAYMENT');
    assert.equal(await status(partlyPaid.order.id), 'PENDING_PAYMENT');
  });
});
