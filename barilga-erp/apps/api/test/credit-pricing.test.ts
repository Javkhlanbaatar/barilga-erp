/* eslint-disable @typescript-eslint/no-explicit-any */
// Goods released on account (CREDIT), customer price lists, and pickup orders not limited by truck size.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { CustomersService } from '../src/customers/customers.service';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { quoteFees } from '../src/logistics/logistics.engine';
import { OrdersService } from '../src/orders/orders.service';
import { ReturnsService } from '../src/returns/returns.service';
import { FakeDb } from './helpers/fake-db';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier', email: 'c' };
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager', email: 'm' };

async function creditOrder(total = 100_000, splits?: Array<{ method: string; amount: number }>) {
  const w = makePaymentWorld();
  const order = await w.db.order.create({ data: { orderNumber: 'BR-20261012-0009', status: 'PENDING_PAYMENT', totalMnt: total } });
  await w.service.settleSplits(order.id, (splits ?? [{ method: 'CREDIT', amount: total }]) as any);
  return { ...w, order };
}
const status = (w: { db: FakeDb }, id: string) => w.db.order.rows.find((o: any) => o.id === id)!.status;
const creditRow = (w: { db: FakeDb }) => w.db.payment.rows.find((p: any) => p.method === 'CREDIT')!;

describe('goods released on account (зарлагаар олгох)', () => {
  it('the order goes to loading at once, the debt stays open and no E-Barimt is issued yet', async () => {
    const w = await creditOrder();
    assert.equal(status(w, w.order.id), 'READY_FOR_LOADING');
    assert.equal(creditRow(w).status, 'UNPAID');
    assert.equal(creditRow(w).amountMnt, 100_000);
    assert.deepEqual(w.receipts, [], 'E-Barimt waits for payment');
  });

  it('part cash now, the rest on account', async () => {
    const w = await creditOrder(100_000, [
      { method: 'CASH', amount: 30_000 },
      { method: 'CREDIT', amount: 70_000 },
    ]);
    assert.equal(status(w, w.order.id), 'READY_FOR_LOADING');
    assert.equal((await w.service.outstandingCredit(w.order.id)).amountMnt, 70_000);
  });

  it('partial payments shrink the debt; the last one closes it and issues the E-Barimt', async () => {
    const w = await creditOrder();
    assert.deepEqual(await w.service.settleCredit(w.order.id, 'CASH', 40_000, 'u-c'), { owedMnt: 60_000 });
    assert.deepEqual(w.receipts, []);
    assert.deepEqual(await w.service.settleCredit(w.order.id, 'CARD', 60_000, 'u-c'), { owedMnt: 0 });
    assert.equal(creditRow(w).status, 'PAID');
    assert.equal(creditRow(w).amountMnt, 0);
    const paid = w.db.payment.rows.filter((p: any) => p.status === 'PAID').reduce((s: number, p: any) => s + p.amountMnt, 0);
    assert.equal(paid, 100_000, 'paid rows always add up to the order total');
    assert.deepEqual(w.receipts, [w.order.id], 'E-Barimt issued once fully paid');
  });

  it('cannot pay more than is owed, nor pay on an order that owes nothing', async () => {
    const w = await creditOrder(50_000);
    await assert.rejects(() => w.service.settleCredit(w.order.id, 'CASH', 50_001, 'u-c'), BadRequestException);
    await w.service.settleCredit(w.order.id, 'CASH', 50_000, 'u-c');
    await assert.rejects(() => w.service.settleCredit(w.order.id, 'CASH', 1, 'u-c'), BadRequestException);
  });

  it('two cashiers taking the same debt at once cannot both succeed', async () => {
    const w = await creditOrder(50_000);
    const results = await Promise.allSettled([
      w.service.settleCredit(w.order.id, 'CASH', 50_000, 'u-1'),
      w.service.settleCredit(w.order.id, 'CASH', 50_000, 'u-2'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const cash = w.db.payment.rows.filter((p: any) => p.method === 'CASH');
    assert.equal(cash.length, 1, 'only one payment recorded');
  });

  it('only one on-account part per order', async () => {
    const w = makePaymentWorld();
    const order = await w.db.order.create({ data: { orderNumber: 'BR-X', status: 'PENDING_PAYMENT', totalMnt: 10 } });
    await assert.rejects(
      () => w.service.settleSplits(order.id, [{ method: 'CREDIT', amount: 5 }, { method: 'CREDIT', amount: 5 }] as any),
      BadRequestException,
    );
  });
});

describe('returns on an order that is still owed', () => {
  async function setup() {
    const w = await creditOrder(5000);
    const inventory = new InventoryService(w.db as any);
    const returns = new ReturnsService(w.db as any, inventory, {} as any);
    const p = await w.db.product.create({ data: { sku: 'X', nameMn: 'X', stockQty: D(0) } });
    await w.db.order.update({ where: { id: w.order.id }, data: { warehouseId: 'wh-main' } });
    const item = await w.db.orderItem.create({
      data: { orderId: w.order.id, productId: p.id, quantity: D(5), unitPrice: 1000, lineTotal: 5000, sourceType: 'INTERNAL' },
    });
    const ret = (qty: number, refundMethod: string) =>
      (returns as any).processReturn(w.db, w.order.id, { reason: 'test', refundMethod, items: [{ orderItemId: item.id, quantity: qty }] }, manager);
    return { ...w, ret };
  }

  it('lowers the debt instead of handing out money', async () => {
    const w = await setup();
    await w.ret(2, 'CREDIT');
    assert.equal(creditRow(w).amountMnt, 3000);
    assert.equal(w.db.salesReturn.rows[0].refundStatus, 'PAID_OUT');
  });

  it('refuses a cash refund while anything is owed, and a CREDIT refund larger than the debt', async () => {
    const w = await setup();
    await assert.rejects(() => w.ret(1, 'CASH'), BadRequestException);
    await w.service.settleCredit(w.order.id, 'CASH', 4000, 'u-c');
    await assert.rejects(() => w.ret(2, 'CREDIT'), BadRequestException, '2000₮ return > 1000₮ owed');
    assert.equal(creditRow(w).amountMnt, 1000);
  });
});

describe('customer price lists', () => {
  async function world() {
    const db = new FakeDb();
    const features = new FeaturesService(db as any);
    const orders = new OrdersService(db as any, {} as any, {} as any, new InventoryService(db as any), {} as any, features);
    const customers = new CustomersService(db as any);
    const cement = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', priceMnt: 18_500, weightKg: D(50), volumeM3: D(0.04), lengthM: D(0.6) } });
    const sand = await db.product.create({ data: { sku: 'SAND', nameMn: 'Элс', priceMnt: 45_000, weightKg: D(1600), volumeM3: D(1), lengthM: D(0) } });
    const list = await db.priceList.create({ data: { name: 'Өртгийн үнэ', isActive: true } });
    await db.priceListItem.create({ data: { priceListId: list.id, productId: cement.id, priceMnt: 15_000 } });
    return { db, features, orders, customers, cement, sand, list };
  }

  it('a customer on a list buys listed products at the list price and the rest at retail', async () => {
    const w = await world();
    const c = await w.customers.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233', priceListId: w.list.id } as any, manager);
    const customer = await (w.orders as any).resolveCustomer(c.id);
    const { lines } = await w.orders.buildSpecs(
      [{ productId: w.cement.id, quantity: 10 }, { productId: w.sand.id, quantity: 1 }],
      customer.prices,
    );
    assert.equal(lines[0].unitPrice, 15_000);
    assert.equal(lines[0].lineTotal, 150_000);
    assert.equal(lines[1].unitPrice, 45_000, 'not in the list → retail');
  });

  it('switching the module or the list off brings back retail prices', async () => {
    const w = await world();
    const c = await w.customers.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233', priceListId: w.list.id } as any, manager);
    await w.features.set('PRICE_LISTS', false, 'u-admin');
    assert.equal((await (w.orders as any).resolveCustomer(c.id)).prices, undefined);
    await w.features.set('PRICE_LISTS', true, 'u-admin');
    await w.db.priceList.update({ where: { id: w.list.id }, data: { isActive: false } });
    assert.equal((await (w.orders as any).resolveCustomer(c.id)).prices, undefined);
  });

  it('only a manager or admin can put a customer on a price list', async () => {
    const w = await world();
    await assert.rejects(
      () => w.customers.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233', priceListId: w.list.id } as any, cashier),
      ForbiddenException,
    );
    const c = await w.customers.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233' } as any, cashier);
    await assert.rejects(() => w.customers.update(c.id, { priceListId: w.list.id }, cashier), ForbiddenException);
    await w.customers.update(c.id, { name: 'Бат-Эрдэнэ', priceListId: null }, cashier); // untouched list: allowed
    const updated = await w.customers.update(c.id, { priceListId: w.list.id }, manager);
    assert.equal(updated!.priceListId, w.list.id);
  });
});

describe('pickup orders are not limited by truck size', () => {
  const vehicles = [{ code: 'PORTER' as const, maxWeightKg: 1500, maxLengthM: 3, maxVolumeM3: 8, sortOrder: 1 }];
  const zone = { code: 'ZONE_A' as const, baseDeliveryFeeMnt: 25_000, nightDiscountApplies: true };
  const huge = { subtotalMnt: 1_000_000, weightKg: 200_000, maxLengthM: 12, volumeM3: 150 };

  it('a customer collecting 200 t is quoted with no truck and no fees', () => {
    const b = quoteFees({ specs: huge, zone, method: 'SELF_PICKUP', time: 'STANDARD', unloadingRequested: false, vehicles } as any);
    assert.equal(b.assignedVehicle, null);
    assert.equal(b.totalMnt, 1_000_000);
  });

  it('our delivery of the same order is still refused', () => {
    assert.throws(() => quoteFees({ specs: huge, zone, method: 'OUR_DELIVERY', time: 'STANDARD', unloadingRequested: false, vehicles } as any));
  });
});


describe('E-Barimt for an order paid after part of it was returned', () => {
  it('covers only what was kept and paid for, without 0₮ payment rows', async () => {
    const { EbarimtService } = await import('../src/ebarimt/ebarimt.service');
    const db = new FakeDb();
    const p = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', unit: 'bag' } });
    const order = await db.order.create({
      data: { orderNumber: 'BR-E1', status: 'READY_FOR_LOADING', totalMnt: 150_000, billType: 'CITIZEN', customerName: 'Номин' },
    });
    const item = await db.orderItem.create({ data: { orderId: order.id, productId: p.id, quantity: D(10), unitPrice: 15_000, lineTotal: 150_000 } });
    await db.returnItem.create({ data: { orderItemId: item.id, quantity: D(2), lineRefund: 30_000 } });
    await db.payment.create({ data: { orderId: order.id, method: 'CREDIT', amountMnt: 0, status: 'PAID' } });
    await db.payment.create({ data: { orderId: order.id, method: 'CASH', amountMnt: 120_000, status: 'PAID' } });
    let sent: any = null;
    const client: any = {
      buildPosapiBody: (b: any) => b,
      sendReceipt: async (b: any) => ((sent = b), { receiptId: 'R', lottery: 'L', qrData: 'Q', raw: {} }),
    };
    await new EbarimtService(db as any, client).issueForOrder(order.id, { quiet: true });
    assert.equal(sent.totalAmount, 120_000);
    assert.equal(sent.items[0].qty, 8);
    assert.equal(sent.items[0].totalAmount, 120_000);
    assert.deepEqual(sent.payments.map((x: any) => x.paidAmount), [120_000]);
  });
});
