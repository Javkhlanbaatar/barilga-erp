/* eslint-disable @typescript-eslint/no-explicit-any */
// Standalone invoice at the till ("задгай нэхэмжлэх"): order + invoice in one call with no buyer, the buyer attached
// later (bill type follows), cancelling the invoice of an unpaid order, and the list's state filter.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { InvoicesService } from '../src/orders/invoices.service';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier', email: 'c' };
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager', email: 'm' };

/** Pickup: no delivery fees, so the total is the goods. */
const logistics: any = {
  quote: async ({ specs }: any) => ({
    breakdown: {
      subtotalMnt: specs.subtotalMnt,
      deliveryFeeMnt: 0,
      unloadingFeeMnt: 0,
      timeAdjustmentMnt: 0,
      totalMnt: specs.subtotalMnt,
      assignedVehicle: null,
    },
  }),
};

async function world() {
  const w = makePaymentWorld();
  const features = new FeaturesService(w.db as any);
  const inventory = new InventoryService(w.db as any);
  const settings: any = { company: async () => ({ name: 'Барилга ХХК' }), documents: async () => ({ invoice: {} }) };
  const orders = new OrdersService(w.db as any, logistics, w.service, inventory, {} as any, features);
  const invoices = new InvoicesService(w.db as any, inventory, settings, features, w.service);
  const controller = new OrdersController(orders, {} as any, {} as any, invoices);
  await w.db.product.create({
    data: { id: 'p-cement', sku: 'CEM-1', nameMn: 'Цемент', unit: 'ш', priceMnt: 25_000, weightKg: D(50), volumeM3: D(0.03), lengthM: D(0.5), sourceType: 'INTERNAL', active: true },
  });
  return { ...w, orders, invoices, controller };
}

/** What the POS sends for a standalone invoice: no customer, buyer lines left blank. */
const standalone = (extra: Record<string, unknown> = {}) =>
  ({
    deliveryMethod: 'SELF_PICKUP',
    zoneId: 'zone-a',
    unloadingRequested: false,
    items: [{ productId: 'p-cement', quantity: 4 }],
    customerName: '',
    customerPhone: '',
    paymentMethod: 'INVOICE',
    ...extra,
  }) as any;

describe('standalone invoice at the till', () => {
  it('creates the order and its invoice in one call, with no customer, no cash drawer and no stock moved', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);

    assert.equal(res.status, 'PENDING_PAYMENT', 'goods wait for the money');
    assert.equal(res.customerId, null);
    assert.equal(res.totalMnt, 100_000);
    assert.equal(res.payments.length, 1);
    assert.equal(res.payments[0].method, 'TRANSFER');
    assert.equal(res.payments[0].provider, 'INVOICE');
    assert.equal(res.payments[0].status, 'UNPAID');
    assert.equal(res.payments[0].amountMnt, 100_000);

    assert.equal(w.db.order.rows.length, 1);
    assert.equal(w.db.invoice.rows.length, 1);
    const row = w.db.invoice.rows[0];
    assert.deepEqual(res.invoice, { id: row.id, invoiceNumber: row.invoiceNumber, token: row.token });
    assert.match(res.invoice.invoiceNumber, /^NH-\d{8}-0001$/);
    assert.ok(res.invoice.token.length >= 32);
    assert.equal(res.invoiceError, undefined);
    assert.equal(w.db.stockMovement.rows.length, 0, 'no stock is taken or reserved');

    // «Мөнгө орсон»: only then is the order released.
    await w.orders.confirmTransfer(res.id, cashier);
    assert.equal(w.db.order.rows[0].status, 'READY_FOR_LOADING');
  });

  it('an invoice part of a split is made in the same call too', async () => {
    const w = await world();
    await w.db.cashSession.create({ data: { userId: cashier.id, openingCashMnt: 0 } });
    const res: any = await w.controller.create(
      standalone({ paymentMethod: undefined, payments: [{ method: 'CASH', amount: 40_000 }, { method: 'INVOICE', amount: 60_000 }] }),
      cashier,
    );
    assert.ok(res.invoice?.token);
    assert.equal(res.status, 'PENDING_PAYMENT');
  });

  it('an invoice part goes with cash or card only (not QPay, a transfer or pay-later)', async () => {
    const w = await world();
    await w.db.cashSession.create({ data: { userId: cashier.id, openingCashMnt: 0 } });
    // A buyer allowed to take goods on account, so the pay-later part is refused for being split with the invoice.
    const buyer = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Зээлтэй ХХК', phone: '99007788', creditAllowed: true } });
    for (const other of ['QPAY', 'TRANSFER', 'CREDIT']) {
      await assert.rejects(
        () =>
          w.controller.create(
            standalone({ paymentMethod: undefined, customerId: buyer.id, payments: [{ method: other, amount: 40_000 }, { method: 'INVOICE', amount: 60_000 }] }),
            cashier,
          ),
        (e: any) => e instanceof BadRequestException && /бэлэн эсвэл картаар/.test(e.message),
        other,
      );
    }
    assert.equal(w.db.order.rows.length, 0);
    assert.equal(w.db.invoice.rows.length, 0);
  });

  it('an order paid another way gets no invoice', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone({ paymentMethod: 'TRANSFER' }), cashier);
    assert.ok(!res.invoice, 'no invoice on a plain transfer');
    assert.equal(w.db.invoice.rows.length, 0);
  });

  it('if the invoice cannot be made, the order still comes back once, with the reason to show', async () => {
    const w = await world();
    const broken: any = { createForNewOrder: async () => { throw new Error('db down'); } };
    const controller = new OrdersController(w.orders, {} as any, {} as any, broken);
    const res: any = await controller.create(standalone(), cashier);
    assert.equal(res.status, 'PENDING_PAYMENT');
    assert.equal(res.invoice, null);
    assert.match(res.invoiceError, /нэхэмжлэх/);
    assert.equal(w.db.order.rows.length, 1, 'no second order');
  });
});

describe('buyer attached after the sale', () => {
  it('a company with РД makes the bill a company one; a person makes it a citizen one; the buyer can be replaced', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const company = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр Барилга ХХК', phone: '99001122', regNumber: '6543210', email: 'buh@ondor.mn' } });
    const person = await w.db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Бат', phone: '88001122', regNumber: 'УБ90010112' } });

    const a: any = await w.orders.attachCustomer(res.id, company.id, cashier);
    assert.equal(a.customerId, company.id);
    assert.equal(a.customerName, 'Өндөр Барилга ХХК');
    assert.equal(a.billType, 'COMPANY');
    assert.equal(a.customerRegNumber, '6543210');
    assert.equal(w.db.invoice.rows[0].customerId, company.id);
    assert.equal(w.db.invoice.rows[0].recipientEmail, 'buh@ondor.mn');

    const b: any = await w.orders.attachCustomer(res.id, person.id, cashier);
    assert.equal(b.customerId, person.id);
    assert.equal(b.billType, 'CITIZEN');
    assert.equal(w.db.invoice.rows[0].recipientEmail, null, "the earlier buyer's e-mail does not stay");
  });

  it('the first buyer keeps the link; replacing the buyer gives a new link that counts as not sent', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const first = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр Барилга ХХК', phone: '99001122', regNumber: '6543210' } });
    const second = await w.db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Бат', phone: '88001122' } });
    const blankToken = w.db.invoice.rows[0].token;

    await w.orders.attachCustomer(res.id, first.id, cashier);
    assert.equal(w.db.invoice.rows[0].token, blankToken, 'naming the buyer on a «……» invoice keeps its link');

    await w.db.invoice.update({ where: { id: w.db.invoice.rows[0].id }, data: { sentAt: new Date(), lastSentVia: 'SMS', sendCount: 1 } });
    await w.orders.attachCustomer(res.id, second.id, cashier);
    const inv = w.db.invoice.rows[0];
    assert.notEqual(inv.token, blankToken, "the link sent to the first buyer no longer opens the second buyer's invoice");
    assert.equal(inv.sentAt, null);
    assert.equal(inv.sendCount, 0);
  });

  it('a buyer typed at the till and then replaced by someone else gets new links; the same phone keeps them', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone({ customerName: 'Бат', customerPhone: '88001122' }), cashier);
    const trackingToken = w.db.order.rows[0].trackingToken;
    const invoiceToken = w.db.invoice.rows[0].token;
    const same = await w.db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Бат-Эрдэнэ', phone: '+976 8800 1122' } });
    await w.orders.attachCustomer(res.id, same.id, cashier);
    assert.equal(w.db.invoice.rows[0].token, invoiceToken, 'the same phone is the same buyer: the link stays');
    const other = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр ХХК', phone: '99001122', regNumber: '6543210' } });
    await w.orders.attachCustomer(res.id, other.id, cashier);
    assert.notEqual(w.db.invoice.rows[0].token, invoiceToken, 'another buyer: the invoice link is new');
    assert.equal(w.db.order.rows[0].trackingToken, trackingToken, 'the tracking link (driver, web shop) stays');

    const w2 = await world();
    const res2: any = await w2.controller.create(standalone({ customerName: 'Бат', customerPhone: '88001122' }), cashier);
    const before = w2.db.invoice.rows[0].token;
    const company = await w2.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр ХХК', phone: '99001122', regNumber: '6543210' } });
    await w2.orders.attachCustomer(res2.id, company.id, cashier);
    assert.notEqual(w2.db.invoice.rows[0].token, before, 'a typed buyer replaced straight away by another one');

    // Only a РД typed at the till (no name, no phone) is a buyer too.
    const w3 = await world();
    const res3: any = await w3.controller.create(standalone({ billType: 'COMPANY', customerRegNumber: '1234567' }), cashier);
    const before3 = w3.db.invoice.rows[0].token;
    const sameReg = await w3.db.customer.create({ data: { type: 'COMPANY', name: 'Нэг ХХК', phone: '99110011', regNumber: '1234567' } });
    await w3.orders.attachCustomer(res3.id, sameReg.id, cashier);
    assert.equal(w3.db.invoice.rows[0].token, before3, 'the same РД is the same buyer');
    const w4 = await world();
    const res4: any = await w4.controller.create(standalone({ billType: 'COMPANY', customerRegNumber: '1234567' }), cashier);
    const before4 = w4.db.invoice.rows[0].token;
    const otherReg = await w4.db.customer.create({ data: { type: 'COMPANY', name: 'Өөр ХХК', phone: '99110022', regNumber: '7654321' } });
    await w4.orders.attachCustomer(res4.id, otherReg.id, cashier);
    assert.notEqual(w4.db.invoice.rows[0].token, before4, 'another РД is another buyer');
  });

  it('a company without РД stays a citizen bill', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const c = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Шинэ ХХК', phone: '99112200' } });
    const a: any = await w.orders.attachCustomer(res.id, c.id, cashier);
    assert.equal(a.billType, 'CITIZEN');
    assert.equal(a.customerRegNumber, null);
  });

  it('once the receipt is out, the РД / bill type cannot change, but name and phone still can', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const company = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өндөр Барилга ХХК', phone: '99001122', regNumber: '6543210' } });
    const other = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Өөр ХХК', phone: '99003344', regNumber: '7654321' } });
    const person = await w.db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Бат', phone: '88001122' } });
    await w.orders.attachCustomer(res.id, company.id, cashier);
    await w.db.order.update({ where: { id: res.id }, data: { ebarimtStatus: 'ISSUED' } });

    await assert.rejects(() => w.orders.attachCustomer(res.id, other.id, cashier), (e: any) => e instanceof BadRequestException && /Баримт гарсан/.test(e.message));
    await assert.rejects(() => w.orders.attachCustomer(res.id, person.id, cashier), BadRequestException);

    await w.db.customer.update({ where: { id: company.id }, data: { name: 'Өндөр Барилга ХХК (салбар)', phone: '99005566' } });
    const a: any = await w.orders.attachCustomer(res.id, company.id, cashier);
    assert.equal(a.customerName, 'Өндөр Барилга ХХК (салбар)');
    assert.equal(a.customerPhone, '99005566');
    assert.equal(a.billType, 'COMPANY');
    assert.equal(a.customerRegNumber, '6543210');
  });
});

describe('cancelling the invoice', () => {
  it('of an unpaid order cancels the order too, so it does not wait forever', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const out: any = await w.invoices.cancel(res.invoice.id, manager);
    assert.equal(out.orderCancelled, true);
    assert.equal(out.state, 'CANCELLED');
    assert.equal(w.db.order.rows[0].status, 'CANCELLED');
    assert.equal(w.db.payment.rows[0].status, 'EXPIRED', 'the awaited transfer is closed');
    assert.ok(w.db.invoice.rows[0].cancelledAt);
  });

  it('with money already on the order cancels only the invoice, as before', async () => {
    const w = await world();
    await w.db.cashSession.create({ data: { userId: cashier.id, openingCashMnt: 0 } });
    const res: any = await w.controller.create(
      standalone({ paymentMethod: undefined, payments: [{ method: 'CASH', amount: 40_000 }, { method: 'INVOICE', amount: 60_000 }] }),
      cashier,
    );
    const out: any = await w.invoices.cancel(res.invoice.id, manager);
    assert.equal(out.orderCancelled, false);
    assert.ok(out.orderNote);
    assert.equal(w.db.order.rows[0].status, 'PENDING_PAYMENT');
    assert.ok(w.db.invoice.rows[0].cancelledAt);
  });

  it('by someone whose order-cancel right was taken away cancels only the invoice', async () => {
    const w = await world();
    const res: any = await w.controller.create(standalone(), cashier);
    const restricted = { ...manager, permissions: { revoke: ['ORDER_CANCEL'] } };
    const out: any = await w.invoices.cancel(res.invoice.id, restricted);
    assert.equal(out.orderCancelled, false);
    assert.equal(w.db.order.rows[0].status, 'PENDING_PAYMENT');
  });
});

describe('invoice list state filter', () => {
  it('keeps an old open invoice even behind 500 newer paid ones', async () => {
    const w = await world();
    const day = 86_400_000;
    for (let i = 0; i < 500; i++) {
      const o = await w.db.order.create({ data: { orderNumber: `BR-P${i}`, status: 'READY_FOR_LOADING', totalMnt: 1000, customerName: 'X', warehouseId: 'wh-main' } });
      await w.db.payment.create({ data: { orderId: o.id, method: 'TRANSFER', provider: 'INVOICE', status: 'PAID', amountMnt: 1000 } });
      await w.db.invoice.create({ data: { invoiceNumber: `NH-P${i}`, orderId: o.id, token: `t-paid-${i}`.padEnd(32, 'x'), createdById: manager.id } });
    }
    // The oldest invoice of all, still waiting for its money and past due (the fake keeps rows in insertion order,
    // so it is the last one the 500-row limit would reach).
    const old = await w.db.order.create({ data: { orderNumber: 'BR-OLD', status: 'PENDING_PAYMENT', totalMnt: 5000, customerName: 'Хуучин ХХК', warehouseId: 'wh-main', createdAt: new Date(Date.now() - 90 * day) } });
    await w.db.payment.create({ data: { orderId: old.id, method: 'TRANSFER', provider: 'INVOICE', status: 'UNPAID', amountMnt: 5000 } });
    await w.db.invoice.create({
      data: { invoiceNumber: 'NH-OLD', orderId: old.id, token: 't-old'.padEnd(32, 'x'), createdById: manager.id, createdAt: new Date(Date.now() - 90 * day), dueDate: new Date(Date.now() - 80 * day) },
    });

    const open = await w.invoices.list(manager, { state: 'OPEN' });
    assert.deepEqual(open.invoices.map((i: any) => i.invoiceNumber), ['NH-OLD']);
    assert.equal(open.totals.owedMnt, 5000);
    const overdue = await w.invoices.list(manager, { state: 'OVERDUE' });
    assert.deepEqual(overdue.invoices.map((i: any) => i.invoiceNumber), ['NH-OLD']);
    const paid = await w.invoices.list(manager, { state: 'PAID' });
    assert.equal(paid.invoices.length, 500);
    assert.ok(paid.invoices.every((i: any) => i.state === 'PAID'));
    const cancelled = await w.invoices.list(manager, { state: 'CANCELLED' });
    assert.equal(cancelled.invoices.length, 0);
  });
});
