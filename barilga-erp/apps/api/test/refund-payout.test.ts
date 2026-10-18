/* eslint-disable @typescript-eslint/no-explicit-any */
// Refunds: QPay purchases go back by bank transfer to a stated account; a manager marks the payout sent.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReturnsService } from '../src/returns/returns.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager' };
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };

async function qpayOrder() {
  const w = makePaymentWorld();
  const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
  const order = await w.db.order.create({ data: { orderNumber: 'BR-Q1', status: 'READY_FOR_LOADING', totalMnt: 50_000, warehouseId: 'wh-main' } });
  const item = await w.db.orderItem.create({ data: { orderId: order.id, productId: p.id, quantity: D(5), unitPrice: 10_000, lineTotal: 50_000, sourceType: 'INTERNAL' } });
  await w.db.payment.create({ data: { orderId: order.id, method: 'QPAY', amountMnt: 50_000, status: 'PAID' } });
  const returns = new ReturnsService(w.db as any, new InventoryService(w.db as any), {} as any);
  const ret = (refundMethod: string, refundAccount?: string) =>
    (returns as any).processReturn(w.db, order.id, { reason: 'Илүү авсан', refundMethod, refundAccount, items: [{ orderItemId: item.id, quantity: 1 }] }, cashier);
  return { w, returns, ret };
}

describe('refund payout', () => {
  it('QPay cannot send money back: the refund goes by bank transfer, and the account is required', async () => {
    const t = await qpayOrder();
    await assert.rejects(() => t.ret('QPAY'), /QPay/);
    await assert.rejects(() => t.ret('TRANSFER'), BadRequestException);
    const r: any = await t.ret('TRANSFER', 'Хаан банк 5000123456 Бат');
    const row: any = t.w.db.salesReturn.rows.at(-1);
    assert.equal(row.refundAccount, 'Хаан банк 5000123456 Бат');
    assert.equal(row.refundStatus, 'PENDING_PAYOUT');
    void r;
  });

  it('a manager marks the transfer sent; a cashier cannot', async () => {
    const t = await qpayOrder();
    await t.ret('TRANSFER', 'Голомт 1105012345 Дорж');
    const id = t.w.db.salesReturn.rows.at(-1)!.id;
    await assert.rejects(() => t.returns.markPaidOut(id, cashier), ForbiddenException);
    const done: any = await t.returns.markPaidOut(id, manager);
    assert.equal(done.refundStatus, 'PAID_OUT');
    assert.equal(done.paidOutById, manager.id);
  });
});
