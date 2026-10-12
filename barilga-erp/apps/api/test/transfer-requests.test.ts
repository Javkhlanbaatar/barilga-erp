/* eslint-disable @typescript-eslint/no-explicit-any */
// Transfer requests from shops, sending fewer than asked, and receiving with a shortage.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { TransfersService } from '../src/inventory/transfers.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number | string) => new Prisma.Decimal(n);
const manager: any = { id: 'u-mgr', role: Role.MANAGER, name: 'Manager' };
const mainStaff: any = { id: 'u-a', role: Role.ACHIGCH_BELTGEGCH, name: 'A', warehouseId: 'wh-main' };
const shopStaff: any = { id: 'u-b', role: Role.BORLUULAGCH, name: 'B', warehouseId: 'wh-b' };

async function setup() {
  const db = new FakeDb();
  const inventory = new InventoryService(db as any);
  const transfers = new TransfersService(db as any, inventory);
  await db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Shop B', isActive: true } });
  const cement = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0), active: true, minStockLevel: D(20) } });
  const brick = await db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', stockQty: D(0), active: true, minStockLevel: D(0) } });
  await db.$transaction(async (tx: any) => {
    await inventory.applyMovement(tx, { warehouseId: 'wh-main', productId: cement.id, delta: 100, type: 'OPENING' });
    await inventory.applyMovement(tx, { warehouseId: 'wh-main', productId: brick.id, delta: 500, type: 'OPENING' });
    await inventory.applyMovement(tx, { warehouseId: 'wh-b', productId: cement.id, delta: 5, type: 'OPENING' });
  });
  const bal = (w: string, p: string) => Number(db.stockBalance.rows.find((b: any) => b.warehouseId === w && b.productId === p)?.quantity ?? 0);
  return { db, transfers, cement, brick, bal };
}

describe('transfer requests', () => {
  it('a shop asks; nothing moves until the source sends; the source may send less', async () => {
    const w = await setup();
    const req: any = await w.transfers.request(
      { fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 30 }, { productId: w.brick.id, quantity: 200 }] },
      shopStaff,
    );
    assert.equal(req.status, 'REQUESTED');
    assert.equal(w.bal('wh-main', w.cement.id), 100, 'a request moves nothing');
    assert.equal(req.sentById ?? null, null);

    await assert.rejects(() => w.transfers.dispatch(req.id, {}, shopStaff), ForbiddenException, 'the shop cannot send for the source');
    const sent: any = await w.transfers.dispatch(req.id, { items: [{ productId: w.brick.id, quantity: 0 }] }, mainStaff);
    assert.equal(sent.status, 'IN_TRANSIT');
    assert.equal(w.bal('wh-main', w.cement.id), 70, '30 cement left the source');
    assert.equal(w.bal('wh-main', w.brick.id), 500, 'brick not sent (0)');
    await assert.rejects(() => w.transfers.dispatch(req.id, {}, mainStaff), ConflictException, 'cannot dispatch twice');
  });

  it('cannot send more than the source holds, or nothing at all', async () => {
    const w = await setup();
    const req: any = await w.transfers.request({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 150 }] }, shopStaff);
    await assert.rejects(() => w.transfers.dispatch(req.id, {}, mainStaff), BadRequestException);
    await assert.rejects(() => w.transfers.dispatch(req.id, { items: [{ productId: w.cement.id, quantity: 0 }] }, mainStaff), BadRequestException);
    const ok: any = await w.transfers.dispatch(req.id, { items: [{ productId: w.cement.id, quantity: 100 }] }, mainStaff);
    assert.equal(ok.status, 'IN_TRANSIT');
  });

  it('only the destination may request for itself; either side may withdraw/refuse a request', async () => {
    const w = await setup();
    await assert.rejects(
      () => w.transfers.request({ fromWarehouseId: 'wh-b', toWarehouseId: 'wh-main', items: [{ productId: w.cement.id, quantity: 1 }] }, shopStaff),
      ForbiddenException,
    );
    const req: any = await w.transfers.request({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 5 }] }, shopStaff);
    const refused: any = await w.transfers.cancel(req.id, 'Үлдэгдэл хэрэгтэй', mainStaff);
    assert.equal(refused.status, 'CANCELLED');
    assert.equal(w.bal('wh-main', w.cement.id), 100);
  });

  it('receiving with a shortage takes in only what arrived and keeps the reason', async () => {
    const w = await setup();
    const t: any = await w.transfers.send({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 40 }] }, manager);
    await assert.rejects(
      () => w.transfers.receive(t.id, shopStaff, { items: [{ productId: w.cement.id, receivedQty: 38 }] }),
      BadRequestException,
      'a shortage needs a reason',
    );
    await assert.rejects(
      () => w.transfers.receive(t.id, shopStaff, { items: [{ productId: w.cement.id, receivedQty: 41 }] }),
      BadRequestException,
      'cannot receive more than sent',
    );
    const r: any = await w.transfers.receive(t.id, shopStaff, { items: [{ productId: w.cement.id, receivedQty: 38, reason: '2 уут урагдсан' }] });
    assert.equal(r.status, 'RECEIVED');
    assert.equal(r.hasShortage, true);
    assert.equal(Number(r.items[0].receivedQty), 38);
    assert.equal(r.items[0].shortageReason, '2 уут урагдсан');
    assert.equal(w.bal('wh-b', w.cement.id), 5 + 38);
    assert.equal(w.bal('wh-main', w.cement.id), 60);
  });

  it('a full receipt without lines takes in everything that was sent', async () => {
    const w = await setup();
    const t: any = await w.transfers.send({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 10 }] }, manager);
    const r: any = await w.transfers.receive(t.id, shopStaff);
    assert.equal(r.hasShortage, false);
    assert.equal(w.bal('wh-b', w.cement.id), 15);
  });

  it('suggests what a shop below its minimum should ask for, capped at what the source has', async () => {
    const w = await setup();
    const s = await w.transfers.suggest('wh-b', 'wh-main', shopStaff);
    assert.deepEqual(s.map((r) => [r.sku, r.atShop, r.suggested]), [['CEM', 5, 35]], 'min 20 → aim for 40, shop has 5');
  });

  it('counts what waits for each side', async () => {
    const w = await setup();
    await w.transfers.request({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 5 }] }, shopStaff);
    await w.transfers.send({ fromWarehouseId: 'wh-main', toWarehouseId: 'wh-b', items: [{ productId: w.cement.id, quantity: 5 }] }, manager);
    assert.deepEqual(await w.transfers.pending(mainStaff), { toSend: 1, toReceive: 0, total: 1 });
    assert.deepEqual(await w.transfers.pending(shopStaff), { toSend: 0, toReceive: 1, total: 1 });
  });
});
