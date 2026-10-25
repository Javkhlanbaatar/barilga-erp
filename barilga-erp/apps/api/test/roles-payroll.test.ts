/* eslint-disable @typescript-eslint/no-explicit-any */
// General manager vs branch manager, and payroll entered by hand unless the formula module is on.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { roleAllowed } from '../src/auth/rbac';
import { HrService } from '../src/hr/hr.service';
import { FakeDb } from './helpers/fake-db';

const admin: any = { id: 'u-admin', role: Role.ADMIN, name: 'Admin' };
const general: any = { id: 'u-gm', role: Role.SUPER_MANAGER, name: 'Ерөнхий' };
const branch: any = { id: 'u-bm', role: Role.MANAGER, name: 'Салбар', warehouseId: 'wh-b', warehouseIds: ['wh-b'] };
const formulaOff: any = { isEnabled: async (k: string) => k !== 'PAYROLL_FORMULA' };

async function world(features: any = formulaOff) {
  const db = new FakeDb();
  await db.warehouse.create({ data: { id: 'wh-b', code: 'B', name: 'Салбар B', isActive: true, isDefault: false } });
  const hr = new HrService(db as any, features);
  const mk = (id: string, role: string, warehouseId: string | null, extra: any = {}) =>
    db.user.create({ data: { id, username: id, fullName: id, role, isActive: true, warehouseId, baseSalaryMnt: null, ...extra } });
  await mk('u-bm', 'MANAGER', 'wh-b', { baseSalaryMnt: 2_500_000 });
  await mk('k-main', 'BORLUULAGCH', 'wh-main', { baseSalaryMnt: 1_500_000 });
  await mk('k-b', 'BORLUULAGCH', 'wh-b', { baseSalaryMnt: 1_400_000 });
  await mk('u-gm', 'SUPER_MANAGER', null, { baseSalaryMnt: 4_000_000 });
  return { db, hr, mk };
}
const row = (r: any, id: string) => r.rows.find((x: any) => x.user.id === id);

describe('role ladder', () => {
  it('the general manager passes every MANAGER gate; a branch manager does not pass admin-only ones', () => {
    assert.ok(roleAllowed(Role.SUPER_MANAGER, [Role.ADMIN, Role.MANAGER]));
    assert.ok(!roleAllowed(Role.SUPER_MANAGER, [Role.ADMIN]));
    assert.ok(!roleAllowed(Role.MANAGER, [Role.ADMIN, Role.SUPER_MANAGER]));
  });
});

describe('payroll entered by hand (formula module off)', () => {
  it('pay = own base salary + bonuses − deductions; no role default, commission or tax', async () => {
    const w = await world();
    const o = await w.db.order.create({ data: { orderNumber: 'A', status: 'COMPLETED', totalMnt: 1_000_000, createdById: 'k-main' } });
    await w.db.payment.create({ data: { orderId: o.id, method: 'CASH', amountMnt: 1_000_000, status: 'PAID', paidAt: new Date('2026-10-05T04:00:00Z') } });
    await w.mk('k-new', 'BORLUULAGCH', 'wh-main');
    await w.hr.addAdjustment({ userId: 'k-main', periodMonth: '2026-10', amountMnt: 200_000, reason: 'Шагнал' }, general);
    await w.hr.addAdjustment({ userId: 'k-main', periodMonth: '2026-10', amountMnt: -50_000, reason: 'Урьдчилгаа' }, general);
    const r: any = await w.hr.payroll(general, '2026-10');
    assert.equal(r.formula, false);
    const k = row(r, 'k-main');
    assert.equal(k.salesBonus, 0);
    assert.equal(k.socialInsuranceMnt + k.incomeTaxMnt, 0);
    assert.equal(k.bonusMnt, 200_000);
    assert.equal(k.deductionMnt, 50_000);
    assert.equal(k.netSalary, 1_500_000 + 200_000 - 50_000);
    assert.equal(row(r, 'k-new').netSalary, 0, 'no salary entered yet = 0, not a role default');
  });

  it('“paid” freezes the current amount, including a bonus added after the page was opened', async () => {
    const w = await world();
    const first = row(await w.hr.payroll(general, '2026-10'), 'k-b');
    await w.hr.addAdjustment({ userId: 'k-b', periodMonth: '2026-10', amountMnt: 100_000, reason: 'Илүү цаг' }, branch);
    const paid: any = await w.hr.markPaid(first.id, general);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.netSalary, 1_500_000);
  });

  it('someone who left during the month still gets their row', async () => {
    const w = await world();
    await w.mk('k-left', 'BORLUULAGCH', 'wh-main', { isActive: false, baseSalaryMnt: 1_000_000 });
    await w.db.attendance.create({ data: { userId: 'k-left', checkIn: new Date('2026-10-03T01:00:00Z') } });
    assert.equal(row(await w.hr.payroll(general, '2026-10'), 'k-left').netSalary, 1_000_000);
    assert.equal(row(await w.hr.payroll(general, '2026-11'), 'k-left'), undefined);
  });
});

describe('a branch manager works inside their own warehouses', () => {
  it('sees and pays bonuses only to their own staff, never to themselves or the general manager', async () => {
    const w = await world();
    const r: any = await w.hr.payroll(branch, '2026-10');
    assert.deepEqual(r.rows.map((x: any) => x.user.id).sort(), ['k-b', 'u-bm']);
    await assert.rejects(
      () => w.hr.addAdjustment({ userId: 'k-main', periodMonth: '2026-10', amountMnt: 1, reason: 'Шагнал' }, branch),
      ForbiddenException,
    );
    await assert.rejects(
      () => w.hr.addAdjustment({ userId: 'u-bm', periodMonth: '2026-10', amountMnt: 5_000_000, reason: 'Өөртөө' }, branch),
      ForbiddenException,
    );
    await assert.rejects(() => w.hr.setBaseSalary('k-b', 9_000_000, branch), ForbiddenException);
    await assert.rejects(() => w.hr.markPaid(row(r, 'k-b').id, branch), ForbiddenException);
    assert.equal((await w.hr.payroll(admin, '2026-10')).rows.length, 4);
  });
});
