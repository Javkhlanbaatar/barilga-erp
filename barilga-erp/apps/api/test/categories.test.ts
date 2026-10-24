/* eslint-disable @typescript-eslint/no-explicit-any */
// Product categories kept in the settings like the measuring units: defaults for a building-materials shop, the
// saved list, categories still on active products appended after it, and who may read and change the list.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSION_KEY_META } from '../src/auth/permissions';
import { CATALOG_READ_ROLES } from '../src/auth/rbac';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import { AddCategoryDto, CategoriesDto } from '../src/settings/dto/categories.dto';
import { SettingsController } from '../src/settings/settings.controller';
import { DEFAULT_CATEGORIES, SettingsService } from '../src/settings/settings.service';
import { FakeDb } from './helpers/fake-db';

async function errorsOf<T extends object>(cls: new () => T, plain: object) {
  return validate(plainToInstance(cls, plain) as object);
}

describe('product categories (барааны ангилал)', () => {
  it('starts from the default list for a building-materials shop', async () => {
    const svc = new SettingsService(new FakeDb() as any);
    const { categories } = await svc.categories();
    assert.deepEqual(categories, [
      'Дотор засал',
      'Гадна хананы өнгөлгөө',
      'Хуурай холимог',
      'Будаг, лак',
      'Дулаалга',
      'Гипс хавтан, профиль',
      'Цемент, бетон',
      'Хавтанцар',
      'Багаж хэрэгсэл',
      'Бэхэлгээ',
      'Сантехник',
      'Цахилгаан',
      'Бусад',
    ]);
    assert.deepEqual(categories, DEFAULT_CATEGORIES);
  });

  it('saving trims, drops empty lines, "General" and repeats in any letter case, and writes one edits-report row', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    const { categories } = await svc.setCategories(
      [' Дотор засал ', 'ДОТОР ЗАСАЛ', '', '   ', 'General', 'general', 'Багаж хэрэгсэл', 'Багаж хэрэгсэл', 'Шал', 'шал'],
      'u-admin',
    );
    assert.deepEqual(categories, ['Дотор засал', 'Багаж хэрэгсэл', 'Шал'], 'first spelling kept');
    assert.deepEqual(db.appSetting.rows.find((r) => r.key === 'CATEGORIES')?.value, ['Дотор засал', 'Багаж хэрэгсэл', 'Шал']);
    assert.equal(db.editAudit.rows.length, 1);
    assert.equal(db.editAudit.rows[0].entityType, 'SETTINGS');
    assert.equal(db.editAudit.rows[0].entityId, 'CATEGORIES');
    assert.match(db.editAudit.rows[0].summary, /^Барааны ангиллын жагсаалт/);
    assert.equal(db.editAudit.rows[0].actorId, 'u-admin');

    await svc.setCategories(['Дотор засал', 'Багаж хэрэгсэл', 'Шал'], 'u-admin'); // same list → no new row
    assert.equal(db.editAudit.rows.length, 1);
    await svc.setCategories(['Шал', 'Дотор засал', 'Багаж хэрэгсэл'], 'u-admin'); // order only
    assert.equal(db.editAudit.rows.length, 2);
    assert.match(db.editAudit.rows[1].summary, /дараалал өөрчилсөн/);
  });

  it('refuses a category longer than 60 characters and more than 100 categories', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    await assert.rejects(() => svc.setCategories(['Будаг', 'x'.repeat(61)], 'u-admin'), BadRequestException);
    assert.equal((await svc.setCategories(['x'.repeat(60)], 'u-admin')).categories[0].length, 60, '60 is still fine');
    await assert.rejects(() => svc.setCategories(Array.from({ length: 101 }, (_, i) => `c${i}`), 'u-admin'), BadRequestException);
    // Repeats do not count towards the 100.
    const hundred = Array.from({ length: 100 }, (_, i) => `c${i}`);
    assert.equal((await svc.setCategories([...hundred, ...hundred.map((c) => c.toUpperCase())], 'u-admin')).categories.length, 100);
    await assert.rejects(() => svc.addCategory('c100', 'u-admin'), BadRequestException, 'the 101st cannot be added either');
  });

  it('adding one category appends it once', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    const { categories } = await svc.addCategory(' Дээврийн материал ', 'u-admin');
    assert.deepEqual(categories, [...DEFAULT_CATEGORIES, 'Дээврийн материал']);
    assert.deepEqual((await svc.addCategory('ДЭЭВРИЙН МАТЕРИАЛ', 'u-admin')).categories, [...DEFAULT_CATEGORIES, 'Дээврийн материал'], 'already there in another case');
    assert.deepEqual((await svc.addCategory('Хавтанцар', 'u-admin')).categories, [...DEFAULT_CATEGORIES, 'Дээврийн материал']);
    assert.equal(db.editAudit.rows.length, 1);
    assert.equal(db.editAudit.rows[0].entityId, 'CATEGORIES');
    await assert.rejects(() => svc.addCategory('   ', 'u-admin'), BadRequestException);
    await assert.rejects(() => svc.addCategory('General', 'u-admin'), (e: unknown) => e instanceof BadRequestException && /General/.test(e.message));
    await assert.rejects(() => svc.addCategory('x'.repeat(61), 'u-admin'), BadRequestException);
    assert.equal(db.editAudit.rows.length, 1, 'refused names change nothing');
  });

  it('categories still on active products come separately from the list (never saved into it); products never change', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    await db.product.create({ data: { sku: 'A', nameMn: 'Шаваас', unit: 'кг', category: 'Дотор засал' } });
    await db.product.create({ data: { sku: 'B', nameMn: 'Цемент М400', unit: 'шуудай', category: 'Cement' } });
    await db.product.create({ data: { sku: 'C', nameMn: 'Цемент М500', unit: 'шуудай', category: ' Cement ' } });
    await db.product.create({ data: { sku: 'D', nameMn: 'Хадаас', unit: 'кг', category: 'Hardware' } });
    await db.product.create({ data: { sku: 'E', nameMn: 'Ангилалгүй', unit: 'ш', category: 'General' } });
    await db.product.create({ data: { sku: 'F', nameMn: 'Хоосон', unit: 'ш', category: '   ' } });
    await db.product.create({ data: { sku: 'G', nameMn: 'Хуучин', unit: 'ш', category: 'Archived', active: false } });
    await db.product.create({ data: { sku: 'H', nameMn: 'Будаг', unit: 'л', category: 'будаг, ЛАК' } });

    const first = await svc.categories();
    assert.deepEqual(first.categories, DEFAULT_CATEGORIES);
    assert.deepEqual(first.inUse, ['Cement', 'Hardware'], 'trimmed, once, sorted; General, empty, inactive and listed ones left out');

    await svc.setCategories(['Хуурай холимог', 'Будаг, лак'], 'u-admin');
    const after = await svc.categories();
    assert.deepEqual(after.categories, ['Хуурай холимог', 'Будаг, лак']);
    assert.deepEqual(after.inUse, ['Cement', 'Hardware', 'Дотор засал']);
    // Saving the list back as the page does keeps only the list: in-use categories do not creep into it.
    await svc.setCategories(after.categories, 'u-admin');
    assert.deepEqual((await svc.categories()).categories, ['Хуурай холимог', 'Будаг, лак']);
    await assert.rejects(() => svc.addCategory('Ерөнхий', 'u-admin'), /болохгүй/);
    assert.deepEqual(db.appSetting.rows.find((r) => r.key === 'CATEGORIES')?.value, ['Хуурай холимог', 'Будаг, лак'], 'the saved list is unchanged');
    assert.deepEqual(
      db.product.rows.map((p) => p.category),
      ['Дотор засал', 'Cement', ' Cement ', 'Hardware', 'General', '   ', 'Archived', 'будаг, ЛАК'],
      'products keep their category',
    );
  });

  it('the request bodies: a list of text, one trimmed category of 1–60 characters', async () => {
    assert.equal((await errorsOf(CategoriesDto, { categories: ['Дотор засал', ' Бусад '] })).length, 0);
    assert.deepEqual(plainToInstance(CategoriesDto, { categories: [' Бусад '] }).categories, ['Бусад']);
    assert.equal((await errorsOf(CategoriesDto, { categories: 'Бусад' })).length, 1);
    assert.equal((await errorsOf(CategoriesDto, { categories: [1] })).length, 1);
    assert.equal((await errorsOf(AddCategoryDto, { category: 'Шал' })).length, 0);
    assert.equal(plainToInstance(AddCategoryDto, { category: ' Шал ' }).category, 'Шал');
    assert.equal((await errorsOf(AddCategoryDto, { category: '   ' })).length, 1);
    assert.equal((await errorsOf(AddCategoryDto, { category: 'x'.repeat(61) })).length, 1);
    assert.equal((await errorsOf(AddCategoryDto, {})).length, 1);
  });

  it('read by everyone who sees the catalog, changed with the same right as the units (PRODUCT_WRITE)', () => {
    const proto = SettingsController.prototype as any;
    assert.deepEqual(Reflect.getMetadata(ROLES_KEY, proto.categories), [...CATALOG_READ_ROLES]);
    assert.deepEqual(Reflect.getMetadata(ROLES_KEY, proto.categories), Reflect.getMetadata(ROLES_KEY, proto.units));
    assert.equal(Reflect.getMetadata(PERMISSION_KEY_META, proto.categories), undefined);
    for (const name of ['setCategories', 'addCategory']) {
      assert.equal(Reflect.getMetadata(PERMISSION_KEY_META, proto[name])?.key, 'PRODUCT_WRITE', name);
      assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY_META, proto[name]), Reflect.getMetadata(PERMISSION_KEY_META, proto.setUnits), name);
    }
    // Routes: GET / PUT / POST /settings/categories.
    assert.equal(Reflect.getMetadata(PATH_METADATA, SettingsController), 'settings');
    for (const [name, method] of [
      ['categories', RequestMethod.GET],
      ['setCategories', RequestMethod.PUT],
      ['addCategory', RequestMethod.POST],
    ] as const) {
      assert.equal(Reflect.getMetadata(PATH_METADATA, proto[name]), 'categories', name);
      assert.equal(Reflect.getMetadata(METHOD_METADATA, proto[name]), method, name);
    }
  });
});
