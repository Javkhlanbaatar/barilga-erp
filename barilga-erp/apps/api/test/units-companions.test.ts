/* eslint-disable @typescript-eslint/no-explicit-any */
// Measuring units kept in the settings (defaults, saved list, units still on old products) and companion items
// picked from the catalog (the id is kept, an empty name / unit is copied, unknown and self picks refused).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompanionDto, UpdateProductDto } from '../src/catalog/dto/product.dto';
import { ProductsController } from '../src/catalog/products.controller';
import { DEFAULT_UNITS, SettingsService } from '../src/settings/settings.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number) => new Prisma.Decimal(n);
const admin = { id: 'u-admin', role: Role.ADMIN, warehouseId: null } as any;

async function errorsOf<T extends object>(cls: new () => T, plain: object) {
  return validate(plainToInstance(cls, plain) as object);
}

describe('measuring units (хэмжих нэгж)', () => {
  it('starts from the default list', async () => {
    const svc = new SettingsService(new FakeDb() as any);
    const { units } = await svc.units();
    assert.deepEqual(units, ['ш', 'ширхэг', 'шуудай', 'хуудас', 'кг', 'тн', 'м', 'м²', 'м³', 'л', 'боодол', 'ороомог', 'хайрцаг', 'багц']);
    assert.deepEqual(units, DEFAULT_UNITS);
  });

  it('saving trims, drops empty lines and repeats in any letter case, and writes one edits-report row', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    const { units } = await svc.setUnits([' кг ', 'КГ', '', '   ', 'м', 'м', 'Шуудай', 'шуудай'], 'u-admin');
    assert.deepEqual(units, ['кг', 'м', 'Шуудай'], 'first spelling kept');
    assert.deepEqual(db.appSetting.rows.find((r) => r.key === 'UNITS')?.value, ['кг', 'м', 'Шуудай']);
    assert.equal(db.editAudit.rows.length, 1);
    assert.equal(db.editAudit.rows[0].entityType, 'SETTINGS');
    assert.equal(db.editAudit.rows[0].entityId, 'UNITS');
    assert.match(db.editAudit.rows[0].summary, /^Хэмжих нэгжийн жагсаалт/);
    assert.equal(db.editAudit.rows[0].actorId, 'u-admin');

    await svc.setUnits(['кг', 'м', 'Шуудай'], 'u-admin'); // same list → no new row
    assert.equal(db.editAudit.rows.length, 1);
  });

  it('refuses a unit longer than 16 characters and more than 60 units', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    await assert.rejects(() => svc.setUnits(['кг', 'x'.repeat(17)], 'u-admin'), BadRequestException);
    await assert.rejects(() => svc.setUnits(Array.from({ length: 61 }, (_, i) => `n${i}`), 'u-admin'), BadRequestException);
    // Repeats do not count towards the 60.
    const sixty = Array.from({ length: 60 }, (_, i) => `n${i}`);
    assert.equal((await svc.setUnits([...sixty, ...sixty.map((u) => u.toUpperCase())], 'u-admin')).units.length, 60);
    await assert.rejects(() => svc.addUnit('n60', 'u-admin'), BadRequestException, 'the 61st cannot be added either');
  });

  it('adding one unit appends it once', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    const { units } = await svc.addUnit(' уут ', 'u-admin');
    assert.deepEqual(units, [...DEFAULT_UNITS, 'уут']);
    assert.deepEqual((await svc.addUnit('УУТ', 'u-admin')).units, [...DEFAULT_UNITS, 'уут'], 'already there in another case');
    assert.deepEqual((await svc.addUnit('кг', 'u-admin')).units, [...DEFAULT_UNITS, 'уут']);
    assert.equal(db.editAudit.rows.length, 1);
    await assert.rejects(() => svc.addUnit('   ', 'u-admin'), BadRequestException);
    await assert.rejects(() => svc.addUnit('x'.repeat(17), 'u-admin'), BadRequestException);
  });

  it('a unit still on an active product comes separately from the list, never saved into it', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    await svc.setUnits(['ш', 'кг'], 'u-admin');
    await db.product.create({ data: { sku: 'A', nameMn: 'Хос бээлий', unit: 'хос' } });
    await db.product.create({ data: { sku: 'B', nameMn: 'Бээлий 2', unit: 'хос' } });
    await db.product.create({ data: { sku: 'C', nameMn: 'Цемент', unit: 'кг' } });
    await db.product.create({ data: { sku: 'D', nameMn: 'Хуучин', unit: 'боодол2', active: false } });
    const res = await svc.units();
    assert.deepEqual(res.units, ['ш', 'кг']);
    assert.deepEqual(res.inUse, ['хос'], 'inactive products and listed units are not repeated');
    assert.deepEqual(db.appSetting.rows.find((r) => r.key === 'UNITS')?.value, ['ш', 'кг'], 'the saved list is unchanged');
  });

  it('a product can be saved with a trimmed unit that is not in the list, but not with an empty or long one', async () => {
    assert.equal((await errorsOf(UpdateProductDto, { unit: 'хос' })).length, 0);
    assert.equal(plainToInstance(UpdateProductDto, { unit: ' кг ' }).unit, 'кг');
    assert.equal((await errorsOf(UpdateProductDto, { unit: '   ' })).length, 1);
    assert.equal((await errorsOf(UpdateProductDto, { unit: 'x'.repeat(17) })).length, 1);
    assert.equal((await errorsOf(UpdateProductDto, {})).length, 0, 'unit stays optional on update');
  });
});

describe('companion items picked from the catalog', () => {
  async function world() {
    const db = new FakeDb();
    const products = new ProductsController(db as any, {} as any);
    const hardener = await db.product.create({
      data: { sku: 'HRD', nameMn: 'Хатаагч', nameEn: 'Hardener', unit: 'л', priceMnt: 12_000, stockQty: D(5) },
    });
    return { db, products, hardener };
  }
  const base = {
    nameEn: 'Epoxy paint',
    unit: 'кг',
    priceMnt: 50_000,
    weightKg: 5,
    lengthM: 0.3,
    volumeM3: 0.01,
    stockQty: 0,
    category: 'Будаг',
  };

  it('the form may leave the name and unit empty when a product is picked', async () => {
    assert.equal((await errorsOf(CompanionDto, { productId: 'p1', name: '', unit: '', qtyPerUnit: 1 })).length, 0);
    assert.equal((await errorsOf(CompanionDto, { productId: 'p1', qtyPerUnit: 1 })).length, 0);
    assert.equal((await errorsOf(CompanionDto, { name: '', unit: '', qtyPerUnit: 1 })).length, 1, 'a typed companion still needs a name');
    assert.equal((await errorsOf(CompanionDto, { productId: 'x'.repeat(65), name: 'A', unit: 'ш', qtyPerUnit: 1 })).length, 1);
  });

  it('keeps the id and copies the name and unit only where they were left empty', async () => {
    const { db, products, hardener } = await world();
    const created = await products.create(
      {
        ...base,
        sku: 'EPX',
        nameMn: 'Эпокси будаг',
        companions: [
          { productId: hardener.id, name: '', unit: '', qtyPerUnit: 0.5 },
          { productId: hardener.id, name: 'Хатаагч (жижиг)', unit: 'ш', qtyPerUnit: 1 },
          { name: 'Сойз', unit: '', qtyPerUnit: 1 },
        ],
      } as any,
      admin,
    );
    assert.deepEqual(created.companions, [
      { name: 'Хатаагч', qtyPerUnit: 0.5, unit: 'л', productId: hardener.id },
      { name: 'Хатаагч (жижиг)', qtyPerUnit: 1, unit: 'ш', productId: hardener.id },
      { name: 'Сойз', qtyPerUnit: 1, unit: 'ш' },
    ]);
    // Display only: the picked product's stock and price stay as they were, nothing else is booked.
    const after = db.product.rows.find((p) => p.id === hardener.id)!;
    assert.equal(Number(after.stockQty), 5);
    assert.equal(after.priceMnt, 12_000);
    assert.equal(db.stockMovement.rows.length, 0);

    const updated = await products.update(created.id, { companions: [{ productId: hardener.id, qtyPerUnit: 2 }] } as any, admin);
    assert.deepEqual(updated.companions, [{ name: 'Хатаагч', qtyPerUnit: 2, unit: 'л', productId: hardener.id }]);
  });

  it('refuses an unknown product', async () => {
    const { db, products, hardener } = await world();
    await assert.rejects(
      () => products.create({ ...base, sku: 'EPX', nameMn: 'Эпокси будаг', companions: [{ productId: 'nope', qtyPerUnit: 1 }] } as any, admin),
      (e: unknown) => e instanceof BadRequestException && /Дагах бараа олдсонгүй/.test(e.message),
    );
    assert.equal(db.product.rows.length, 1, 'nothing created');
    await assert.rejects(
      () => products.update(hardener.id, { companions: [{ productId: 'nope', name: 'X', unit: 'ш', qtyPerUnit: 1 }] } as any, admin),
      BadRequestException,
    );
  });

  it('refuses a product going out with itself', async () => {
    const { db, products, hardener } = await world();
    await assert.rejects(
      () => products.update(hardener.id, { companions: [{ productId: hardener.id, qtyPerUnit: 1 }] } as any, admin),
      (e: unknown) => e instanceof BadRequestException && /өөрийгөө дагахгүй/.test(e.message),
    );
    assert.equal(db.product.rows[0].companions ?? null, null, 'unchanged');
  });
});
