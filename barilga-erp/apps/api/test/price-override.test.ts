/* eslint-disable @typescript-eslint/no-explicit-any */
// A price typed at the till: only with the PRICE_OVERRIDE right, never below cost, written to the edit history,
// and kept as the customer's own price when a registered customer is on the sale.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PERMISSION_KEY_META } from '../src/auth/permissions';
import { CustomersController } from '../src/customers/customers.controller';
import { CustomersService } from '../src/customers/customers.service';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { InvoicesService } from '../src/orders/invoices.service';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier', email: 'c' };
const granted: any = { ...cashier, permissions: { grant: ['PRICE_OVERRIDE'] } };
const manager: any = { id: 'u-m', role: Role.MANAGER, name: 'Manager', email: 'm' };

const logistics: any = {
  quote: async ({ specs }: any) => ({
    breakdown: { subtotalMnt: specs.subtotalMnt, deliveryFeeMnt: 0, unloadingFeeMnt: 0, timeAdjustmentMnt: 0, totalMnt: specs.subtotalMnt, assignedVehicle: null },
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
  const customers = new CustomersService(w.db as any);
  await w.db.product.create({
    data: { id: 'p-cement', sku: 'CEM-1', nameMn: 'Цемент', unit: 'шуудай', priceMnt: 25_000, lastCostMnt: 20_000, weightKg: D(50), volumeM3: D(0.03), lengthM: D(0.5), sourceType: 'INTERNAL', active: true },
  });
  await w.db.product.create({
    data: { id: 'p-trowel', sku: 'TRW-1', nameMn: 'Шпатель', unit: 'ш', priceMnt: 8_000, lastCostMnt: null, weightKg: D(0.3), volumeM3: D(0.001), lengthM: D(0.3), sourceType: 'INTERNAL', active: true },
  });
  const buyer = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Бат ХХК', phone: '99001122', regNumber: '6543210', isActive: true } });
  return { ...w, orders, controller, customers, buyer };
}

const sale = (items: any[], extra: Record<string, unknown> = {}) =>
  ({ deliveryMethod: 'SELF_PICKUP', zoneId: 'zone-a', unloadingRequested: false, items, customerName: '', customerPhone: '', paymentMethod: 'TRANSFER', ...extra }) as any;

describe('price typed at the till', () => {
  it('needs the right; the same price as usual needs none', async () => {
    const w = await world();
    await assert.rejects(() => w.orders.quote(sale([{ productId: 'p-cement', quantity: 2, unitPriceMnt: 23_000 }]), cashier), ForbiddenException);
    await assert.rejects(() => w.controller.create(sale([{ productId: 'p-cement', quantity: 2, unitPriceMnt: 23_000 }]), cashier), ForbiddenException);
    const same: any = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 2, unitPriceMnt: 25_000 }]), cashier);
    assert.equal(same.lines[0].unitPrice, 25_000);
    assert.equal(same.lines[0].priceSource, 'RETAIL');
    const byManager: any = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 2, unitPriceMnt: 23_000 }]), manager);
    assert.equal(byManager.lines[0].unitPrice, 23_000, 'a manager has the right by role');
  });

  it('is never below cost; goods with no cost recorded have no floor', async () => {
    const w = await world();
    await assert.rejects(
      () => w.orders.quote(sale([{ productId: 'p-cement', quantity: 1, unitPriceMnt: 19_999 }]), granted),
      (e: any) => e instanceof BadRequestException && /өртгөөс доош/.test(e.message),
    );
    const ok: any = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 1, unitPriceMnt: 20_000 }]), granted);
    assert.equal(ok.lines[0].unitPrice, 20_000);
    const free: any = await w.orders.quote(sale([{ productId: 'p-trowel', quantity: 1, unitPriceMnt: 1 }]), granted);
    assert.equal(free.lines[0].unitPrice, 1);
  });

  it('without a customer: the sale uses it and the history records it; nothing is kept for next time', async () => {
    const w = await world();
    const res: any = await w.controller.create(sale([{ productId: 'p-cement', quantity: 4, unitPriceMnt: 23_000 }]), granted);
    assert.equal(res.totalMnt, 92_000);
    const item = w.db.orderItem.rows[0];
    assert.equal(item.unitPrice, 23_000);
    assert.equal(item.listPriceMnt, 25_000);
    assert.equal(w.db.customerPrice.rows.length, 0);
    assert.ok(w.db.editAudit.rows.some((a: any) => a.entityType === 'SALE_PRICE' && /25000₮ → 23000₮/.test(a.summary)));
  });

  it("with a customer: it becomes their own price, beats their list, and can be removed", async () => {
    const w = await world();
    const list = await w.db.priceList.create({ data: { name: 'Бөөний үнэ', isActive: true } });
    await w.db.priceListItem.create({ data: { priceListId: list.id, productId: 'p-cement', priceMnt: 24_000 } });
    await w.db.customer.update({ where: { id: w.buyer.id }, data: { priceListId: list.id } });

    let q: any = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 1 }], { customerId: w.buyer.id }), cashier);
    assert.equal(q.lines[0].unitPrice, 24_000);
    assert.equal(q.lines[0].priceSource, 'LIST');

    await w.controller.create(sale([{ productId: 'p-cement', quantity: 2, unitPriceMnt: 22_500 }], { customerId: w.buyer.id }), granted);
    assert.equal(w.db.orderItem.rows[0].listPriceMnt, 24_000, 'the line remembers the list price it replaced');
    assert.equal(w.db.customerPrice.rows.length, 1);
    assert.equal(w.db.customerPrice.rows[0].priceMnt, 22_500);

    q = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 1 }], { customerId: w.buyer.id }), cashier);
    assert.equal(q.lines[0].unitPrice, 22_500, 'next time it comes by itself, even for a cashier without the right');
    assert.equal(q.lines[0].priceSource, 'CUSTOMER');
    assert.equal(q.lines[0].basePrice, 22_500);

    const own: any[] = await w.customers.ownPrices(w.buyer.id);
    assert.deepEqual(own.map((p) => [p.nameMn, p.priceMnt, p.retailMnt]), [['Цемент', 22_500, 25_000]]);

    await w.customers.removeOwnPrice(w.buyer.id, 'p-cement', manager);
    q = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 1 }], { customerId: w.buyer.id }), cashier);
    assert.equal(q.lines[0].unitPrice, 24_000, 'back to their list');
    await assert.rejects(() => w.customers.removeOwnPrice(w.buyer.id, 'p-cement', manager));
  });

  it('removing an own price needs the right', () => {
    const proto = CustomersController.prototype as any;
    assert.equal(Reflect.getMetadata(PERMISSION_KEY_META, proto.removeOwnPrice)?.key, 'PRICE_OVERRIDE');
    assert.equal(Reflect.getMetadata(PERMISSION_KEY_META, proto.ownPrices), undefined);
  });
});

describe('price typed at the till — limits found in review', () => {
  it('0₮ is refused; an own price a later cost has passed is not used and is flagged', async () => {
    const w = await world();
    await assert.rejects(() => w.orders.quote(sale([{ productId: 'p-trowel', quantity: 1, unitPriceMnt: 0 }]), granted), BadRequestException);
    await w.controller.create(sale([{ productId: 'p-cement', quantity: 1, unitPriceMnt: 21_000 }], { customerId: w.buyer.id }), granted);
    // A later receipt raises the cost above the agreed price.
    await w.db.product.update({ where: { id: 'p-cement' }, data: { lastCostMnt: 22_000 } });
    const q: any = await w.orders.quote(sale([{ productId: 'p-cement', quantity: 1 }], { customerId: w.buyer.id }), cashier);
    assert.equal(q.lines[0].unitPrice, 25_000, 'back to retail, never below cost');
    assert.equal(q.lines[0].priceSource, 'RETAIL');
    const own: any[] = await w.customers.ownPrices(w.buyer.id);
    assert.equal(own[0].belowCost, true);
    assert.ok(!('lastCostMnt' in own[0]), 'the cost itself is not shown');
  });

  it("re-attaching a list-priced sale to another customer needs the right; typed prices follow the buyer attached later", async () => {
    const w = await world();
    const list = await w.db.priceList.create({ data: { name: 'Бөөний үнэ', isActive: true } });
    await w.db.priceListItem.create({ data: { priceListId: list.id, productId: 'p-cement', priceMnt: 24_000 } });
    await w.db.customer.update({ where: { id: w.buyer.id }, data: { priceListId: list.id } });
    const other = await w.db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Дорж', phone: '88112233', isActive: true } });
    const res: any = await w.controller.create(sale([{ productId: 'p-cement', quantity: 1 }], { customerId: w.buyer.id }), cashier);
    await assert.rejects(() => w.orders.attachCustomer(res.id, other.id, cashier), ForbiddenException);
    await w.orders.attachCustomer(res.id, other.id, manager);

    const walkIn: any = await w.controller.create(sale([{ productId: 'p-trowel', quantity: 2, unitPriceMnt: 7_000 }]), granted);
    assert.equal(w.db.customerPrice.rows.length, 0);
    await w.orders.attachCustomer(walkIn.id, other.id, cashier);
    assert.deepEqual(
      w.db.customerPrice.rows.map((r: any) => [r.customerId, r.productId, r.priceMnt]),
      [[other.id, 'p-trowel', 7_000]],
      'the price typed for the sale becomes the buyer’s own price',
    );
  });

  it('the same phone with another company’s РД is another buyer: the invoice gets a new link', async () => {
    const w = await world();
    const res: any = await w.controller.create(
      sale([{ productId: 'p-cement', quantity: 1 }], { paymentMethod: 'INVOICE', customerName: 'А ХХК', customerPhone: '99112233', billType: 'COMPANY', customerRegNumber: '1111111' }),
      cashier,
    );
    const before = w.db.invoice.rows[0].token;
    const b = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Б ХХК', phone: '99112233', regNumber: '2222222', isActive: true } });
    await w.orders.attachCustomer(res.id, b.id, cashier);
    assert.notEqual(w.db.invoice.rows[0].token, before);
  });

});
