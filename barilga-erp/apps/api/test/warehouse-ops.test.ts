/* eslint-disable @typescript-eslint/no-explicit-any */
// Picking checklist, goods receipts, company settings and the module switches added with them.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { FEATURE_KEY, FeatureGuard } from '../src/features/feature.guard';
import { FeaturesService } from '../src/features/features.service';
import { HrController } from '../src/hr/hr.controller';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReceiptsController } from '../src/inventory/receipts.controller';
import { ReceiptsService } from '../src/inventory/receipts.service';
import { LogisticsService } from '../src/logistics/logistics.service';
import { OrdersService } from '../src/orders/orders.service';
import { PublicController } from '../src/public/public.controller';
import { ReportsController } from '../src/reports/reports.controller';
import { SettingsService } from '../src/settings/settings.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number) => new Prisma.Decimal(n);
const manager: any = { id: 'u-mgr', role: Role.MANAGER, name: 'Manager' };
const pickerA: any = { id: 'u-pa', role: Role.ACHIGCH_BELTGEGCH, name: 'Picker A', warehouseId: 'wh-main' };
const pickerB: any = { id: 'u-pb', role: Role.ACHIGCH_BELTGEGCH, name: 'Picker B', warehouseId: 'wh-main' };
const otherShop: any = { id: 'u-x', role: Role.ACHIGCH_BELTGEGCH, name: 'Other', warehouseId: 'wh-b' };

describe('picking checklist', () => {
  async function setup(status = 'READY_FOR_LOADING') {
    const db = new FakeDb();
    await db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B' } });
    const features = new FeaturesService(db as any);
    const orders = new OrdersService(db as any, {} as any, {} as any, new InventoryService(db as any), {} as any, features);
    const order = await db.order.create({ data: { orderNumber: 'BR-1', status, warehouseId: 'wh-main', totalMnt: 0 } });
    const a = await db.orderItem.create({ data: { orderId: order.id, productId: 'p1', quantity: D(1) } });
    const b = await db.orderItem.create({ data: { orderId: order.id, productId: 'p2', quantity: D(1) } });
    return { db, features, orders, order, a, b };
  }

  it('two people pick different lines of one order; each line records who picked it', async () => {
    const { db, orders, order, a, b } = await setup();
    await orders.pickItem(order.id, a.id, true, pickerA);
    await orders.pickItem(order.id, b.id, true, pickerB);
    const rows = db.orderItem.rows;
    assert.equal(rows.find((r: any) => r.id === a.id)!.pickedById, 'u-pa');
    assert.equal(rows.find((r: any) => r.id === b.id)!.pickedById, 'u-pb');
  });

  it('a second tick does not steal the line; unticking clears it', async () => {
    const { db, orders, order, a } = await setup();
    await orders.pickItem(order.id, a.id, true, pickerA);
    const again = await orders.pickItem(order.id, a.id, true, pickerB);
    assert.equal(db.orderItem.rows.find((r: any) => r.id === a.id)!.pickedById, 'u-pa');
    assert.equal(again.pickedAt instanceof Date, true);
    await orders.pickItem(order.id, a.id, false, pickerB);
    assert.equal(db.orderItem.rows.find((r: any) => r.id === a.id)!.pickedAt, null);
  });

  it('only paid orders waiting for loading, only in your own warehouse, only while the module is on', async () => {
    const unpaid = await setup('PENDING_PAYMENT');
    await assert.rejects(() => unpaid.orders.pickItem(unpaid.order.id, unpaid.a.id, true, pickerA), BadRequestException);
    const w = await setup();
    await assert.rejects(() => w.orders.pickItem(w.order.id, w.a.id, true, otherShop), ForbiddenException);
    await w.features.set('PICKING', false, 'u-admin');
    await assert.rejects(() => w.orders.pickItem(w.order.id, w.a.id, true, pickerA), ForbiddenException);
    assert.equal(w.db.orderItem.rows[0].pickedAt, null);
  });
});

describe('goods receipts (бараа орлого)', () => {
  async function setup() {
    const db = new FakeDb();
    await db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B' } });
    const inventory = new InventoryService(db as any);
    const receipts = new ReceiptsService(db as any, inventory);
    const p = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
    const q = await db.product.create({ data: { sku: 'SAND', nameMn: 'Элс', stockQty: D(0) } });
    return { db, receipts, p, q };
  }
  const bal = (db: FakeDb, wh: string, pid: string) =>
    Number(db.stockBalance.rows.find((b: any) => b.warehouseId === wh && b.productId === pid)?.quantity ?? 0);

  it('adds stock with RECEIPT ledger rows; cost is optional and updates the last cost when given', async () => {
    const { db, receipts, p, q } = await setup();
    const r = await receipts.create(
      {
        warehouseId: 'wh-main',
        supplierName: 'Хөтөл цемент',
        supplierInvoiceNo: 'INV-77',
        items: [
          { productId: p.id, quantity: 100, unitCostMnt: 14500 },
          { productId: q.id, quantity: 2.5 },
        ],
      },
      manager,
    );
    assert.match(r.receiptNumber, /^OR-\d{8}-0001$/);
    assert.equal(bal(db, 'wh-main', p.id), 100);
    assert.equal(bal(db, 'wh-main', q.id), 2.5);
    const moves = db.stockMovement.rows.filter((m: any) => m.refId === r.id);
    assert.deepEqual(moves.map((m: any) => m.type), ['RECEIPT', 'RECEIPT']);
    assert.equal(db.product.rows.find((x: any) => x.id === p.id)!.lastCostMnt, 14500);
    assert.equal(db.product.rows.find((x: any) => x.id === q.id)!.lastCostMnt, undefined, 'no cost given → unchanged');
  });

  it('warehouse staff receive only into their own warehouse; bad lines are refused and change nothing', async () => {
    const { db, receipts, p } = await setup();
    await assert.rejects(
      () => receipts.create({ warehouseId: 'wh-main', supplierName: 'X', items: [{ productId: p.id, quantity: 1 }] }, otherShop),
      ForbiddenException,
    );
    await assert.rejects(
      () => receipts.create({ warehouseId: 'wh-main', supplierName: 'X', items: [{ productId: p.id, quantity: 0 }] }, manager),
      BadRequestException,
    );
    await assert.rejects(
      () =>
        receipts.create(
          { warehouseId: 'wh-main', supplierName: 'X', items: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 2 }] },
          manager,
        ),
      BadRequestException,
    );
    await assert.rejects(
      () => receipts.create({ warehouseId: 'wh-main', supplierName: 'X', items: [{ productId: 'nope', quantity: 1 }] }, manager),
      BadRequestException,
    );
    assert.equal(db.stockReceipt.rows.length, 0);
    assert.equal(bal(db, 'wh-main', p.id), 0);
  });
});

describe('company settings', () => {
  it('are empty until an admin saves them, then round-trip', async () => {
    const svc = new SettingsService(new FakeDb() as any);
    assert.equal((await svc.company()).configured, false);
    const saved = await svc.setCompany(
      { name: 'Барилга Хангамж ХХК', regNumber: '6123456', bankAccounts: [{ bankName: 'Хаан банк', accountNumber: '5000123456' }] },
      'u-admin',
    );
    assert.equal(saved.configured, true);
    assert.equal(saved.bankAccounts[0].accountName, '');
    assert.equal((await svc.company()).regNumber, '6123456');
  });
});

describe('module switches', () => {
  it('unloading is off by default and a quote asking for it is refused before any pricing', async () => {
    const db = new FakeDb();
    const logistics = new LogisticsService(db as any, new FeaturesService(db as any));
    await assert.rejects(
      () => logistics.quote({ zoneId: 'z', method: 'OUR_DELIVERY', time: 'STANDARD', unloadingRequested: true, specs: {} as any }),
      /Unloading service is switched off/,
    );
  });

  it('each new module is enforced on the server', () => {
    const guarded = (target: object) => (Reflect.getMetadata('__guards__', target) as unknown[] | undefined)?.includes(FeatureGuard);
    assert.equal(Reflect.getMetadata(FEATURE_KEY, HrController), 'HR');
    assert.ok(guarded(HrController));
    assert.equal(Reflect.getMetadata(FEATURE_KEY, ReceiptsController), 'STOCK_RECEIPTS');
    assert.ok(guarded(ReceiptsController));
    assert.equal(Reflect.getMetadata(FEATURE_KEY, (ReportsController.prototype as any).warehouse), 'WAREHOUSE_REPORT');
    assert.ok(guarded(ReportsController));
    assert.ok(guarded(PublicController));
    for (const route of ['catalog', 'quote', 'create']) {
      assert.equal(Reflect.getMetadata(FEATURE_KEY, (PublicController.prototype as any)[route]), 'ONLINE_SHOP', route);
    }
    for (const route of ['config', 'find', 'updateTransport']) {
      assert.equal(Reflect.getMetadata(FEATURE_KEY, (PublicController.prototype as any)[route]), undefined, `${route} stays open for tracking`);
    }
  });
});
