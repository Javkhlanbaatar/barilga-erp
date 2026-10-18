/* eslint-disable @typescript-eslint/no-explicit-any */
// Document templates: defaults until changed; a change to one document keeps the others and other fields.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SettingsService } from '../src/settings/settings.service';
import { FakeDb } from './helpers/fake-db';

describe('document templates', () => {
  it('start from the built-in wording and keep what was not changed', async () => {
    const svc = new SettingsService(new FakeDb() as any);
    const first = await svc.documents();
    assert.deepEqual(first.issueNote.signatures, ['Олгосон (нярав)', 'Хүлээн авсан', 'Шалгасан']);
    assert.equal(first.invoice.title, '');

    await svc.setDocuments({ invoice: { title: 'НЭХЭМЖЛЭЛ', blankRows: 3, signatures: [' Нягтлан ', '', 'Захирал'] } } as any, 'u-admin');
    const after = await svc.documents();
    assert.equal(after.invoice.title, 'НЭХЭМЖЛЭЛ');
    assert.equal(after.invoice.blankRows, 3);
    assert.deepEqual(after.invoice.signatures, ['Нягтлан', 'Захирал'], 'trimmed, empty lines dropped');
    assert.equal(after.invoice.stamp, true, 'untouched field kept');
    assert.deepEqual(after.issueNote, first.issueNote, 'other documents untouched');
  });
});

describe('changes are kept in the edits report', () => {
  it('a template change and a company change each write one readable row', async () => {
    const db = new FakeDb();
    const svc = new SettingsService(db as any);
    await svc.setDocuments({ issueNote: { showPrices: false } } as any, 'u-gm');
    await svc.setDocuments({ issueNote: { showPrices: false } } as any, 'u-gm'); // no change → no row
    await svc.setCompany({ name: 'Барилга ХХК', regNumber: '1234567' } as any, 'u-admin');
    const rows = db.editAudit.rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].entityType, 'DOC_TEMPLATE');
    assert.match(rows[0].summary, /Зарлагын баримт \(үнэ харуулах\)/);
    assert.equal(rows[1].entityType, 'SETTINGS');
    assert.match(rows[1].summary, /нэр, РД/);
    assert.equal(rows[1].actorId, 'u-admin');
  });
});
