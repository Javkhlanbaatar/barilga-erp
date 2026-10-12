/* eslint-disable @typescript-eslint/no-explicit-any */
// Money-flow fixes from the permission audit, and the reworked payroll.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { countWorkingDays, HrService } from '../src/hr/hr.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReceiptsService } from '../src/inventory/receipts.service';
import { ReturnsService } from '../src/returns/returns.service';
import { FakeDb } from './helpers/fake-db';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const admin: any = { id: 'u-admin', role: Role.ADMIN, name: 'Admin', fullName: 'Admin' };
const manager: any = { id: 'u-m', role: Role.MANAGER, name: 'Manager', fullName: 'Manager' };
const picker: any = { id: 'u-p', role: Role.ACHIGCH_BELTGEGCH, name: 'Picker', warehouseId: 'wh-main' };

describe('money refunds never exceed money received', () => {
  async function paidOrder(method: string) {
    const w = makePaymentWorld();
    const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
    const order = await w.db.order.create({ data: { orderNumber: 'BR-R1', status: 'READY_FOR_LOADING', totalMnt: 50_000, warehouseId: 'wh-main' } });
    const item = await w.db.orderItem.create({ data: { orderId: order.id, productId: p.id, quantity: D(5), unitPrice: 10_000, lineTotal: 50_000, sourceType: 'INTERNAL' } });
    await w.db.payment.create({ data: { orderId: order.id, method, amountMnt: 50_000, status: 'PAID' } });
    const returns = new ReturnsService(w.db as any, new InventoryService(w.db as any), {} as any);
    const ret = (qty: number, refundMethod = 'CASH') =>
      (returns as any).processReturn(w.db, order.id, { reason: 'буцаалт', refundMethod, items: [{ orderItemId: item.id, quantity: qty }] }, manager);
    return { ret };
  }

  it('an order paid by contract offset cannot be refunded in cash', async () => {
    const w = await paidOrder('OFFSET');
    await assert.rejects(() => w.ret(1), BadRequestException);
  });

  it('a cash-paid order refunds up to what was paid, in total across returns', async () => {
    const w = await paidOrder('CASH');
    await w.ret(3);
    await w.ret(2);
    // everything refunded; a further return would exceed what came in
  });
});

describe('only managers create money owed to a supplier', () => {
  it('warehouse staff cannot enter a cost or a supplier partner on a receipt', async () => {
    const db = new FakeDb();
    const receipts = new ReceiptsService(db as any, new InventoryService(db as any));
    const p = await db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', stockQty: D(0) } });
    await assert.rejects(
      () => receipts.create({ warehouseId: 'wh-main', supplierName: 'Нийлүүлэгч', items: [{ productId: p.id, quantity: 10, unitCostMnt: 500 }] } as any, picker),
      ForbiddenException,
    );
    const ok: any = await receipts.create({ warehouseId: 'wh-main', supplierName: 'Нийлүүлэгч', items: [{ productId: p.id, quantity: 10 }] } as any, picker);
    assert.ok(ok.receiptNumber, 'quantities alone are fine');
  });
});

describe('payroll', () => {
  async function world() {
    const db = new FakeDb();
    const hr = new HrService(db as any);
    const cashier = await db.user.create({ data: { username: 'k', fullName: 'Кассчин', role: 'BORLUULAGCH', isActive: true, baseSalaryMnt: null } });
    const picker2 = await db.user.create({ data: { username: 'w', fullName: 'Ачигч', role: 'ACHIGCH_BELTGEGCH', isActive: true, baseSalaryMnt: 2_000_000 } });
    return { db, hr, cashier, picker2 };
  }
  const row = (r: any, id: string) => r.rows.find((x: any) => x.user.id === id);

  it('working days follow the week setting', () => {
    assert.equal(countWorkingDays('2026-10', 5), 22);
    assert.equal(countWorkingDays('2026-10', 6), 27);
    assert.equal(countWorkingDays('2026-10', 7), 31);
  });

  it('own salary beats the role default; commission is on real money minus refunds; deductions apply', async () => {
    const w = await world();
    const o1 = await w.db.order.create({ data: { orderNumber: 'A', status: 'COMPLETED', totalMnt: 1_000_000, createdById: w.cashier.id } });
    await w.db.payment.create({ data: { orderId: o1.id, method: 'CASH', amountMnt: 1_000_000, status: 'PAID', paidAt: new Date('2026-10-05T04:00:00Z') } });
    await w.db.payment.create({ data: { orderId: o1.id, method: 'OFFSET', amountMnt: 500_000, status: 'PAID', paidAt: new Date('2026-10-05T04:00:00Z') } });
    await w.db.salesReturn.create({ data: { orderId: o1.id, refundAmount: 200_000, refundMethod: 'CASH', createdAt: new Date('2026-10-06T04:00:00Z') } });
    await w.db.order.create({ data: { orderNumber: 'B', status: 'COMPLETED', totalMnt: 1, createdById: w.cashier.id, preparedById: w.picker2.id, preparedAt: new Date('2026-10-07T04:00:00Z') } });
    await w.hr.savePayrollSettings({ socialInsurancePct: 10, incomeTaxPct: 10, salesCommissionPct: 1 } as any, admin);
    await w.hr.addAdjustment({ userId: w.picker2.id, periodMonth: '2026-10', amountMnt: -100_000, reason: 'Урьдчилгаа' }, manager);

    const r: any = await w.hr.payroll(manager, '2026-10');
    const k = row(r, w.cashier.id);
    assert.equal(k.baseSalary, 1_800_000, 'role default');
    assert.equal(k.salesAmountMnt, 800_000, '1 000 000 cash − 200 000 refund; the offset is not money');
    assert.equal(k.salesBonus, 8_000);
    const p = row(r, w.picker2.id);
    assert.equal(p.baseSalary, 2_000_000, 'own salary');
    assert.equal(p.ticketBonus, 15_000);
    assert.equal(p.adjustmentsMnt, -100_000);
    assert.equal(p.grossSalary, 2_000_000 + 15_000 - 100_000);
    assert.equal(p.socialInsuranceMnt, 191_500);
    assert.equal(p.incomeTaxMnt, Math.round((1_915_000 - 191_500) * 0.1));
    assert.equal(p.netSalary, p.grossSalary - p.socialInsuranceMnt - p.incomeTaxMnt);
  });

  it('pro-rating by attendance pays the base for the days worked', async () => {
    const w = await world();
    await w.hr.savePayrollSettings({ prorateByAttendance: true, workDaysPerWeek: 5 } as any, admin);
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-02']) {
      await w.db.attendance.create({ data: { userId: w.picker2.id, checkIn: new Date(`${d}T01:00:00Z`) } });
    }
    const p = row(await w.hr.payroll(manager, '2026-10'), w.picker2.id);
    assert.equal(p.workedDays, 2, 'two check-ins on one day count once');
    assert.equal(p.earnedBase, Math.round((2_000_000 * 2) / 22));
  });

  it('a paid month is frozen; only admin sets rates, salaries and pays', async () => {
    const w = await world();
    const first: any = await w.hr.payroll(manager, '2026-10');
    await assert.rejects(() => w.hr.savePayrollSettings({ ticketBonusMnt: 1 } as any, manager), ForbiddenException);
    await assert.rejects(() => w.hr.setBaseSalary(w.cashier.id, 5_000_000, manager), ForbiddenException);
    const pRow = row(first, w.picker2.id);
    await w.hr.markPaid(pRow.id, admin);
    await w.hr.setBaseSalary(w.picker2.id, 9_000_000, admin);
    await assert.rejects(
      () => w.hr.addAdjustment({ userId: w.picker2.id, periodMonth: '2026-10', amountMnt: 5, reason: 'Шагнал' }, manager),
      BadRequestException,
    );
    const again = row(await w.hr.payroll(manager, '2026-10'), w.picker2.id);
    assert.equal(again.netSalary, pRow.netSalary, 'paid amount does not move');
    assert.equal(again.status, 'PAID');
  });
});
