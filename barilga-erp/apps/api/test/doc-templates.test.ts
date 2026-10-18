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
