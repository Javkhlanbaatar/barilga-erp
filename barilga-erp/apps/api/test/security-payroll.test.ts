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
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager', fullName: 'Manager' };
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

  it('a paid month is frozen; admin sets rates; admin or the general manager set salaries and pay', async () => {
    const w = await world();
    const branch: any = { id: 'u-b', role: Role.MANAGER, name: 'Branch', warehouseId: 'wh-main' };
    const first: any = await w.hr.payroll(manager, '2026-10');
    await assert.rejects(() => w.hr.savePayrollSettings({ ticketBonusMnt: 1 } as any, manager), ForbiddenException);
    await assert.rejects(() => w.hr.setBaseSalary(w.cashier.id, 5_000_000, branch), ForbiddenException);
    await w.hr.setBaseSalary(w.cashier.id, 1_900_000, manager);
    const pRow = row(first, w.picker2.id);
    await w.hr.markPaid(pRow.id, admin);
    await assert.rejects(() => w.hr.setBaseSalary(w.picker2.id, 9_000_000, admin, { fromMonth: '2026-10' }), BadRequestException, 'a paid month is not re-priced');
    await w.hr.setBaseSalary(w.picker2.id, 9_000_000, admin, { fromMonth: '2026-11' });
    await assert.rejects(
      () => w.hr.addAdjustment({ userId: w.picker2.id, periodMonth: '2026-10', amountMnt: 5, reason: 'Шагнал' }, manager),
      BadRequestException,
    );
    const again = row(await w.hr.payroll(manager, '2026-10'), w.picker2.id);
    assert.equal(again.netSalary, pRow.netSalary, 'paid amount does not move');
    assert.equal(again.status, 'PAID');
    assert.equal(row(await w.hr.payroll(manager, '2026-11'), w.picker2.id).baseSalary, 9_000_000, 'the new salary applies from its month');
  });

  it('a salary change applies from its month on; earlier unpaid months keep the old amount', async () => {
    const w = await world();
    await w.hr.setBaseSalary(w.cashier.id, 1_500_000, admin, { fromMonth: '2026-09', reason: 'Ажилд орсон' });
    await w.hr.setBaseSalary(w.cashier.id, 1_800_000, admin, { fromMonth: '2026-11', reason: 'Цалин нэмэв' });
    assert.equal(row(await w.hr.payroll(admin, '2026-10'), w.cashier.id).baseSalary, 1_500_000);
    assert.equal(row(await w.hr.payroll(admin, '2026-11'), w.cashier.id).baseSalary, 1_800_000);
    const history: any[] = await w.hr.salaryHistory(w.cashier.id, admin);
    assert.deepEqual(history.map((h) => [h.fromMonth, h.baseSalaryMnt]), [['2026-11', 1_800_000], ['2026-09', 1_500_000]]);
    // A salary set before history was kept still applies to every month.
    assert.equal(row(await w.hr.payroll(admin, '2026-10'), w.picker2.id).baseSalary, 2_000_000);
  });

  it('nobody raises their own salary; only the admin sets the general manager’s', async () => {
    const w = await world();
    const gm: any = await w.db.user.create({ data: { username: 'gm', fullName: 'Ерөнхий', role: 'SUPER_MANAGER', isActive: true, baseSalaryMnt: null } });
    const asGm: any = { id: gm.id, role: Role.SUPER_MANAGER, name: 'GM' };
    await assert.rejects(() => w.hr.setBaseSalary(gm.id, 9_000_000, asGm), ForbiddenException);
    const other: any = await w.db.user.create({ data: { username: 'gm2', fullName: 'Ерөнхий 2', role: 'SUPER_MANAGER', isActive: true, baseSalaryMnt: null } });
    await assert.rejects(() => w.hr.setBaseSalary(other.id, 9_000_000, asGm), ForbiddenException);
    await w.hr.setBaseSalary(w.cashier.id, 1_700_000, asGm);
    await w.hr.setBaseSalary(gm.id, 3_000_000, admin);
  });

  it('a check-in left open on an earlier day is closed at the end of the shift; times can be corrected with a reason', async () => {
    const w = await world();
    const yesterday = new Date(Date.now() - 86_400_000);
    const open = await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: yesterday, status: 'ON_TIME' } });
    await w.hr.checkIn(admin, { userId: w.cashier.id } as any);
    const closed: any = w.db.attendance.rows.find((r: any) => r.id === open.id);
    assert.ok(closed.checkOut, 'yesterday is closed');
    assert.match(closed.notes, /Гарсан цаг бүртгээгүй/);
    await assert.rejects(() => w.hr.checkIn(admin, { userId: w.cashier.id } as any), BadRequestException, 'today is still one check-in');
    const fixed: any = await w.hr.fixAttendance(open.id, { checkOut: new Date(yesterday.getTime() + 3 * 3_600_000).toISOString(), reason: 'Эрт явсан' } as any, admin);
    assert.equal(fixed.checkOut.getTime(), yesterday.getTime() + 3 * 3_600_000);
    assert.equal(w.db.editAudit.rows.filter((r: any) => r.entityType === 'ATTENDANCE').length, 1);
    await assert.rejects(() => w.hr.fixAttendance(open.id, { checkOut: new Date(yesterday.getTime() - 60_000).toISOString(), reason: 'буруу' } as any, admin), BadRequestException);
    await assert.rejects(() => w.hr.fixAttendance(open.id, { checkOut: null, reason: 'дахин нээх' } as any, admin), BadRequestException, 'an earlier day is not re-opened');
  });

  it('the month counts a late arrival once per day, from the first check-in; a partial settings change keeps the rest', async () => {
    const w = await world();
    await w.hr.saveAttendanceSettings({ shiftStart: '09:00', graceMinutes: 15, shiftEnd: '18:00', overtimeAfterHours: 8.5 } as any, admin);
    const at = (d: string, hm: string) => new Date(`${d}T${hm}:00.000+08:00`);
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(Date.now() - 2 * 86_400_000));
    const d = month; // two days ago
    // on time, lunch break, back in the afternoon; another day late and staying until 18:30
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: at(d, '09:05'), checkOut: at(d, '13:00'), status: 'ON_TIME' } });
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: at(d, '14:00'), checkOut: at(d, '17:30'), status: 'LATE' } });
    const d2 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(Date.now() - 86_400_000));
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: at(d2, '09:40'), checkOut: at(d2, '18:30'), status: 'OVERTIME' } });
    const months = [...new Set([d.slice(0, 7), d2.slice(0, 7)])];
    let late = 0;
    let over = 0;
    let present = 0;
    for (const m of months) {
      const p = (await w.hr.attendanceMonth(admin, m)).people.find((x: any) => x.id === w.cashier.id)!;
      late += p.lateDays;
      over += p.overtimeDays;
      present += p.presentDays;
    }
    assert.equal(present, 2);
    assert.equal(late, 1, 'only the 09:40 day is late');
    assert.equal(over, 1, 'only the day ending 18:30 is overtime');
    const s: any = await w.hr.saveAttendanceSettings({ graceMinutes: 10 } as any, admin);
    assert.deepEqual([s.shiftStart, s.graceMinutes, s.shiftEnd, s.overtimeAfterHours], ['09:00', 10, '18:00', 8.5]);
  });
});
