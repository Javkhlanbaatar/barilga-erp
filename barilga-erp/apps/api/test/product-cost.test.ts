/* eslint-disable @typescript-eslint/no-explicit-any */
// The purchase cost corrected on the product form: only with the purchase-cost right, written to the edit
// history, and never sent back to someone who lacks that right.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProductDto } from '../src/catalog/dto/product.dto';
import { ProductsController } from '../src/catalog/products.controller';
import { FakeDb } from './helpers/fake-db';

const D = (n: number) => new Prisma.Decimal(n);
const admin = { id: 'u-admin', role: Role.ADMIN, warehouseId: null } as any;
const manager = { id: 'u-gm', role: Role.SUPER_MANAGER, warehouseId: null } as any;
// A cashier given the product right but not the purchase-cost right.
const cashier = { id: 'u-c', role: Role.BORLUULAGCH, warehouseId: null, permissions: { grant: ['PRODUCT_WRITE'] } } as any;

async function world() {
  const db = new FakeDb();
  const products = new ProductsController(db as any, {} as any);
  await db.product.create({
    data: { id: 'p-1', sku: 'CEM-1', nameMn: 'Цемент', nameEn: 'Cement', unit: 'шуудай', priceMnt: 25_000, lastCostMnt: 20_000, weightKg: D(50), volumeM3: D(0.03), lengthM: D(0.5), category: 'Цемент, бетон', active: true },
  });
  return { db, products };
}

describe('purchase cost on the product form', () => {
  it('a manager corrects it; the edit history keeps before and after', async () => {
    const w = await world();
    const saved: any = await w.products.update('p-1', { lastCostMnt: 19_500 } as any, manager);
    assert.equal(saved.lastCostMnt, 19_500);
    const audit = w.db.editAudit.rows.find((a: any) => a.entityType === 'PRODUCT_COST');
    assert.ok(audit && /20000 → 19500/.test(audit.summary));
    await w.products.update('p-1', { lastCostMnt: null } as any, admin);
    assert.equal(w.db.product.rows[0].lastCostMnt, null, 'it can be cleared');
  });

  it('needs the purchase-cost right; someone without it does not get the cost back', async () => {
    const w = await world();
    await assert.rejects(() => w.products.update('p-1', { lastCostMnt: 1 } as any, cashier), ForbiddenException);
    assert.equal(w.db.product.rows[0].lastCostMnt, 20_000);
    const saved: any = await w.products.update('p-1', { priceMnt: 26_000, lastCostMnt: 20_000 } as any, cashier);
    assert.equal(saved.priceMnt, 26_000, 'an unchanged cost sent back by the form is not a change');
    assert.ok(!('lastCostMnt' in saved));
  });

  it('price and cost changed in one save: "below cost" is judged against the new cost', async () => {
    const w = await world();
    await w.products.update('p-1', { priceMnt: 25_500, lastCostMnt: 26_000 } as any, manager);
    const priceRow = () => w.db.editAudit.rows.filter((a: any) => a.entityType === 'PRODUCT_PRICE').at(-1);
    assert.match(priceRow().summary, /25500 \(өртөг 26000₮-өөс доош\)/);
    await w.products.update('p-1', { priceMnt: 18_000, lastCostMnt: 15_000 } as any, manager);
    assert.ok(!/доош/.test(priceRow().summary), 'not below the new cost of 15000');
  });

  it('whole tugrik only', async () => {
    const errs = async (v: unknown) => (await validate(plainToInstance(UpdateProductDto, { lastCostMnt: v }), { whitelist: true, forbidNonWhitelisted: true })).length;
    assert.equal(await errs(18_500), 0);
    assert.equal(await errs(null), 0);
    assert.ok((await errs(18.5)) > 0);
    assert.ok((await errs(-1)) > 0);
  });
});
