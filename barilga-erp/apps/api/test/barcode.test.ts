/* eslint-disable @typescript-eslint/no-explicit-any */
// In-store barcodes: valid EAN-13 in the 200 range, running numbers, never reused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ean13CheckDigit, isValidEan13, nextInStoreBarcode, normalizeBarcode } from '../src/catalog/barcode';
import { barcodeFormat } from '../../web/src/components/barcode-format';
import { FakeDb } from './helpers/fake-db';

describe('barcodes', () => {
  it('computes EAN-13 check digits like the printed codes', () => {
    assert.equal(ean13CheckDigit('400638133393'), '1'); // 4006381333931, a well-known example
    assert.ok(isValidEan13('4006381333931'));
    assert.ok(!isValidEan13('4006381333932'));
  });

  it('issues running in-store codes after the highest one, skipping manufacturer codes', async () => {
    const db = new FakeDb();
    assert.equal(await nextInStoreBarcode(db as any), '2000000000015');
    await db.product.create({ data: { sku: 'A', barcode: '2000000000015' } });
    await db.product.create({ data: { sku: 'B', barcode: '4006381333931' } });
    const next = await nextInStoreBarcode(db as any);
    assert.equal(next, '2000000000022');
    assert.ok(isValidEan13(next));
  });

  it('stores codes without spaces; empty means none', () => {
    assert.equal(normalizeBarcode(' 4006 3813 33931 '), '4006381333931');
    assert.equal(normalizeBarcode('  '), null);
  });

  it('prints valid EAN-13 as EAN-13 and anything else as Code 128', () => {
    assert.equal(barcodeFormat('2000000000015'), 'EAN13');
    assert.equal(barcodeFormat('2000000000016'), 'CODE128');
    assert.equal(barcodeFormat('ABC-123'), 'CODE128');
  });
});
