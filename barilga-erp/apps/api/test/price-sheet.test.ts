/* eslint-disable @typescript-eslint/no-explicit-any */
// Printed / shared price lists: no costs, listed prices first, a link that can be revoked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { PriceListsService } from '../src/customers/price-lists.service';
import { FakeDb } from './helpers/fake-db';

async function world() {
  const db = new FakeDb();
  const svc = new PriceListsService(db as any);
  const cem = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', unit: 'шуудай', category: 'Цемент', priceMnt: 20_000, lastCostMnt: 15_000, active: true } });
  const brk = await db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', unit: 'ш', category: 'Тоосго', priceMnt: 500, lastCostMnt: 300, active: true } });
  const list = await db.priceList.create({ data: { name: 'Бөөний үнэ' } });
  await db.priceListItem.create({ data: { priceListId: list.id, productId: cem.id, priceMnt: 18_000 } });
  return { db, svc, list, cem, brk };
}

describe('price list sheet', () => {
  it('shows listed products at the list price and never the cost', async () => {
    const w = await world();
    const sheet: any = await w.svc.sheet(w.list.id);
    assert.equal(sheet.items.length, 1);
    assert.deepEqual(sheet.items[0], { sku: 'CEM', nameMn: 'Цемент', unit: 'шуудай', category: 'Цемент', priceMnt: 18_000, retailMnt: 20_000, listed: true });
    assert.ok(!JSON.stringify(sheet).includes('15000'), 'no cost on the sheet');
    const all: any = await w.svc.sheet(w.list.id, true);
    assert.equal(all.items.find((i: any) => i.sku === 'BRK').priceMnt, 500, 'unlisted products at retail when asked');
  });

  it('a shared link opens the sheet until it is revoked or the list is switched off', async () => {
    const w = await world();
    const { publicPath } = await w.svc.share(w.list.id, 'u-admin');
    const token = publicPath.split('/').pop()!;
    assert.equal((await w.svc.share(w.list.id, 'u-admin')).publicPath, publicPath, 'same link on a second send');
    assert.equal(((await w.svc.publicSheet(token)) as any).items[0].priceMnt, 18_000);
    await w.svc.update(w.list.id, { isActive: false });
    await assert.rejects(() => w.svc.publicSheet(token), NotFoundException);
    await w.svc.update(w.list.id, { isActive: true });
    await w.svc.unshare(w.list.id, 'u-admin');
    await assert.rejects(() => w.svc.publicSheet(token), NotFoundException);
    await assert.rejects(() => w.svc.publicSheet('short'), NotFoundException);
  });

  it('validity date is stored as a day', async () => {
    const w = await world();
    await w.svc.update(w.list.id, { validUntil: '2026-12-31' });
    assert.equal(((await w.svc.sheet(w.list.id)) as any).validUntil, '2026-12-31');
  });
});
