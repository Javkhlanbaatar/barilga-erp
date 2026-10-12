/* eslint-disable @typescript-eslint/no-explicit-any */
// Fixes from the business-logic audit: stuck half-paid orders, debt on unreleased orders, paying debt in one go.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AccountsService } from '../src/customers/accounts.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };

async function order(w: ReturnType<typeof makePaymentWorld>, total: number, extra: Record<string, unknown> = {}) {
  return w.db.order.create({ data: { orderNumber: `BR-${Math.random()}`, status: 'PENDING_PAYMENT', totalMnt: total, createdById: 'u-a', ...extra } });
}

describe('a half-paid order can always be finished', () => {
  it('cash taken + QPay never paid: the rest is taken another way and the order is released', async () => {
    const w = makePaymentWorld();
    const o = await order(w, 1_000_000);
    await w.service.settleSplits(o.id, [{ method: 'CASH', amount: 600_000 }, { method: 'QPAY', amount: 400_000 }], 'u-a');
    assert.equal((await w.db.order.findUnique({ where: { id: o.id } }))!.status, 'PENDING_PAYMENT');
    await w.service.payRemaining(o.id, 'CARD', 'u-b');
    assert.equal((await w.db.order.findUnique({ where: { id: o.id } }))!.status, 'READY_FOR_LOADING');
    const rows = w.db.payment.rows.filter((p: any) => p.orderId === o.id);
    assert.equal(rows.find((p: any) => p.method === 'QPAY').status, 'EXPIRED');
    const card = rows.find((p: any) => p.method === 'CARD');
    assert.deepEqual([card.amountMnt, card.status, card.recordedById], [400_000, 'PAID', 'u-b']);
    await assert.rejects(() => w.service.payRemaining(o.id, 'CASH', 'u-b'), BadRequestException, 'nothing left to replace');
  });

  it('the cash part is recorded for the cashier who took it', async () => {
    const w = makePaymentWorld();
    const o = await order(w, 5000);
    await w.service.settleSplits(o.id, [{ method: 'CASH', amount: 5000 }], 'u-x');
    assert.equal(w.db.payment.rows[0].recordedById, 'u-x');
  });
});

describe('debt exists only for goods that were released', () => {
  it('the pay-later part of an order still waiting for its QPay cannot be paid or offset yet', async () => {
    const w = makePaymentWorld();
    const o = await order(w, 100_000);
    await w.service.settleSplits(o.id, [{ method: 'CREDIT', amount: 60_000 }, { method: 'QPAY', amount: 40_000 }]);
    await assert.rejects(() => w.service.settleCredit(o.id, 'CASH', 10_000, 'u-c'), BadRequestException);
  });

  it('a pending order does not count as a receivable', async () => {
    const w = makePaymentWorld();
    const partner = await w.db.customer.create({ data: { type: 'COMPANY', name: 'П', phone: '99000000', creditAllowed: true } });
    const o = await order(w, 100_000, { customerId: partner.id });
    await w.service.settleSplits(o.id, [{ method: 'CREDIT', amount: 60_000 }, { method: 'QPAY', amount: 40_000 }]);
    const accounts = new AccountsService(w.db as any, w.service);
    assert.equal((await accounts.balance(partner.id)).receivableMnt, 0);
  });
});

describe('paying off a customer debt in one go', () => {
  it('goes to the oldest orders first and refuses more than is owed', async () => {
    const w = makePaymentWorld();
    const partner = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр', phone: '99000001', creditAllowed: true } });
    const accounts = new AccountsService(w.db as any, w.service);
    const a = await order(w, 50_000, { customerId: partner.id });
    await w.service.settleSplits(a.id, [{ method: 'CREDIT', amount: 50_000 }]);
    const b = await order(w, 80_000, { customerId: partner.id });
    await w.service.settleSplits(b.id, [{ method: 'CREDIT', amount: 80_000 }]);
    await assert.rejects(() => accounts.payDebt(partner.id, 'CASH', 200_000, cashier), BadRequestException);
    const res = await accounts.payDebt(partner.id, 'TRANSFER', 70_000, cashier);
    assert.deepEqual(res.applied.map((x) => x.amountMnt), [50_000, 20_000]);
    assert.equal(res.receivableMnt, 60_000);
    assert.deepEqual(w.receipts, [a.id], 'the first order is fully paid → its receipt is requested');
  });
});
