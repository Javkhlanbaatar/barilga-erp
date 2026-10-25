/* eslint-disable @typescript-eslint/no-explicit-any */
// The E-Barimt module switch: when off, the ERP sends nothing to POSAPI.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { EbarimtService } from '../src/ebarimt/ebarimt.service';
import { FakeDb } from './helpers/fake-db';

const off: any = { isEnabled: async (k: string) => k !== 'EBARIMT' };
const on: any = { isEnabled: async () => true };

async function paidOrder(db: FakeDb) {
  const order = await db.order.create({
    data: { orderNumber: 'BR-20261012-0101', status: 'READY_FOR_LOADING', totalMnt: 6000, billType: 'CITIZEN' },
  });
  await db.payment.create({ data: { orderId: order.id, amountMnt: 6000, status: 'PAID' } });
  return order;
}

describe('E-Barimt module switch', () => {
  it('off: a paid order is not sent to POSAPI, and a manual issue is refused', async () => {
    const db = new FakeDb();
    const order = await paidOrder(db);
    let sent = 0;
    const client: any = { buildPosapiBody: () => ({}), sendReceipt: async () => (sent++, { receiptId: 'R', raw: {} }), returnReceipt: async () => (sent++, {}) };
    const svc = new EbarimtService(db as any, client, off);
    const res: any = await svc.issueAfterPaid(order.id);
    assert.equal(res.error, 'module_off');
    await assert.rejects(svc.issueForOrder(order.id), ForbiddenException);
    assert.deepEqual(await svc.retryDue(), { checked: 0 });
    assert.equal(sent, 0);
    assert.equal((await db.order.findUnique({ where: { id: order.id } }))!.ebarimtStatus ?? 'NOT_ISSUED', 'NOT_ISSUED');
  });

  it('on: a paid order is issued', async () => {
    const db = new FakeDb();
    const order = await paidOrder(db);
    let sent = 0;
    const client: any = { buildPosapiBody: () => ({}), sendReceipt: async () => (sent++, { receiptId: 'R1', lottery: 'L', qrCode: 'Q', raw: {} }) };
    await new EbarimtService(db as any, client, on).issueAfterPaid(order.id);
    assert.equal(sent, 1);
  });
});
