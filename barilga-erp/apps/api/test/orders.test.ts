/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { planFulfillment } from '../src/orders/fulfillment-plan';
import { createWithUniqueOrderNumber, ulaanbaatarYmd } from '../src/orders/order-number';
import { OrdersService } from '../src/orders/orders.service';
import { makePaymentWorld, seedQpayOrder } from './helpers/payment-fixtures';
import { tick } from './helpers/fake-db';

const D = (n: number | string) => new Prisma.Decimal(n);
const cashier: any = { id: 'u-cashier', email: 'c@x', username: 'cashier', role: Role.BORLUULAGCH, name: 'Cashier', fullName: 'Cashier' };
const loader: any = { id: 'u-load', email: 'w@x', username: 'wh', role: Role.ACHIGCH_BELTGEGCH, name: 'Loader', fullName: 'Loader' };

function makeOrdersWorld(env?: Record<string, string | undefined>) {
  const w = makePaymentWorld(env);
  const orders = new OrdersService(w.db as any, {} as any, w.service, new InventoryService(w.db as any), {} as any);
  return { ...w, orders };
}

// ----------------------------------------------------------------------------------------------
describe('order numbers', () => {
  function numberStore() {
    const taken = new Set<string>();
    const prisma = {
      order: {
        count: async ({ where }: any) => {
          await tick();
          return [...taken].filter((n) => n.startsWith(where.orderNumber.startsWith)).length;
        },
      },
    };
    const create = async (n: string) => {
      await tick();
      if (taken.has(n)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['orderNumber'] } });
      taken.add(n);
      return n;
    };
    return { taken, prisma, create };
  }

  it('concurrent creation never produces a duplicate number', async () => {
    const s = numberStore();
    const now = new Date('2026-10-11T04:00:00Z');
    const results = await Promise.all(Array.from({ length: 30 }, () => createWithUniqueOrderNumber(s.prisma, s.create, now)));
    assert.equal(new Set(results).size, 30);
    for (const n of results) assert.match(n, /^BR-20261011-\d{4}$/);
  });

  it('continues after numbers that already exist (same BR-YYYYMMDD-NNNN format)', async () => {
    const s = numberStore();
    for (let i = 1; i <= 16; i++) s.taken.add(`BR-20261011-${String(i).padStart(4, '0')}`);
    const n = await createWithUniqueOrderNumber(s.prisma, s.create, new Date('2026-10-11T04:00:00Z'));
    assert.equal(n, 'BR-20261011-0017');
  });

  it('uses the Ulaanbaatar calendar day, not the server timezone', () => {
    assert.equal(ulaanbaatarYmd(new Date('2026-10-11T15:59:00Z')), '20261011'); // 23:59 UB
    assert.equal(ulaanbaatarYmd(new Date('2026-10-11T16:01:00Z')), '20261012'); // 00:01 UB next day
  });

  it('does not swallow unrelated errors, and gives up loudly if it can never get a number', async () => {
    const s = numberStore();
    await assert.rejects(
      () => createWithUniqueOrderNumber(s.prisma, async () => { throw new Error('db down'); }),
      /db down/,
    );
    await assert.rejects(
      () => createWithUniqueOrderNumber(s.prisma, async () => { throw Object.assign(new Error('u'), { code: 'P2002', meta: { target: ['orderNumber'] } }); }),
      ConflictException,
    );
  });

  it('only treats an orderNumber unique violation as a number clash', async () => {
    const s = numberStore();
    await assert.rejects(
      () => createWithUniqueOrderNumber(s.prisma, async () => { throw Object.assign(new Error('u'), { code: 'P2002', meta: { target: ['trackingToken'] } }); }),
      /u/,
    );
  });
});

// ----------------------------------------------------------------------------------------------
describe('fee override keeps order total and QPay invoice equal', () => {
  async function seedPendingOrder(w: ReturnType<typeof makeOrdersWorld>) {
    const seeded = await seedQpayOrder(w, { total: 26_000 });
    await w.db.order.update({
      where: { id: seeded.order.id },
      data: { subtotalMnt: 1_000, deliveryFeeMnt: 25_000, unloadingFeeMnt: 0, timeAdjustmentMnt: 0, deliveryMethod: 'OUR_DELIVERY' },
    });
    return seeded;
  }
  const dto = (over: Partial<any> = {}) => ({ deliveryFeeMnt: 15_000, unloadingFeeMnt: 0, timeAdjustmentMnt: 0, reason: 'discount', ...over });
  const live = (w: any, orderId: string) =>
    w.db.payment.rows.filter((p: any) => p.orderId === orderId && p.status !== 'EXPIRED' && p.status !== 'FAILED');

  it('re-issues the invoice for the new total and expires the old one', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    await w.orders.overrideFees(order.id, dto(), cashier);

    const o = (await w.db.order.findUnique({ where: { id: order.id } }))!;
    assert.equal(o.totalMnt, 16_000);
    const liveRows = live(w, order.id);
    assert.equal(liveRows.length, 1);
    assert.equal(liveRows[0].amountMnt, o.totalMnt, 'invoice amount must equal order total');
    assert.equal(w.provider.created.at(-1)!.amount, 16_000);
    assert.equal(w.db.payment.rows.filter((p: any) => p.status === 'EXPIRED').length, 1);
    assert.equal(w.db.feeOverrideAudit.rows.length, 1);
  });

  it('the new invoice settles the order; the old one cannot (late payment is only recorded)', async () => {
    const w = makeOrdersWorld();
    const { order, invoiceId } = await seedPendingOrder(w);
    await w.orders.overrideFees(order.id, dto(), cashier);
    const newInvoice = live(w, order.id)[0].qpayInvoiceId as string;

    w.provider.paid.set(invoiceId, 26_000); // customer paid the OLD amount on the OLD invoice
    await w.service.handleWebhook({ object_id: invoiceId });
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT');

    w.provider.paid.set(newInvoice, 16_000);
    await w.service.handleWebhook({ object_id: newInvoice });
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.status, 'READY_FOR_LOADING');
  });

  it('refuses once any money has been received (cash split)', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    await w.db.payment.create({ data: { orderId: order.id, method: 'CASH', provider: 'CASH', amountMnt: 1_000, status: 'PAID' } });
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), BadRequestException);
    assert.equal((await w.db.order.findUnique({ where: { id: order.id } }))!.totalMnt, 26_000);
  });

  it('refuses an order that is already paid / ready', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    await w.db.order.update({ where: { id: order.id }, data: { status: 'READY_FOR_LOADING' } });
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), BadRequestException);
  });

  it('refuses when the old invoice was paid at the provider a moment ago', async () => {
    const w = makeOrdersWorld();
    const { order, invoiceId } = await seedPendingOrder(w);
    w.provider.paid.set(invoiceId, 26_000);
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), ConflictException);
    const o = (await w.db.order.findUnique({ where: { id: order.id } }))!;
    assert.equal(o.totalMnt, 26_000);
    assert.equal(w.provider.created.length, 0, 'no new invoice is created for a paid order');
  });

  it('is atomic: a failure issuing the new invoice changes nothing', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    (w.qpay as any).createInvoice = async () => { throw new Error('qpay down'); };
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), /qpay down/);
    const o = (await w.db.order.findUnique({ where: { id: order.id } }))!;
    assert.equal(o.totalMnt, 26_000);
    assert.equal(live(w, order.id)[0].status, 'UNPAID');
    assert.equal(w.db.feeOverrideAudit.rows.length, 0);
  });

  it('rolls back the whole change if the order moved while overriding', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    const realCreate = (w.qpay as any).createInvoice;
    (w.qpay as any).createInvoice = async (p: any) => {
      const res = await realCreate(p);
      await w.db.order.update({ where: { id: order.id }, data: { totalMnt: 99_999 } }); // concurrent change
      return res;
    };
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), ConflictException);
    assert.equal(live(w, order.id)[0].status, 'UNPAID', 'old invoice stays live after rollback');
    assert.equal(w.db.feeOverrideAudit.rows.length, 0);
  });

  it('rejects layouts it cannot re-price safely, unchanged fees, and non-cashiers', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedPendingOrder(w);
    await assert.rejects(() => w.orders.overrideFees(order.id, dto({ deliveryFeeMnt: 25_000 }), cashier), /unchanged/);
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), loader));
    await w.db.payment.create({ data: { orderId: order.id, amountMnt: 5, qpayInvoiceId: 'INV-2', status: 'UNPAID' } });
    await assert.rejects(() => w.orders.overrideFees(order.id, dto(), cashier), BadRequestException);
  });
});

// ----------------------------------------------------------------------------------------------
describe('return + complete keep stock and supplier payables correct', () => {
  async function seedReadyOrder(w: ReturnType<typeof makeOrdersWorld>, lines: Array<{ qty: number; source?: string; price?: number }>) {
    const order = await w.db.order.create({ data: { orderNumber: 'BR-20261011-0001', status: 'READY_FOR_LOADING', totalMnt: 0 } });
    const items: any[] = [];
    for (const [i, l] of lines.entries()) {
      const product = await w.db.product.create({ data: { sku: `P${i}`, nameMn: `P${i}`, stockQty: D(100) } });
      const price = l.price ?? 1_000;
      const item = await w.db.orderItem.create({
        data: { orderId: order.id, productId: product.id, quantity: D(l.qty), unitPrice: price, lineTotal: price * l.qty, sourceType: l.source ?? 'INTERNAL', supplierName: l.source === 'EXTERNAL_SUPPLIER' ? 'Yard' : null },
      });
      items.push({ product, item });
    }
    return { order, items };
  }
  const stock = (w: any, productId: string) => Number(w.db.product.rows.find((p: any) => p.id === productId).stockQty);

  it('deducts the full quantity when nothing was returned', async () => {
    const w = makeOrdersWorld();
    const { order, items } = await seedReadyOrder(w, [{ qty: 10 }]);
    await w.orders.complete(order.id, loader);
    assert.equal(stock(w, items[0].product.id), 90);
  });

  it('does not deduct units that were returned before loading', async () => {
    const w = makeOrdersWorld();
    const { order, items } = await seedReadyOrder(w, [{ qty: 10 }]);
    await w.db.returnItem.create({ data: { orderItemId: items[0].item.id, quantity: D(3), lineRefund: 3_000 } });
    await w.orders.complete(order.id, loader);
    assert.equal(stock(w, items[0].product.id), 93, 'only the 7 units that actually left are deducted');
  });

  it('deducts nothing for a fully returned line', async () => {
    const w = makeOrdersWorld();
    const { order, items } = await seedReadyOrder(w, [{ qty: 4 }, { qty: 2 }]);
    await w.db.returnItem.create({ data: { orderItemId: items[0].item.id, quantity: D(4), lineRefund: 4_000 } });
    await w.orders.complete(order.id, loader);
    assert.equal(stock(w, items[0].product.id), 100);
    assert.equal(stock(w, items[1].product.id), 98);
  });

  it('owes the supplier only the net quantity and amount of an external line', async () => {
    const w = makeOrdersWorld();
    const { order, items } = await seedReadyOrder(w, [{ qty: 10, source: 'EXTERNAL_SUPPLIER', price: 2_000 }]);
    await w.db.returnItem.create({ data: { orderItemId: items[0].item.id, quantity: D(4), lineRefund: 8_000 } });
    await w.orders.complete(order.id, loader);
    const [payable] = w.db.supplierPayable.rows;
    assert.equal(Number(payable.quantity), 6);
    assert.equal(payable.amountMnt, 12_000);
    assert.equal(stock(w, items[0].product.id), 100, 'external lines never touch own stock');
  });

  it('completing twice, or concurrently, deducts stock exactly once', async () => {
    const w = makeOrdersWorld();
    const { order, items } = await seedReadyOrder(w, [{ qty: 10 }]);
    const results = await Promise.allSettled([
      w.orders.complete(order.id, loader),
      w.orders.complete(order.id, loader),
      w.orders.complete(order.id, loader),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(stock(w, items[0].product.id), 90);
    await assert.rejects(() => w.orders.complete(order.id, loader), BadRequestException);
    assert.equal(stock(w, items[0].product.id), 90);
  });

  it('planFulfillment is pure and never goes negative', () => {
    const plan = planFulfillment(
      [{ id: 'i1', productId: 'p1', quantity: D(5), lineTotal: 5_000, sourceType: 'INTERNAL', supplierName: null }],
      [{ orderItemId: 'i1', quantity: D(9), lineRefund: 9_000 }],
    );
    assert.deepEqual(plan, { deductions: [], payables: [] });
  });
});

// ----------------------------------------------------------------------------------------------
describe('staff cancel', () => {
  it('cashier can cancel an unpaid order; loader cannot', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedQpayOrder(w);
    await assert.rejects(() => w.orders.cancel(order.id, loader), /Only cashiers/);
    await w.orders.cancel(order.id, cashier, 'customer left');
    const o = (await w.db.order.findUnique({ where: { id: order.id } }))!;
    assert.equal(o.status, 'CANCELLED');
    assert.match(String(o.notes), /customer left/);
  });

  it('cannot cancel an order that has money in it', async () => {
    const w = makeOrdersWorld();
    const { order } = await seedQpayOrder(w);
    await w.db.payment.create({ data: { orderId: order.id, method: 'CASH', provider: 'CASH', amountMnt: 10, status: 'PAID' } });
    await assert.rejects(() => w.orders.cancel(order.id, cashier), BadRequestException);
  });
});
