/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression tests for the staff-role / business-logic audit fixes.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { EbarimtService } from '../src/ebarimt/ebarimt.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { OrdersService } from '../src/orders/orders.service';
import { ReturnsService } from '../src/returns/returns.service';
import { FakeDb } from './helpers/fake-db';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const cashierA: any = { id: 'u-ca', role: Role.BORLUULAGCH, name: 'Cashier A', warehouseId: 'wh-main' };
const cashierB: any = { id: 'u-cb', role: Role.BORLUULAGCH, name: 'Cashier B', warehouseId: 'wh-b' };
const loaderB: any = { id: 'u-lb', role: Role.ACHIGCH_BELTGEGCH, name: 'Loader B', warehouseId: 'wh-b' };

function ordersWorld() {
  const w = makePaymentWorld();
  const inventory = new InventoryService(w.db as any);
  const orders = new OrdersService(w.db as any, {} as any, w.service, inventory, { issueForOrder: async () => ({}) } as any);
  return { ...w, inventory, orders };
}

describe('staff locked to a warehouse cannot change another warehouse\'s orders', () => {
  async function setup() {
    const w = ordersWorld();
    await w.db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B' } });
    const order = await w.db.order.create({
      data: { orderNumber: 'BR-20261012-0001', status: 'PENDING_PAYMENT', totalMnt: 5000, warehouseId: 'wh-main', deliveryMethod: 'OUR_DELIVERY' },
    });
    return { ...w, order };
  }

  it('cancel is refused before anything is written', async () => {
    const w = await setup();
    await assert.rejects(() => w.orders.cancel(w.order.id, cashierB), ForbiddenException);
    assert.equal(w.db.order.rows[0].status, 'PENDING_PAYMENT', 'the other shop\'s order is untouched');
  });

  it('fee override, transport notes and E-Barimt are refused for another warehouse', async () => {
    const w = await setup();
    await assert.rejects(
      () => w.orders.overrideFees(w.order.id, { deliveryFeeMnt: 0, unloadingFeeMnt: 0, timeAdjustmentMnt: 0, reason: 'x' } as any, cashierB),
      ForbiddenException,
    );
    await assert.rejects(
      () => w.orders.assignDriver(w.order.id, { vehicleNumber: '1234УБА', driverPhone: '99112233' } as any, loaderB),
      ForbiddenException,
    );
    assert.equal(w.db.order.rows[0].vehicleNumber, null);
    await assert.rejects(() => w.orders.issueEbarimt(w.order.id, cashierB), ForbiddenException);
  });

  it('an order from before warehouses existed belongs to the default warehouse', async () => {
    const w = await setup();
    const legacy = await w.db.order.create({
      data: { orderNumber: 'BR-20250101-0001', status: 'PENDING_PAYMENT', totalMnt: 1, warehouseId: null },
    });
    await assert.rejects(() => w.orders.cancel(legacy.id, cashierB), ForbiddenException);
    await w.orders.cancel(legacy.id, cashierA);
    assert.equal(w.db.order.rows.find((o: any) => o.id === legacy.id)!.status, 'CANCELLED');
  });
});

describe('supplier payables', () => {
  it('completing an order whose line was already assigned to a supplier does not owe the supplier twice', async () => {
    const w = ordersWorld();
    const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
    const order = await w.db.order.create({
      data: { orderNumber: 'BR-20261012-0002', status: 'READY_FOR_LOADING', totalMnt: 3000, warehouseId: 'wh-main', deliveryMethod: 'SELF_PICKUP' },
    });
    const item = await w.db.orderItem.create({
      data: { orderId: order.id, productId: p.id, quantity: D(3), unitPrice: 1000, lineTotal: 3000, sourceType: 'EXTERNAL_SUPPLIER', supplierName: 'X' },
    });
    // What assignSupplier leaves behind when used before completion.
    await w.db.supplierPayable.create({ data: { orderId: order.id, orderItemId: item.id, supplierName: 'X', quantity: D(3), amountMnt: 3000 } });

    await w.orders.complete(order.id, { id: 'u-adm', role: Role.ADMIN, name: 'Admin' } as any);
    assert.equal(w.db.supplierPayable.rows.filter((r: any) => r.status === 'OPEN').length, 1);
  });

  it('cancelling an unpaid order voids a payable assigned before payment', async () => {
    const w = ordersWorld();
    const order = await w.db.order.create({
      data: { orderNumber: 'BR-20261012-0003', status: 'PENDING_PAYMENT', totalMnt: 1000, warehouseId: 'wh-main' },
    });
    await w.db.supplierPayable.create({ data: { orderId: order.id, orderItemId: 'i', supplierName: 'X', quantity: D(1), amountMnt: 1000 } });
    await w.orders.cancel(order.id, cashierA);
    assert.equal(w.db.supplierPayable.rows[0].status, 'VOID');
  });
});

describe('E-Barimt after a fee override', () => {
  it('an EXPIRED (replaced) invoice no longer blocks the receipt once the new one is paid', async () => {
    const db = new FakeDb();
    const order = await db.order.create({
      data: { orderNumber: 'BR-20261012-0004', status: 'READY_FOR_LOADING', totalMnt: 6000, billType: 'CITIZEN' },
    });
    await db.payment.create({ data: { orderId: order.id, amountMnt: 5000, status: 'EXPIRED' } });
    await db.payment.create({ data: { orderId: order.id, amountMnt: 6000, status: 'PAID' } });
    let sent = 0;
    const client: any = {
      buildPosapiBody: () => ({}),
      sendReceipt: async () => (sent++, { receiptId: 'R1', lottery: 'L', qrCode: 'Q', raw: {} }),
    };
    const res: any = await new EbarimtService(db as any, client).issueForOrder(order.id, { quiet: true });
    assert.notEqual(res.error, 'not_fully_paid');
    assert.equal(sent, 1);
  });

  it('is still refused for a cancelled order even if a split was paid', async () => {
    const db = new FakeDb();
    const order = await db.order.create({ data: { orderNumber: 'BR-20261012-0005', status: 'CANCELLED', totalMnt: 1000 } });
    await db.payment.create({ data: { orderId: order.id, amountMnt: 1000, status: 'PAID' } });
    const res: any = await new EbarimtService(db as any, {} as any).issueForOrder(order.id, { quiet: true });
    assert.equal(res.error, 'not_fully_paid');
  });
});

describe('payment splits are recorded all-or-nothing', () => {
  it('when the QPay invoice cannot be created, the cash split is not recorded either', async () => {
    const w = ordersWorld();
    const order = await w.db.order.create({
      data: { orderNumber: 'BR-20261012-0006', status: 'PENDING_PAYMENT', totalMnt: 100_000 },
    });
    (w.qpay as any).createInvoice = async () => {
      throw new Error('QPay down');
    };
    await assert.rejects(() =>
      w.service.settleSplits(order.id, [
        { method: 'CASH', amount: 50_000 },
        { method: 'QPAY', amount: 50_000 },
      ] as any),
    );
    assert.equal(w.db.payment.rows.length, 0, 'no PAID cash row is left behind');
  });
});

describe('returns', () => {
  async function setup(qty: number, unitPrice: number) {
    const db = new FakeDb();
    const inventory = new InventoryService(db as any);
    const returns = new ReturnsService(db as any, inventory, {} as any);
    const p = await db.product.create({ data: { sku: 'NAIL', nameMn: 'Хадаас', stockQty: D(0) } });
    const order = await db.order.create({
      data: { orderNumber: 'BR-20261012-0007', status: 'READY_FOR_LOADING', totalMnt: Math.round(qty * unitPrice), warehouseId: 'wh-main' },
    });
    const item = await db.orderItem.create({
      data: { orderId: order.id, productId: p.id, quantity: D(qty), unitPrice, lineTotal: Math.round(qty * unitPrice), sourceType: 'INTERNAL' },
    });
    const ret = (q: number, items = [{ orderItemId: item.id, quantity: q }]) =>
      (returns as any).processReturn(db, order.id, { reason: 'test', refundMethod: 'CASH', items }, { id: 'u', role: Role.MANAGER, email: 'm' });
    return { db, item, ret };
  }

  it('the same line twice in one request cannot return more than was sold', async () => {
    const { ret, item } = await setup(5, 1000);
    await assert.rejects(
      () => ret(0, [{ orderItemId: item.id, quantity: 4 }, { orderItemId: item.id, quantity: 4 }]),
      BadRequestException,
    );
  });

  it('partial returns never refund more than the line total, and the last one refunds exactly the rest', async () => {
    // 0.3 × 5₮ = 1.5 → sold for 2₮. Three returns of 0.1 would each round 0.5 → 1₮ (3₮ total) without the cap.
    const { ret } = await setup(0.3, 5);
    const refunds = [];
    for (let i = 0; i < 3; i++) {
      try {
        refunds.push((await ret(0.1)).refundAmount);
      } catch (err) {
        assert.ok(err instanceof BadRequestException, 'a zero refund is refused, never an over-refund');
        refunds.push(0);
      }
    }
    assert.ok(refunds.reduce((s, r) => s + r, 0) <= 2, `refunded ${refunds} for a 2₮ line`);
  });
});
