/* eslint-disable @typescript-eslint/no-explicit-any */
// Search across Cyrillic and Latin.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Role } from '@prisma/client';
import { productSearchFilter } from '../src/catalog/product-search';
import { matchesSearch, searchKey } from '../src/common/translit';
import { CustomersService } from '../src/customers/customers.service';
import { FakeDb } from './helpers/fake-db';

describe('Cyrillic ↔ Latin search', () => {
  const hits: Array<[string, string]> = [
    ['Цемент М400 50кг', 'tsement'],
    ['Цемент М400 50кг', 'cement m400'],
    ['Хөөсөн блок 190мм', 'hoosun'],
    ['Хөөсөн блок 190мм', 'khoson blok'],
    ['Хөөсөн блок 190мм', 'block'],
    ['Улаан тоосго', 'ulaan toosgo'],
    ['Хайрга 10-20', 'xairga'],
    ['Өндөр Барилга ХХК', 'undur'],
    ['Өндөр Барилга ХХК', 'ondor barilga'],
    ['Цагаан', 'cagaan'],
    ['Tsement', 'цемент'],
    ['Хөөсөн блок', 'хөөсөн'],
    ['ХӨӨСӨН БЛОК', 'хөөсөн'],
  ];
  for (const [text, q] of hits) {
    it(`"${q}" finds "${text}"`, () => assert.ok(matchesSearch(text, q), `${searchKey(text)} / ${searchKey(q)}`));
  }

  it('numbers stay exact and unrelated words do not match', () => {
    assert.equal(matchesSearch('Цемент М400', 'm40 '), true, 'a prefix of a number still matches like plain text');
    assert.equal(searchKey('1000'), '1000');
    assert.equal(matchesSearch('Цемент М400', 'арматур'), false);
    assert.equal(matchesSearch('Элс', 'faner'), false);
  });

  it('the web copy is identical (one rule for the POS grid and the server)', () => {
    const body = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('// ----')[1];
    assert.equal(body(join(__dirname, '..', '..', 'web', 'src', 'lib', 'translit.ts')), body(join(__dirname, '..', 'src', 'common', 'translit.ts')));
  });

  it('server product search uses the same rule', async () => {
    const db = new FakeDb();
    const p = await db.product.create({ data: { sku: 'CEM-42', nameMn: 'Цемент М400', nameEn: 'Cement', description: null } });
    await db.product.create({ data: { sku: 'SND', nameMn: 'Элс', nameEn: 'Sand', description: null } });
    const where: any = await productSearchFilter(db as any, 'tsement');
    assert.deepEqual(where.id.in, [p.id]);
  });

  it('customers are found in either alphabet', async () => {
    const db = new FakeDb();
    const customers = new CustomersService(db as any);
    await customers.create({ type: 'COMPANY', name: 'Өндөр Барилга ХХК', phone: '99112233', regNumber: '6001234' } as any, { id: 'u', role: Role.MANAGER } as any);
    assert.equal((await customers.search('undur')).length, 1);
    assert.equal((await customers.search('Өндөр')).length, 1);
    assert.equal((await customers.search('9911')).length, 1);
  });
});
