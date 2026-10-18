/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { CustomersService } from '../src/customers/customers.service';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { TransfersService } from '../src/inventory/transfers.service';
import { WarehousesService } from '../src/inventory/warehouses.service';
import { OrdersService } from '../src/orders/orders.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number | string) => new Prisma.Decimal(n);
const admin: any = { id: 'u-admin', role: Role.ADMIN, name: 'Admin' };
const manager: any = { id: 'u-mgr', role: Role.SUPER_MANAGER, name: 'Manager' };
const staffA: any = { id: 'u-a', role: Role.ACHIGCH_BELTGEGCH, name: 'A', warehouseId: 'wh-main' };
const staffB: any = { id: 'u-b', role: Role.BORLUULAGCH, name: 'B', warehouseId: 'wh-b' };
const unassigned: any = { id: 'u-x', role: Role.ACHIGCH_BELTGEGCH, name: 'X', warehouseId: null };

function world() {
  const db = new FakeDb();
  const inventory = new InventoryService(db as any);
  const transfers = new TransfersService(db as any, inventory);
  return { db, inventory, transfers };
}
type World = ReturnType<typeof world>;

async function setup(qty = 50) {
  const w = world();
  await w.db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B' } });
  const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
  await w.db.$transaction((tx: any) =>
    w.inventory.applyMovement(tx, { warehouseId: 'wh-main', productId: p.id, delta: qty, type: 'OPENING' }),
  );
  return { ...w, p };
}

const balance = (w: World, warehouseId: string, productId: string) =>
  Number(w.db.stockBalance.rows.find((b: any) => b.warehouseId === warehouseId && b.productId === productId)?.quantity ?? 0);
const total = (w: World, productId: string) => Number(w.db.product.rows.find((p: any) => p.id === productId)!.stockQty);

/** Ledger sum = balance for every warehouse/product, and Product.stockQty = sum of balances. */
function assertLedgerConsistent(w: World) {
  const key = (x: any) => `${x.warehouseId}|${x.productId}`;
  const fromLedger = new Map<string, number>();
  for (const m of w.db.stockMovement.rows) fromLedger.set(key(m), (fromLedger.get(key(m)) ?? 0) + Number(m.quantityDelta));
  for (const b of w.db.stockBalance.rows) assert.equal(Number(b.quantity), fromLedger.get(key(b)) ?? 0);
  for (const p of w.db.product.rows) {
    const sum = w.db.stockBalance.rows.filter((b: any) => b.productId === p.id).reduce((s: number, b: any) => s + Number(b.quantity), 0);
    assert.equal(Number(p.stockQty), sum);
  }
}

const send = (w: World, user: any, qty: number, productId: string, from = 'wh-main', to = 'wh-b') =>
  w.transfers.send({ fromWarehouseId: from, toWarehouseId: to, items: [{ productId, quantity: qty }] }, user);

// ----------------------------------------------------------------------------------------------
describe('warehouse transfers', () => {
  it('sending takes stock out of the source; it is in transit and in neither warehouse', async () => {
    const w = await setup(50);
    const t = await send(w, manager, 12, w.p.id);
    assert.equal(t.status, 'IN_TRANSIT');
    assert.match(t.transferNumber, /^TR-\d{8}-0001$/);
    assert.equal(balance(w, 'wh-main', w.p.id), 38);
    assert.equal(balance(w, 'wh-b', w.p.id), 0);
    assert.equal(total(w, w.p.id), 38, 'in-transit stock is not sellable anywhere');
    const out = w.db.stockMovement.rows.filter((m: any) => m.type === 'TRANSFER_OUT');
    assert.equal(out.length, 1);
    assert.equal(out[0].refType, 'TRANSFER');
    assert.equal(out[0].refId, t.id);
    assertLedgerConsistent(w);
  });

  it('receiving puts the stock into the destination exactly once, even when two people press receive', async () => {
    const w = await setup(50);
    const t = await send(w, manager, 12, w.p.id);
    const results = await Promise.allSettled([w.transfers.receive(t.id, staffB), w.transfers.receive(t.id, manager)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(failed.reason instanceof ConflictException);
    assert.equal(balance(w, 'wh-b', w.p.id), 12);
    assert.equal(balance(w, 'wh-main', w.p.id), 38);
    assert.equal(total(w, w.p.id), 50, 'nothing is created or lost by a transfer');
    const row = w.db.stockTransfer.rows[0];
    assert.equal(row.status, 'RECEIVED');
    assert.ok(row.receivedById && row.receivedAt);
    assertLedgerConsistent(w);
  });

  it('cancelling returns the stock to the source, and a cancelled transfer cannot be received', async () => {
    const w = await setup(50);
    const t = await send(w, manager, 12, w.p.id);
    await w.transfers.cancel(t.id, 'wrong truck', manager);
    assert.equal(balance(w, 'wh-main', w.p.id), 50);
    assert.equal(balance(w, 'wh-b', w.p.id), 0);
    await assert.rejects(() => w.transfers.receive(t.id, staffB), ConflictException);
    await assert.rejects(() => w.transfers.cancel(t.id, 'again', manager), ConflictException);
    assert.equal(balance(w, 'wh-main', w.p.id), 50, 'a second cancel adds nothing');
    assertLedgerConsistent(w);
  });

  it('refuses to send more than the source holds and changes nothing', async () => {
    const w = await setup(5);
    await assert.rejects(() => send(w, manager, 6, w.p.id), BadRequestException);
    assert.equal(balance(w, 'wh-main', w.p.id), 5);
    assert.equal(w.db.stockTransfer.rows.length, 0);
    assert.equal(w.db.stockMovement.rows.filter((m: any) => m.type === 'TRANSFER_OUT').length, 0);
  });

  it('rejects same-warehouse transfers, zero/negative quantities and repeated products', async () => {
    const w = await setup(50);
    await assert.rejects(() => send(w, manager, 1, w.p.id, 'wh-main', 'wh-main'), BadRequestException);
    await assert.rejects(() => send(w, manager, 0, w.p.id), BadRequestException);
    await assert.rejects(() => send(w, manager, -3, w.p.id), BadRequestException);
    await assert.rejects(
      () =>
        w.transfers.send(
          { fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.p.id, quantity: 1 }, { productId: w.p.id, quantity: 2 }] },
          manager,
        ),
      BadRequestException,
    );
    assert.equal(balance(w, 'wh-main', w.p.id), 50);
  });

  it('refuses an inactive destination', async () => {
    const w = await setup(50);
    await w.db.warehouse.update({ where: { id: 'wh-b' }, data: { isActive: false } });
    await assert.rejects(() => send(w, manager, 1, w.p.id), BadRequestException);
  });

  it('staff send only from, and receive only into, their own warehouse; unassigned staff cannot move stock', async () => {
    const w = await setup(50);
    await assert.rejects(() => send(w, staffB, 1, w.p.id), ForbiddenException, 'B cannot send from main');
    await assert.rejects(() => send(w, unassigned, 1, w.p.id), ForbiddenException);
    const t = await send(w, staffA, 3, w.p.id);
    await assert.rejects(() => w.transfers.receive(t.id, staffA), ForbiddenException, 'the sender cannot receive at B');
    await assert.rejects(() => w.transfers.receive(t.id, unassigned), ForbiddenException);
    await w.transfers.receive(t.id, staffB);
    assert.equal(balance(w, 'wh-b', w.p.id), 3);
  });

  it('staff see only transfers that touch their warehouse', async () => {
    const w = await setup(50);
    await w.db.warehouse.create({ data: { id: 'wh-c', code: 'C', name: 'Shop C' } });
    const t = await send(w, admin, 2, w.p.id, 'wh-main', 'wh-c');
    assert.equal((await w.transfers.list(staffB)).length, 0);
    await assert.rejects(() => w.transfers.get(t.id, staffB), NotFoundException);
    assert.equal((await w.transfers.list(staffA)).length, 1);
    assert.equal((await w.transfers.list(manager)).length, 1);
  });

  it('a warehouse with transfers still in transit cannot be deactivated', async () => {
    const w = await setup(50);
    const t = await send(w, manager, 50, w.p.id);
    const warehouses = new WarehousesService(w.db as any);
    // wh-b holds no stock and has no staff, so only the incoming in-transit transfer blocks it.
    await assert.rejects(() => warehouses.update('wh-b', { isActive: false }), ConflictException);
    await w.transfers.cancel(t.id, 'not needed', manager);
    await warehouses.update('wh-b', { isActive: false });
  });
});

// ----------------------------------------------------------------------------------------------
describe('module switches', () => {
  it('a module uses its default until an admin switches it, then the stored value wins', async () => {
    const db = new FakeDb();
    const features = new FeaturesService(db as any);
    assert.equal(await features.isEnabled('STOCK_TRANSFERS'), true);
    await features.set('STOCK_TRANSFERS', false, 'u-admin');
    assert.equal(await features.isEnabled('STOCK_TRANSFERS'), false);
    await assert.rejects(() => features.assertEnabled('STOCK_TRANSFERS'), ForbiddenException);
    assert.equal(db.featureFlag.rows[0].updatedById, 'u-admin', 'who switched it is recorded');
    await assert.rejects(() => features.set('NOT_A_MODULE', true, 'u-admin'), NotFoundException);
  });

  it('the transfer and customer controllers are behind the feature guard', async () => {
    const { FEATURE_KEY, FeatureGuard } = await import('../src/features/feature.guard');
    const { TransfersController } = await import('../src/inventory/transfers.controller');
    const { CustomersController } = await import('../src/customers/customers.controller');
    for (const [ctrl, key] of [[TransfersController, 'STOCK_TRANSFERS'], [CustomersController, 'CUSTOMERS']] as const) {
      assert.equal(Reflect.getMetadata(FEATURE_KEY, ctrl), key);
      assert.ok((Reflect.getMetadata('__guards__', ctrl) as unknown[]).includes(FeatureGuard));
    }
  });
});

// ----------------------------------------------------------------------------------------------
describe('customers', () => {
  const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'C' };

  it('a company needs a valid РД; a citizen register number must look like УБ12345678', async () => {
    const svc = new CustomersService(new FakeDb() as any);
    await assert.rejects(() => svc.create({ type: 'COMPANY', name: 'Барилга ХХК', phone: '99112233' } as any, cashier), BadRequestException);
    await assert.rejects(
      () => svc.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233', regNumber: '12345' } as any, cashier),
      BadRequestException,
    );
    const c = await svc.create({ type: 'COMPANY', name: 'Барилга ХХК', phone: '99112233', regNumber: '1234567' } as any, cashier);
    assert.equal(c.createdById, 'u-c');
    const p = await svc.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99001122', regNumber: 'уб12345678' } as any, cashier);
    assert.equal(p.regNumber, 'УБ12345678');
  });

  it('search ignores Cyrillic case and matches name, phone or register number, also after an edit', async () => {
    const svc = new CustomersService(new FakeDb() as any);
    const c = await svc.create({ type: 'COMPANY', name: 'Номин Барилга ХХК', phone: '99112233', regNumber: '5123456' } as any, cashier);
    assert.equal((await svc.search('номин')).length, 1);
    assert.equal((await svc.search('БАРИЛГА')).length, 1);
    assert.equal((await svc.search('9911')).length, 1);
    assert.equal((await svc.search('5123456')).length, 1);
    assert.equal((await svc.search('Тэмүүлэн')).length, 0);
    await svc.update(c.id, { name: 'Тэмүүлэн Трейд ХХК' }, cashier);
    assert.equal((await svc.search('тэмүүлэн')).length, 1);
    assert.equal((await svc.search('номин')).length, 0);
  });

  it('only a manager or admin can deactivate a customer', async () => {
    const svc = new CustomersService(new FakeDb() as any);
    const c = await svc.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99112233' } as any, cashier);
    await assert.rejects(() => svc.update(c.id, { isActive: false }, cashier), ForbiddenException);
    await svc.update(c.id, { name: 'Бат-Эрдэнэ' }, cashier);
    const off = await svc.update(c.id, { isActive: false }, manager);
    assert.equal(off!.isActive, false);
    assert.equal((await svc.search('Бат')).length, 0, 'inactive customers are hidden from POS search');
  });

  it('an order can link only an active customer, and only while the customer module is on', async () => {
    const db = new FakeDb();
    const features = new FeaturesService(db as any);
    const orders = new OrdersService(db as any, {} as any, {} as any, {} as any, {} as any, features);
    const resolve = (id?: string) => (orders as any).resolveCustomerId(id);
    const c = await db.customer.create({ data: { type: 'INDIVIDUAL', name: 'Бат', phone: '99112233' } });

    assert.equal(await resolve(undefined), null, 'walk-in sales keep working without a customer');
    assert.equal(await resolve(c.id), c.id);
    await assert.rejects(() => resolve('missing'), BadRequestException);
    await db.customer.update({ where: { id: c.id }, data: { isActive: false } });
    await assert.rejects(() => resolve(c.id), BadRequestException);
    await db.customer.update({ where: { id: c.id }, data: { isActive: true } });
    await features.set('CUSTOMERS', false, 'u-admin');
    await assert.rejects(() => resolve(c.id), ForbiddenException);
  });
});
