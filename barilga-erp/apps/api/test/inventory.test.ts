/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { assertWarehouseAccess, lockedWarehouseId } from '../src/inventory/warehouse-scope';
import { OrdersService } from '../src/orders/orders.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number | string) => new Prisma.Decimal(n);
const loader: any = { id: 'u-load', email: 'w@x', username: 'wh', role: Role.ACHIGCH_BELTGEGCH, name: 'Loader', fullName: 'Loader' };
const cashier: any = { id: 'u-cash', email: 'c@x', username: 'c', role: Role.BORLUULAGCH, name: 'Cashier', fullName: 'Cashier' };
const manager: any = { id: 'u-mgr', email: 'm@x', username: 'm', role: Role.MANAGER, name: 'Manager', fullName: 'Manager' };

function world() {
  const w = makePaymentWorld();
  const inventory = new InventoryService(w.db as any);
  const orders = new OrdersService(w.db as any, {} as any, w.service, inventory, {} as any);
  return { ...w, inventory, orders };
}
type World = ReturnType<typeof world>;

async function addWarehouse(w: World, id: string, extra: Record<string, unknown> = {}) {
  return w.db.warehouse.create({ data: { id, code: id.toUpperCase(), name: id, ...extra } });
}

/** A product that already holds `qty` in `warehouseId` (balance + OPENING ledger row), like after the migration. */
async function addProduct(w: World, sku: string, qty: number, warehouseId = 'wh-main') {
  const product = await w.db.product.create({ data: { sku, nameMn: sku, stockQty: D(qty) } });
  await w.db.stockBalance.create({ data: { warehouseId, productId: product.id, quantity: D(qty) } });
  await w.db.stockMovement.create({
    data: { warehouseId, productId: product.id, type: 'OPENING', quantityDelta: D(qty), balanceAfter: D(qty) },
  });
  return product;
}

async function readyOrder(w: World, productId: string, qty: number, warehouseId: string | null, num = 'BR-20261011-0001') {
  const order = await w.db.order.create({
    data: { orderNumber: num, status: 'READY_FOR_LOADING', totalMnt: 0, warehouseId },
  });
  await w.db.orderItem.create({
    data: { orderId: order.id, productId, quantity: D(qty), unitPrice: 1000, lineTotal: 1000 * qty, sourceType: 'INTERNAL' },
  });
  return order;
}

const balance = (w: World, warehouseId: string, productId: string) =>
  Number(w.db.stockBalance.rows.find((b: any) => b.warehouseId === warehouseId && b.productId === productId)?.quantity ?? 0);
const total = (w: World, productId: string) => Number(w.db.product.rows.find((p: any) => p.id === productId)!.stockQty);

/** The two invariants the ledger exists to guarantee. */
function assertLedgerConsistent(w: World) {
  const key = (x: any) => `${x.warehouseId}|${x.productId}`;
  const fromLedger = new Map<string, number>();
  for (const m of w.db.stockMovement.rows) fromLedger.set(key(m), (fromLedger.get(key(m)) ?? 0) + Number(m.quantityDelta));
  for (const b of w.db.stockBalance.rows) {
    assert.equal(Number(b.quantity), fromLedger.get(key(b)) ?? 0, `ledger sum must equal balance for ${key(b)}`);
  }
  for (const p of w.db.product.rows) {
    const sum = w.db.stockBalance.rows.filter((b: any) => b.productId === p.id).reduce((s: number, b: any) => s + Number(b.quantity), 0);
    assert.equal(Number(p.stockQty), sum, `Product.stockQty must equal the sum of balances for ${p.sku}`);
  }
}

// ----------------------------------------------------------------------------------------------
describe('stock is kept per warehouse', () => {
  it('completing an order takes stock only from that order\'s warehouse and writes a ledger row', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 50, 'wh-main');
    await w.db.stockBalance.create({ data: { warehouseId: 'wh-b', productId: p.id, quantity: D(20) } });
    await w.db.product.update({ where: { id: p.id }, data: { stockQty: { increment: D(20) } } });
    const order = await readyOrder(w, p.id, 4, 'wh-b');

    await w.orders.complete(order.id, loader);

    assert.equal(balance(w, 'wh-b', p.id), 16);
    assert.equal(balance(w, 'wh-main', p.id), 50, 'the other warehouse is untouched');
    assert.equal(total(w, p.id), 66);
    const sale = w.db.stockMovement.rows.find((m: any) => m.type === 'SALE')!;
    assert.equal(sale.warehouseId, 'wh-b');
    assert.equal(Number(sale.quantityDelta), -4);
    assert.equal(Number(sale.balanceAfter), 16);
    assert.equal(sale.refId, order.id);
    assert.equal(sale.actorId, loader.id);
  });

  it('an order from before warehouses (no warehouse) uses the default warehouse', async () => {
    const w = world();
    const p = await addProduct(w, 'CEM', 30);
    const order = await readyOrder(w, p.id, 5, null);
    await w.orders.complete(order.id, loader);
    assert.equal(balance(w, 'wh-main', p.id), 25);
    assertLedgerConsistent(w);
  });

  it('returned goods go back to the warehouse they were taken from', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 10, 'wh-b');
    await w.db.$transaction(async (tx: any) => {
      await w.inventory.deductForOrder(tx, [{ productId: p.id, quantity: 4 }], { warehouseId: 'wh-b', refId: 'o1' });
      await w.inventory.restoreForReturn(tx, [{ productId: p.id, quantity: 3 }], { warehouseId: 'wh-b', refType: 'RETURN', refId: 'r1' });
    });
    assert.equal(balance(w, 'wh-b', p.id), 9);
    assert.equal(w.db.stockBalance.rows.filter((b: any) => b.warehouseId === 'wh-main').length, 0, 'nothing leaks into another warehouse');
    assert.deepEqual(
      w.db.stockMovement.rows.map((m: any) => m.type),
      ['OPENING', 'SALE', 'RETURN'],
    );
    assertLedgerConsistent(w);
  });

  it('keeps balances and ledger exactly consistent under many concurrent changes', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 1000, 'wh-main');
    await w.db.stockBalance.create({ data: { warehouseId: 'wh-b', productId: p.id, quantity: D(0) } });
    const jobs = Array.from({ length: 30 }, (_, i) =>
      w.db.$transaction(async (tx: any) => {
        const warehouseId = i % 2 ? 'wh-b' : 'wh-main';
        if (i % 5 === 0) await w.inventory.restoreForReturn(tx, [{ productId: p.id, quantity: 2 }], { warehouseId });
        else await w.inventory.deductForOrder(tx, [{ productId: p.id, quantity: 3 }], { warehouseId });
      }),
    );
    await Promise.all(jobs);
    assert.equal(w.db.stockMovement.rows.length, 31, 'one ledger row per change plus the opening row');
    assertLedgerConsistent(w);
  });

  it('external-supplier lines never touch stock', async () => {
    const w = world();
    const p = await addProduct(w, 'CEM', 10);
    await w.db.$transaction((tx: any) =>
      w.inventory.deductForOrder(tx, [{ productId: p.id, quantity: 5, sourceType: 'EXTERNAL_SUPPLIER' }], {}),
    );
    assert.equal(balance(w, 'wh-main', p.id), 10);
    assert.equal(w.db.stockMovement.rows.length, 1);
  });

  it('still allows overselling (existing behaviour) and records the negative balance', async () => {
    const w = world();
    const p = await addProduct(w, 'CEM', 2);
    await w.db.$transaction((tx: any) => w.inventory.deductForOrder(tx, [{ productId: p.id, quantity: 5 }], {}));
    assert.equal(balance(w, 'wh-main', p.id), -3);
    assertLedgerConsistent(w);
  });
});

// ----------------------------------------------------------------------------------------------
describe('manual stock adjustment', () => {
  it('needs a reason, sets a counted quantity as a ledger row and rejects a no-op', async () => {
    const w = world();
    const p = await addProduct(w, 'CEM', 10);
    await assert.rejects(
      () => w.inventory.adjust({ warehouseId: 'wh-main', productId: p.id, countedQuantity: 8, reason: ' ', actorId: manager.id }),
      BadRequestException,
    );
    const r = await w.inventory.adjust({ warehouseId: 'wh-main', productId: p.id, countedQuantity: 8, reason: 'stock count', actorId: manager.id });
    assert.deepEqual([r.before, r.after], [10, 8]);
    const row = w.db.stockMovement.rows.find((m: any) => m.type === 'ADJUSTMENT')!;
    assert.equal(Number(row.quantityDelta), -2);
    assert.equal(row.reason, 'stock count');
    assert.equal(row.actorId, manager.id);
    await assert.rejects(
      () => w.inventory.adjust({ warehouseId: 'wh-main', productId: p.id, countedQuantity: 8, reason: 'again', actorId: manager.id }),
      /does not change/,
    );
    assertLedgerConsistent(w);
  });

  it('a failed adjustment changes nothing', async () => {
    const w = world();
    const p = await addProduct(w, 'CEM', 10);
    await assert.rejects(
      () => w.inventory.adjust({ warehouseId: 'missing', productId: p.id, delta: 5, reason: 'oops', actorId: manager.id }),
      BadRequestException,
    );
    assert.equal(total(w, p.id), 10);
    assert.equal(w.db.stockMovement.rows.length, 1);
  });
});

// ----------------------------------------------------------------------------------------------
describe('staff are limited to their own warehouse', () => {
  const locked = (role: Role, warehouseId: string | null) => ({ role, warehouseId });

  it('only non-oversight staff with an assignment are locked', () => {
    assert.equal(lockedWarehouseId(locked(Role.BORLUULAGCH, 'wh-b')), 'wh-b');
    assert.equal(lockedWarehouseId(locked(Role.ACHIGCH_BELTGEGCH, 'wh-b')), 'wh-b');
    assert.equal(lockedWarehouseId(locked(Role.MANAGER, 'wh-b')), null);
    assert.equal(lockedWarehouseId(locked(Role.ADMIN, 'wh-b')), null);
    assert.equal(lockedWarehouseId(locked(Role.BORLUULAGCH, null)), null, 'unassigned staff behave as before warehouses existed');
  });

  it('another warehouse\'s order is refused', () => {
    assert.throws(() => assertWarehouseAccess(locked(Role.BORLUULAGCH, 'wh-b'), 'wh-main'), ForbiddenException);
    assert.doesNotThrow(() => assertWarehouseAccess(locked(Role.BORLUULAGCH, 'wh-b'), 'wh-b'));
    assert.doesNotThrow(() => assertWarehouseAccess(locked(Role.MANAGER, null), 'wh-b'));
  });

  it('a loader of warehouse B cannot complete warehouse A\'s order, and stock is not touched', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 10, 'wh-main');
    const order = await readyOrder(w, p.id, 2, 'wh-main');
    await assert.rejects(() => w.orders.complete(order.id, { ...loader, warehouseId: 'wh-b' }), ForbiddenException);
    assert.equal(balance(w, 'wh-main', p.id), 10);
    await w.orders.complete(order.id, { ...loader, warehouseId: 'wh-main' });
    assert.equal(balance(w, 'wh-main', p.id), 8);
  });

  it('release tickets and order lists show only the user\'s warehouse; managers see all', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 100);
    await readyOrder(w, p.id, 1, 'wh-main', 'BR-20261011-0001');
    await readyOrder(w, p.id, 1, 'wh-b', 'BR-20261011-0002');
    const mine = (await w.orders.listReleaseTickets({ ...loader, warehouseId: 'wh-b' })) as any[];
    assert.deepEqual(mine.map((o) => o.orderNumber), ['BR-20261011-0002']);
    const listed = (await w.orders.list({ ...cashier, warehouseId: 'wh-main' })) as any[];
    assert.deepEqual(listed.map((o) => o.orderNumber), ['BR-20261011-0001']);
    const all = (await w.orders.list(manager)) as any[];
    assert.equal(all.length, 2);
  });
});

// ----------------------------------------------------------------------------------------------
describe('choosing the warehouse of a new order', () => {
  const pick = (w: World, requested: string | undefined, user: any) => (w.orders as any).resolveOrderWarehouse(requested, user);

  it('defaults to the user\'s warehouse, then to the default warehouse', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    assert.equal(await pick(w, undefined, { ...cashier, warehouseId: 'wh-b' }), 'wh-b');
    assert.equal(await pick(w, undefined, cashier), 'wh-main');
    assert.equal(await pick(w, 'wh-b', manager), 'wh-b');
  });

  it('a locked cashier cannot sell from another warehouse', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    await assert.rejects(() => pick(w, 'wh-main', { ...cashier, warehouseId: 'wh-b' }), ForbiddenException);
  });

  it('rejects unknown and inactive warehouses', async () => {
    const w = world();
    await addWarehouse(w, 'wh-off', { isActive: false });
    await assert.rejects(() => pick(w, 'nope', manager), BadRequestException);
    await assert.rejects(() => pick(w, 'wh-off', manager), /not active/);
  });
});

// ----------------------------------------------------------------------------------------------
describe('stock listing', () => {
  it('shows the selected warehouse, or the total with a per-warehouse breakdown', async () => {
    const w = world();
    await addWarehouse(w, 'wh-b');
    const p = await addProduct(w, 'CEM', 10, 'wh-main');
    await w.db.stockBalance.create({ data: { warehouseId: 'wh-b', productId: p.id, quantity: D(7) } });
    // listStock reads through relations the in-memory DB does not model, so give it the shape Prisma returns.
    const db: any = w.db;
    const original = db.product.findMany.bind(db.product);
    db.product.findMany = async (args: any) =>
      (await original(args)).map((row: any) => ({ ...row, stockBalances: db.stockBalance.rows.filter((b: any) => b.productId === row.id) }));
    const inv = new InventoryService(db);

    const all = await inv.listStock(undefined, {});
    assert.equal(all.items[0].stockQty, 17);
    assert.deepEqual(all.items[0].warehouses!.map((x) => [x.code, x.quantity]), [['MAIN', 10], ['WH-B', 7]]);

    const b = await inv.listStock(undefined, { warehouseId: 'wh-b' });
    assert.equal(b.items[0].stockQty, 7);
  });
});
