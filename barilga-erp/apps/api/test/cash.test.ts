/* eslint-disable @typescript-eslint/no-explicit-any */
// Cash drawer shifts: open with a float, cash in/out, close with a count; cash needs an open drawer.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { assertCashDrawerOpen } from '../src/cash/cash-drawer';
import { CashService } from '../src/cash/cash.service';
import { FakeDb } from './helpers/fake-db';

const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier', warehouseId: 'wh-main' };
const other: any = { id: 'u-o', role: Role.BORLUULAGCH, name: 'Other', warehouseId: 'wh-main' };
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager' };

async function world() {
  const db = new FakeDb();
  await db.user.create({ data: { id: 'u-c', username: 'c', fullName: 'Кассчин', role: 'BORLUULAGCH', isActive: true } });
  const cash = new CashService(db as any);
  const order = await db.order.create({ data: { orderNumber: 'BR-1', status: 'READY_FOR_LOADING', totalMnt: 100_000 } });
  const pay = (method: string, amountMnt: number, recordedById = 'u-c') =>
    db.payment.create({ data: { orderId: order.id, method, amountMnt, status: 'PAID', paidAt: new Date(), recordedById } });
  return { db, cash, order, pay };
}

describe('cash drawer', () => {
  it('cash cannot be taken until the drawer is open (and the rule can be switched off)', async () => {
    const w = await world();
    await assert.rejects(() => assertCashDrawerOpen(w.db as any, cashier.id), BadRequestException);
    await w.cash.open(50_000, cashier);
    await assertCashDrawerOpen(w.db as any, cashier.id);
    await assert.rejects(() => assertCashDrawerOpen(w.db as any, other.id), BadRequestException, 'another cashier has no drawer');
    await w.db.featureFlag.create({ data: { key: 'CASH_SESSIONS', enabled: false } });
    await assertCashDrawerOpen(w.db as any, other.id);
  });

  it('expected cash = float + my cash sales − my cash refunds + in − out; other methods and people are listed apart', async () => {
    const w = await world();
    await w.cash.open(50_000, cashier);
    await new Promise((r) => setTimeout(r, 5));
    await w.pay('CASH', 120_000);
    await w.pay('CARD', 30_000);
    await w.pay('CASH', 999_000, 'u-o');
    await w.db.salesReturn.create({ data: { orderId: w.order.id, refundAmount: 20_000, refundMethod: 'CASH', createdById: 'u-c', createdAt: new Date() } });
    await w.cash.move('IN' as any, 10_000, 'Задгай мөнгө', cashier);
    await w.cash.move('OUT' as any, 100_000, 'Банкинд тушаасан', cashier);
    await assert.rejects(() => w.cash.move('OUT' as any, 1_000_000, 'Хэт их', cashier), BadRequestException);
    const cur: any = (await w.cash.current(cashier)).session;
    assert.equal(cur.summary.expectedCashMnt, 50_000 + 120_000 - 20_000 + 10_000 - 100_000);
    assert.equal(cur.summary.cardMnt, 30_000);
  });

  it('closing freezes the count and the difference; managers may close a drawer someone left open', async () => {
    const w = await world();
    await w.cash.open(50_000, cashier);
    await new Promise((r) => setTimeout(r, 5));
    await w.pay('CASH', 40_000);
    const closed: any = await w.cash.close(88_000, 'Дутсан', cashier);
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.expectedCashMnt, 90_000);
    assert.equal(closed.differenceMnt, -2_000);
    await assert.rejects(() => w.cash.close(1, undefined, cashier), Error);

    const s: any = await w.cash.open(0, other);
    await assert.rejects(() => w.cash.close(0, undefined, cashier, s.id), ForbiddenException);
    const byManager: any = await w.cash.close(0, 'Гэр рүүгээ явчихсан', manager, s.id);
    assert.equal(byManager.closedById, manager.id);
    assert.equal(byManager.differenceMnt, 0);
  });

  it('only managers list everyone’s drawers', async () => {
    const w = await world();
    await w.cash.open(1_000, cashier);
    await assert.rejects(() => w.cash.list(cashier, {}), ForbiddenException);
    assert.equal((await w.cash.list(manager, {})).length, 1);
  });
});
