/* eslint-disable @typescript-eslint/no-explicit-any */
// Invoices: pay-by-invoice orders wait for the bank transfer; the invoice state follows the order's payments.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { InvoicesService } from '../src/orders/invoices.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager' };

async function world() {
  const w = makePaymentWorld({ NODE_ENV: 'development', ORDER_PAYMENT_TTL_MINUTES: '30' });
  const settings: any = { company: async () => ({ name: 'Барилга ХХК', bankAccounts: [{ bankName: 'Хаан', accountNumber: '5000', accountName: 'Барилга' }] }) };
  const invoices = new InvoicesService(w.db as any, new InventoryService(w.db as any), settings);
  const order = await w.db.order.create({
    data: { orderNumber: 'BR-I1', status: 'PENDING_PAYMENT', totalMnt: 300_000, customerName: 'Бат ХХК', customerPhone: '99112233', warehouseId: 'wh-main' },
  });
  return { ...w, invoices, order };
}

describe('pay by invoice (bank transfer awaited)', () => {
  it('the order waits until someone confirms the transfer arrived, then it is released once', async () => {
    const w = await world();
    await w.service.settleSplits(w.order.id, [{ method: 'INVOICE', amount: 300_000 }]);
    let order = await w.db.order.findUnique({ where: { id: w.order.id } });
    assert.equal(order!.status, 'PENDING_PAYMENT', 'goods are not released before the money arrives');
    const row = w.db.payment.rows[0];
    assert.equal(row.method, 'TRANSFER');
    assert.equal(row.status, 'UNPAID');

    await w.service.confirmTransfer(w.order.id, manager.id);
    order = await w.db.order.findUnique({ where: { id: w.order.id } });
    assert.equal(order!.status, 'READY_FOR_LOADING');
    assert.ok(w.db.payment.rows[0].paidAt, 'booked on the day it was confirmed');
    await assert.rejects(() => w.service.confirmTransfer(w.order.id, manager.id), BadRequestException, 'second confirm records nothing');
  });

  it('is not cancelled by the short QPay payment window', async () => {
    const w = await world();
    await w.service.settleSplits(w.order.id, [{ method: 'INVOICE', amount: 300_000 }]);
    await w.db.order.update({ where: { id: w.order.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    await w.service.expireStaleOrders();
    assert.equal((await w.db.order.findUnique({ where: { id: w.order.id } }))!.status, 'PENDING_PAYMENT');
  });

  it('a cash part is taken now and only the rest waits for the transfer', async () => {
    const w = await world();
    await w.service.settleSplits(w.order.id, [
      { method: 'CASH', amount: 100_000 },
      { method: 'INVOICE', amount: 200_000 },
    ]);
    const money = InvoicesService.money({
      dueDate: null, sentAt: new Date(), viewedAt: null, cancelledAt: null,
      order: { status: 'PENDING_PAYMENT' as any, totalMnt: 300_000, payments: w.db.payment.rows as any },
    });
    assert.deepEqual(money, { paidMnt: 100_000, owedMnt: 200_000, state: 'PARTIAL' });
  });
});

describe('invoice state', () => {
  const base = { sentAt: null, viewedAt: null, cancelledAt: null, dueDate: null } as any;
  const order = (payments: any[], status = 'PENDING_PAYMENT') => ({ status, totalMnt: 1000, payments }) as any;

  it('follows the payments: sent → viewed → overdue → paid; cancelled wins', () => {
    const unpaid = [{ status: 'UNPAID', amountMnt: 1000 }];
    assert.equal(InvoicesService.money({ ...base, order: order(unpaid) }).state, 'DRAFT');
    assert.equal(InvoicesService.money({ ...base, sentAt: new Date(), order: order(unpaid) }).state, 'SENT');
    assert.equal(InvoicesService.money({ ...base, sentAt: new Date(), viewedAt: new Date(), order: order(unpaid) }).state, 'VIEWED');
    assert.equal(InvoicesService.money({ ...base, dueDate: new Date(Date.now() - 1000), order: order(unpaid) }).state, 'OVERDUE');
    assert.equal(InvoicesService.money({ ...base, dueDate: new Date(Date.now() - 1000), order: order([{ status: 'PAID', amountMnt: 1000 }], 'READY_FOR_LOADING') }).state, 'PAID');
    assert.equal(InvoicesService.money({ ...base, cancelledAt: new Date(), order: order(unpaid) }).state, 'CANCELLED');
    assert.equal(InvoicesService.money({ ...base, order: order(unpaid, 'CANCELLED') }).state, 'CANCELLED');
  });

  it('an expired QPay invoice that was replaced is not counted as owed', () => {
    const m = InvoicesService.money({ ...base, order: order([{ status: 'EXPIRED', amountMnt: 1000 }, { status: 'PAID', amountMnt: 1000 }], 'READY_FOR_LOADING') });
    assert.deepEqual(m, { paidMnt: 1000, owedMnt: 0, state: 'PAID' });
  });
});

describe('invoice records', () => {
  it('one invoice per order with a numbered, unguessable link; resending updates it', async () => {
    const w = await world();
    const a: any = await w.invoices.create({ orderId: w.order.id, recipientEmail: 'buh@bat.mn', dueDate: '2026-10-20' }, cashier);
    assert.match(a.invoiceNumber, /^NH-\d{8}-0001$/);
    assert.equal(a.token, undefined, 'the link key is not in list responses');
    const again: any = await w.invoices.create({ orderId: w.order.id, note: 'Гэрээ Г-1' }, cashier);
    assert.equal(again.id, a.id);
    assert.equal(again.recipientEmail, 'buh@bat.mn', 'earlier fields are kept');
    assert.equal(w.db.invoice.rows.length, 1);
    assert.ok(w.db.invoice.rows[0].token.length >= 32);
  });

  it('only a manager cancels; a cancelled invoice link stops working', async () => {
    const w = await world();
    const inv: any = await w.invoices.create({ orderId: w.order.id }, cashier);
    await assert.rejects(() => w.invoices.cancel(inv.id, cashier), ForbiddenException);
    await w.invoices.cancel(inv.id, manager);
    await assert.rejects(() => w.invoices.publicView(w.db.invoice.rows[0].token), NotFoundException);
    await assert.rejects(() => w.invoices.publicView('short'), NotFoundException);
  });

  it('refuses an invoice for a cancelled order', async () => {
    const w = await world();
    await w.db.order.update({ where: { id: w.order.id }, data: { status: 'CANCELLED' } });
    await assert.rejects(() => w.invoices.create({ orderId: w.order.id }, cashier), BadRequestException);
  });
});

describe('invoice made at the till', () => {
  it('a bank transfer at the till also waits for the money', async () => {
    const w = await world();
    await w.service.settleSplits(w.order.id, [{ method: 'TRANSFER', amount: 300_000 }]);
    assert.equal((await w.db.order.findUnique({ where: { id: w.order.id } }))!.status, 'PENDING_PAYMENT');
  });

  it('is due in 7 days unless told otherwise, and can be extended by 7 days from today when overdue', async () => {
    const w = await world();
    const inv: any = await w.invoices.create({ orderId: w.order.id } as any, cashier);
    const days = (d: string | Date) => Math.round((new Date(d).getTime() - Date.now()) / 86_400_000);
    assert.ok([7, 8].includes(days(inv.dueDate)), `due in about a week (${days(inv.dueDate)})`);
    await w.db.invoice.update({ where: { id: inv.id }, data: { dueDate: new Date(Date.now() - 2 * 86_400_000) } });
    const ext: any = await w.invoices.extend(inv.id, 7, cashier);
    assert.ok([7, 8].includes(days(ext.dueDate)), 'an overdue invoice gets 7 days from today');
    const again: any = await w.invoices.extend(inv.id, 7, cashier);
    assert.ok([14, 15].includes(days(again.dueDate)), 'a running invoice gets 7 more days');
  });
});
