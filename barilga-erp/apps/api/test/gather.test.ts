/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { TransfersService } from '../src/inventory/transfers.service';
import { GatherService } from '../src/orders/gather.service';
import { planGather } from '../src/orders/gather-plan';
import { OrdersService } from '../src/orders/orders.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number) => new Prisma.Decimal(n);
const manager: any = { id: 'u-mgr', role: Role.MANAGER, name: 'Manager' };
const loader: any = { id: 'u-load', role: Role.ACHIGCH_BELTGEGCH, name: 'Loader', warehouseId: 'wh-main' };

describe('gather plan (pure)', () => {
  const plan = (balances: Array<[string, string, number]>, needs: Array<[string, number]>, inTransit: Array<[string, number]> = []) =>
    planGather({
      dispatchWarehouseId: 'main',
      needs: needs.map(([productId, q]) => ({ productId, quantity: D(q) })),
      balances: balances.map(([warehouseId, productId, q]) => ({ warehouseId, productId, quantity: D(q) })),
      inTransitToDispatch: inTransit.map(([productId, q]) => ({ productId, quantity: D(q) })),
      sourceWarehouseIds: ['main', 'b', 'c', 'd'],
    });
  const qty = (p: ReturnType<typeof plan>, from: string, productId: string) =>
    Number(p.transfers.find((t) => t.fromWarehouseId === from)?.items.find((i) => i.productId === productId)?.quantity ?? 0);

  it('takes only the shortfall, from the warehouses holding the most first', () => {
    const p = plan([['main', 'cem', 10], ['b', 'cem', 30], ['c', 'cem', 50]], [['cem', 70]]);
    assert.equal(qty(p, 'c', 'cem'), 50);
    assert.equal(qty(p, 'b', 'cem'), 10);
    assert.equal(qty(p, 'main', 'cem'), 0, 'never sends from the dispatch warehouse to itself');
    assert.equal(Number(p.lines[0].unavailable), 0);
  });

  it('nothing to gather when the dispatch warehouse already has enough', () => {
    const p = plan([['main', 'cem', 100], ['b', 'cem', 30]], [['cem', 70]]);
    assert.equal(p.transfers.length, 0);
  });

  it('counts stock already in transit for this order, so re-running never gathers twice', () => {
    const p = plan([['main', 'cem', 10], ['b', 'cem', 30]], [['cem', 40]], [['cem', 30]]);
    assert.equal(p.transfers.length, 0);
  });

  it('reports what no warehouse holds as unavailable instead of sending stock that is not there', () => {
    const p = plan([['b', 'cem', 5], ['c', 'cem', -3]], [['cem', 20]]);
    assert.equal(qty(p, 'b', 'cem'), 5);
    assert.equal(qty(p, 'c', 'cem'), 0, 'negative balances are not a source');
    assert.equal(Number(p.lines[0].unavailable), 15);
  });

  it('a negative dispatch balance does not inflate what has to be gathered', () => {
    const p = plan([['main', 'cem', -4], ['b', 'cem', 50]], [['cem', 10]]);
    assert.equal(qty(p, 'b', 'cem'), 10);
  });

  it('groups several products from one warehouse into one transfer', () => {
    const p = plan([['b', 'cem', 50], ['b', 'sand', 50]], [['cem', 5], ['sand', 7]]);
    assert.equal(p.transfers.length, 1);
    assert.equal(p.transfers[0].items.length, 2);
  });
});

// ----------------------------------------------------------------------------------------------
function world() {
  const db = new FakeDb();
  const inventory = new InventoryService(db as any);
  const transfers = new TransfersService(db as any, inventory);
  const features = new FeaturesService(db as any);
  const gather = new GatherService(db as any, inventory, transfers, features);
  const orders = new OrdersService(db as any, {} as any, {} as any, inventory, {} as any, features);
  return { db, inventory, transfers, features, gather, orders };
}

async function seed(w: ReturnType<typeof world>) {
  await w.db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B' } });
  await w.db.warehouse.create({ data: { id: 'wh-c', code: 'C', name: 'Shop C' } });
  const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
  for (const [wh, q] of [['wh-main', 2], ['wh-b', 5], ['wh-c', 8]] as const) {
    await w.db.$transaction((tx: any) => w.inventory.applyMovement(tx, { warehouseId: wh, productId: p.id, delta: q, type: 'OPENING' }));
  }
  const order = await w.db.order.create({
    data: { orderNumber: 'BR-20261012-0001', status: 'READY_FOR_LOADING', totalMnt: 0, warehouseId: 'wh-main', deliveryMethod: 'SELF_PICKUP' },
  });
  await w.db.orderItem.create({
    data: { orderId: order.id, productId: p.id, quantity: D(12), unitPrice: 1000, lineTotal: 12000, sourceType: 'INTERNAL' },
  });
  return { p, order };
}

const bal = (w: ReturnType<typeof world>, wh: string, productId: string) =>
  Number(w.db.stockBalance.rows.find((b: any) => b.warehouseId === wh && b.productId === productId)?.quantity ?? 0);

describe('gathering an order from all warehouses', () => {
  it('collects the shortfall into the dispatch warehouse, then the order completes from there', async () => {
    const w = world();
    const { p, order } = await seed(w);

    const plan = await w.gather.plan(order.id);
    assert.equal(plan.lines[0].toGather, 10, '12 needed, 2 at dispatch');
    assert.equal(plan.complete, true);

    const res = await w.gather.gather(order.id, manager);
    assert.equal(res.transfers.length, 2, 'from C (8) and B (2)');
    assert.ok(res.transfers.every((t: any) => t.orderId === order.id && t.toWarehouseId === 'wh-main'));
    assert.equal(bal(w, 'wh-c', p.id), 0);
    assert.equal(bal(w, 'wh-b', p.id), 3);

    await assert.rejects(() => w.gather.gather(order.id, manager), BadRequestException, 'nothing left to gather');
    await assert.rejects(() => w.orders.complete(order.id, loader), ConflictException, 'cannot load before stock arrives');

    for (const t of res.transfers) await w.transfers.receive(t.id, loader);
    assert.equal(bal(w, 'wh-main', p.id), 12);

    await w.orders.complete(order.id, loader);
    assert.equal(bal(w, 'wh-main', p.id), 0);
    assert.equal(Number(w.db.product.rows[0].stockQty), 3, '15 in total − 12 sold; nothing created or lost');
  });

  it('only paid orders waiting for loading can be gathered, and only while transfers are switched on', async () => {
    const w = world();
    const { order } = await seed(w);
    await w.db.order.update({ where: { id: order.id }, data: { status: 'PENDING_PAYMENT' } });
    await assert.rejects(() => w.gather.gather(order.id, manager), BadRequestException);
    await w.db.order.update({ where: { id: order.id }, data: { status: 'READY_FOR_LOADING' } });
    await w.features.set('STOCK_TRANSFERS', false, 'u-admin');
    await assert.rejects(() => w.gather.gather(order.id, manager), ForbiddenException);
    assert.equal(w.db.stockTransfer.rows.length, 0);
  });

  it('a cancelled gather transfer stops blocking completion and returns the stock to its shop', async () => {
    const w = world();
    const { p, order } = await seed(w);
    const res = await w.gather.gather(order.id, manager);
    for (const t of res.transfers) await w.transfers.cancel(t.id, 'customer will pick up later', manager);
    assert.equal(bal(w, 'wh-c', p.id), 8);
    assert.equal(bal(w, 'wh-b', p.id), 5);
    const again = await w.gather.plan(order.id);
    assert.equal(again.lines[0].inTransit, 0);
    assert.equal(again.lines[0].toGather, 10, 'the plan is available again');
  });
});
