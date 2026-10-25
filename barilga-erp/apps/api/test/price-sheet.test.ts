/* eslint-disable @typescript-eslint/no-explicit-any */
// Printed / shared price lists: no costs, listed prices first, links limited to a selection that can be revoked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PERMISSION_KEY_META } from '../src/auth/permissions';
import { CATALOG_READ_ROLES } from '../src/auth/rbac';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import { PriceListsController } from '../src/customers/price-lists.controller';
import { PriceListsService } from '../src/customers/price-lists.service';
import { FEATURE_KEY } from '../src/features/feature.guard';
import { ymdInUlaanbaatar } from '../src/reports/report-dates';
import { FakeDb } from './helpers/fake-db';

const admin = { id: 'u-admin', role: Role.ADMIN };
const cashier = { id: 'u-cash', role: Role.BORLUULAGCH };

async function world() {
  const db = new FakeDb();
  const svc = new PriceListsService(db as any);
  const cem = await db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', unit: 'шуудай', category: 'Цемент', priceMnt: 20_000, lastCostMnt: 15_000, active: true } });
  const brk = await db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', unit: 'ш', category: 'Тоосго', priceMnt: 500, lastCostMnt: 300, active: true } });
  const blk = await db.product.create({ data: { sku: 'BLK', nameMn: 'Блок', unit: 'ш', category: 'Тоосго', priceMnt: 1_200, lastCostMnt: 900, active: true } });
  const pip = await db.product.create({ data: { sku: 'PIP', nameMn: 'Хоолой', unit: 'м', category: 'Сантехник', priceMnt: 8_000, lastCostMnt: 6_000, active: true } });
  const list = await db.priceList.create({ data: { name: 'Бөөний үнэ' } });
  await db.priceListItem.create({ data: { priceListId: list.id, productId: cem.id, priceMnt: 18_000 } });
  await db.priceListItem.create({ data: { priceListId: list.id, productId: brk.id, priceMnt: 450 } });
  return { db, svc, list, cem, brk, blk, pip };
}

const skus = (sheet: any) => sheet.items.map((i: any) => i.sku).sort();
const tokenOf = (path: string) => path.split('/').pop()!;

describe('price list sheet', () => {
  it('shows listed products at the list price and never the cost', async () => {
    const w = await world();
    const sheet: any = await w.svc.sheet(w.list.id);
    assert.deepEqual(skus(sheet), ['BRK', 'CEM']);
    assert.deepEqual(
      sheet.items.find((i: any) => i.sku === 'CEM'),
      { sku: 'CEM', nameMn: 'Цемент', unit: 'шуудай', category: 'Цемент', priceMnt: 18_000, retailMnt: 20_000, listed: true },
    );
    assert.equal(sheet.scope, null, 'nothing picked: the whole list');
    assert.ok(!JSON.stringify(sheet).includes('15000'), 'no cost on the sheet');
    const all: any = await w.svc.sheet(w.list.id, { all: true });
    assert.equal(all.items.find((i: any) => i.sku === 'PIP').priceMnt, 8_000, 'unlisted products at retail when asked');
    assert.equal(all.items.find((i: any) => i.sku === 'PIP').listed, false);
  });

  it('a sheet can be limited to picked products, categories, or both (id OR category)', async () => {
    const w = await world();
    const byIds: any = await w.svc.sheet(w.list.id, { productIds: [w.cem.id] });
    assert.deepEqual(skus(byIds), ['CEM']);
    assert.deepEqual(byIds.scope, { count: 1, categories: [] });

    const byCat: any = await w.svc.sheet(w.list.id, { all: true, categories: ['Тоосго'] });
    assert.deepEqual(skus(byCat), ['BLK', 'BRK']);
    assert.equal(byCat.items.find((i: any) => i.sku === 'BRK').priceMnt, 450, 'list price kept');
    assert.equal(byCat.items.find((i: any) => i.sku === 'BLK').priceMnt, 1_200, 'unlisted at retail');
    assert.deepEqual(byCat.scope, { count: 2, categories: ['Тоосго'] });

    const both: any = await w.svc.retailSheet({ productIds: [w.pip.id], categories: ['Цемент'] });
    assert.deepEqual(skus(both), ['CEM', 'PIP']);
    assert.equal(both.items.find((i: any) => i.sku === 'CEM').priceMnt, 20_000, 'retail sheet: shelf price');
    assert.equal(both.name, 'Жижиглэн үнийн жагсаалт');
    assert.equal(both.scope.count, 2);

    assert.deepEqual(skus(await w.svc.retailSheet()), ['BLK', 'BRK', 'CEM', 'PIP'], 'nothing picked: every product');
    assert.deepEqual(skus(await w.svc.sheet(w.list.id, { productIds: [w.pip.id] })), [], 'a picked product off the list stays off without all');
  });

  it('refuses ids that are not product ids and caps the selection', async () => {
    const w = await world();
    await assert.rejects(() => w.svc.retailSheet({ productIds: ["x' OR 1=1"] }), BadRequestException);
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await assert.rejects(() => w.svc.retailSheet({ productIds: many }), BadRequestException);
    await assert.rejects(() => w.svc.retailSheet({ categories: Array.from({ length: 101 }, (_, i) => `c${i}`) }), BadRequestException);
    const ok: any = await w.svc.retailSheet({ productIds: [w.cem.id, ` ${w.cem.id.toUpperCase()} `] });
    assert.deepEqual(skus(ok), ['CEM'], 'trimmed, case-folded and de-duplicated');
  });

  it('the whole-list link opens the sheet until it is revoked or the list is switched off', async () => {
    const w = await world();
    const { publicPath } = await w.svc.share(w.list.id, 'u-admin');
    const token = tokenOf(publicPath);
    assert.equal((await w.svc.share(w.list.id, 'u-admin')).publicPath, publicPath, 'same link on a second send');
    const prices: any = await w.svc.prices(w.list.id);
    assert.equal(prices.shared, true);
    assert.equal(prices.publicPath, publicPath);
    assert.deepEqual(skus(await w.svc.publicSheet(token)), ['BRK', 'CEM']);
    await w.svc.update(w.list.id, { isActive: false });
    await assert.rejects(() => w.svc.publicSheet(token), NotFoundException);
    await w.svc.update(w.list.id, { isActive: true });
    await w.svc.unshare(w.list.id, 'u-admin');
    await assert.rejects(() => w.svc.publicSheet(token), NotFoundException);
    assert.equal(((await w.svc.prices(w.list.id)) as any).shared, false);
    await assert.rejects(() => w.svc.publicSheet('short'), NotFoundException);
    assert.notEqual((await w.svc.share(w.list.id, 'u-admin')).publicPath, publicPath, 'a new link after closing the old one');
  });

  it('a link made for some products never shows the others', async () => {
    const w = await world();
    const share: any = await w.svc.createShare(
      { priceListId: w.list.id, label: 'Бат ХХК', productIds: [w.cem.id], categories: ['Сантехник'], includeUnlisted: true },
      admin,
    );
    assert.ok(share.token && share.publicPath.endsWith(share.token));
    const sheet: any = await w.svc.publicSheet(share.token);
    assert.deepEqual(skus(sheet), ['CEM', 'PIP']);
    assert.equal(sheet.items.find((i: any) => i.sku === 'CEM').priceMnt, 18_000);
    assert.equal(sheet.items.find((i: any) => i.sku === 'PIP').priceMnt, 8_000);
    assert.equal(sheet.label, 'Бат ХХК');
    assert.deepEqual(sheet.scope, { count: 2, categories: ['Сантехник'] });
    assert.ok(!JSON.stringify(sheet).includes('BRK') && !JSON.stringify(sheet).includes('15000'));

    // Without includeUnlisted only listed products of the selection show.
    const listedOnly: any = await w.svc.createShare({ priceListId: w.list.id, categories: ['Тоосго', 'Сантехник'] }, admin);
    assert.deepEqual(skus(await w.svc.publicSheet(listedOnly.token)), ['BRK']);

    // A limited link does not count as the list's whole-list link, and closing that one leaves it open.
    assert.equal(((await w.svc.prices(w.list.id)) as any).shared, false);
    await w.svc.unshare(w.list.id, 'u-admin');
    assert.deepEqual(skus(await w.svc.publicSheet(share.token)), ['CEM', 'PIP']);

    const listed: any[] = await w.svc.listShares(w.list.id, admin);
    assert.equal(listed.length, 2);
    const mine = listed.find((s) => s.id === share.id);
    assert.equal(mine.status, 'ACTIVE');
    assert.equal(mine.productCount, 1);
    assert.equal(mine.categoryCount, 1);
    assert.equal(mine.itemCount, 2);
    assert.equal(listed.find((s) => s.id === listedOnly.id).itemCount, 1);
  });

  it('a revoked or expired link is refused; the last day still works', async () => {
    const w = await world();
    const share: any = await w.svc.createShare({ priceListId: w.list.id, productIds: [w.cem.id] }, admin);
    await w.svc.revokeShare(share.id, admin);
    await assert.rejects(() => w.svc.publicSheet(share.token), NotFoundException);
    assert.equal((await w.svc.listShares(w.list.id, admin))[0].status, 'REVOKED');

    const old = await w.db.priceShare.create({
      data: { token: 'e'.repeat(32), priceListId: w.list.id, productIds: [], categories: [], expiresAt: new Date('2020-01-01T00:00:00Z') },
    });
    await assert.rejects(() => w.svc.publicSheet(old.token), (err: any) => err instanceof NotFoundException && /хугацаа дууссан/.test(err.message));

    const today = ymdInUlaanbaatar();
    const lastDay: any = await w.svc.createShare({ priceListId: w.list.id, expiresAt: today }, admin);
    assert.equal(lastDay.expiresAt, today);
    assert.deepEqual(skus(await w.svc.publicSheet(lastDay.token)), ['BRK', 'CEM']);
    await assert.rejects(() => w.svc.createShare({ priceListId: w.list.id, expiresAt: '2020-01-01' }, admin), BadRequestException);
    await assert.rejects(() => w.svc.createShare({ priceListId: w.list.id, expiresAt: '2030-02-30' }, admin), BadRequestException);
    await assert.rejects(() => w.svc.revokeShare('missing', admin), NotFoundException);
  });

  it('the till may send retail prices but not a price list', async () => {
    const w = await world();
    const share: any = await w.svc.createShare({ priceListId: null, categories: ['Тоосго'] }, cashier);
    const sheet: any = await w.svc.publicSheet(share.token);
    assert.equal(sheet.name, 'Жижиглэн үнийн жагсаалт');
    assert.deepEqual(skus(sheet), ['BLK', 'BRK']);
    assert.equal(sheet.items.find((i: any) => i.sku === 'BRK').priceMnt, 500, 'retail price, not the list price');
    assert.equal((await w.svc.listShares('retail', cashier)).length, 1);

    await assert.rejects(() => w.svc.createShare({ priceListId: w.list.id }, cashier), ForbiddenException);
    await assert.rejects(() => w.svc.listShares(w.list.id, cashier), ForbiddenException);
    const listShare: any = await w.svc.createShare({ priceListId: w.list.id }, admin);
    await assert.rejects(() => w.svc.revokeShare(listShare.id, cashier), ForbiddenException);
    await w.svc.revokeShare(share.id, cashier);
    await assert.rejects(() => w.svc.publicSheet(share.token), NotFoundException);
    await assert.rejects(() => w.svc.createShare({ priceListId: null, productIds: ['00000000-0000-4000-8000-000000000000'] }, cashier), BadRequestException);
  });

  it('a link copied from the old per-list token shows the listed products', async () => {
    const w = await world();
    // What the migration made from crm_price_lists.share_token.
    const migrated = await w.db.priceShare.create({
      data: { token: 'm'.repeat(32), priceListId: w.list.id, productIds: [], categories: [], includeUnlisted: false },
    });
    const sheet: any = await w.svc.publicSheet(migrated.token);
    assert.deepEqual(skus(sheet), ['BRK', 'CEM']);
    assert.equal(sheet.scope, null);
    const prices: any = await w.svc.prices(w.list.id);
    assert.equal(prices.publicPath, `/price/${migrated.token}`, 'the list screen shows the old link');
    assert.equal((await w.svc.share(w.list.id, 'u-admin')).token, migrated.token, 'no second link made');
  });

  it('the list of price lists carries no link token', async () => {
    const w = await world();
    w.db.priceList.rows[0].shareToken = 'legacy-token-legacy-token-123';
    const share = await w.svc.share(w.list.id, 'u-admin');
    const rows: any[] = await w.svc.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].productCount, 2);
    assert.equal(rows[0].customerCount, 0);
    const json = JSON.stringify(rows);
    assert.ok(!('shareToken' in rows[0]));
    assert.ok(!json.includes('legacy-token') && !json.includes(share.token) && !/token/i.test(json));
    assert.ok(!('shareToken' in ((await w.svc.update(w.list.id, { notes: 'x' })) as any)));
  });

  it('a whole-list link with an end date is not taken for the everyday link', async () => {
    const w = await world();
    const dated: any = await w.svc.createShare({ priceListId: w.list.id, expiresAt: '2099-12-31' }, admin);
    const plain = await w.svc.share(w.list.id, 'u-admin');
    assert.notEqual(plain.token, dated.token, 'the everyday link must not stop working on that date');
    assert.equal((await w.svc.share(w.list.id, 'u-admin')).token, plain.token, 'and it is reused after that');
  });

  it("closing the list's own link leaves the links made for someone open", async () => {
    const w = await world();
    const named: any = await w.svc.createShare({ priceListId: w.list.id, label: 'Номин' }, admin);
    const plain = await w.svc.share(w.list.id, 'u-admin');
    await w.svc.unshare(w.list.id, 'u-admin');
    const rows = w.db.priceShare.rows;
    assert.ok(rows.find((s: any) => s.token === plain.token)!.revokedAt, 'the everyday link is closed');
    assert.equal(rows.find((s: any) => s.token === named.token)!.revokedAt ?? null, null, "Номин's link still opens");
  });

  it('validity date is stored as a day', async () => {
    const w = await world();
    await w.svc.update(w.list.id, { validUntil: '2026-12-31' });
    assert.equal(((await w.svc.sheet(w.list.id)) as any).validUntil, '2026-12-31');
  });

  it('every role that reads the catalog prints shelf prices, even with the module off', () => {
    const proto = PriceListsController.prototype as any;
    assert.deepEqual(Reflect.getMetadata(ROLES_KEY, proto.retailSheet), [...CATALOG_READ_ROLES]);
    assert.ok((Reflect.getMetadata(ROLES_KEY, proto.retailSheet) as Role[]).includes(Role.ACHIGCH_BELTGEGCH));
    assert.equal(Reflect.getMetadata(FEATURE_KEY, proto.retailSheet), undefined);
    assert.equal(Reflect.getMetadata(FEATURE_KEY, PriceListsController), undefined);
    for (const name of Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && n !== 'retailSheet')) {
      assert.equal(Reflect.getMetadata(FEATURE_KEY, proto[name]), 'PRICE_LISTS', `${name} stays behind the module`);
      assert.ok(Reflect.getMetadata(PERMISSION_KEY_META, proto[name]), `${name} needs a right`);
    }
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY_META, proto.createShare).key, 'PRICE_LIST_WRITE');
  });
});
