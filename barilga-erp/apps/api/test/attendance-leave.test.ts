/* eslint-disable @typescript-eslint/no-explicit-any */
// Attendance beyond the manager's board: self check-in with confirmation, leave requests, day statuses,
// records added or removed by hand, holidays — and that none of it changes pay by itself.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { countWorkingDays, HrService } from '../src/hr/hr.service';
import { FakeDb } from './helpers/fake-db';

const admin: any = { id: 'u-admin', role: Role.ADMIN, name: 'Admin', fullName: 'Admin' };
const ub = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const plusDays = (n: number) => ub(new Date(Date.now() + n * 86_400_000));

async function world(selfCheckIn: 'OFF' | 'CONFIRM' | 'AUTO' = 'CONFIRM') {
  const db = new FakeDb();
  const hr = new HrService(db as any);
  await hr.saveAttendanceSettings({ selfCheckIn } as any, admin);
  const cashier = await db.user.create({ data: { username: 'k', fullName: 'Кассчин', role: 'BORLUULAGCH', isActive: true, warehouseId: 'wh-main' } });
  const branch = await db.user.create({ data: { username: 'b', fullName: 'Салбарын менежер', role: 'MANAGER', isActive: true, warehouseId: 'wh-main' } });
  const me = (u: any): any => ({ id: u.id, role: u.role, name: u.fullName, warehouseId: u.warehouseId, warehouseIds: [u.warehouseId] });
  return { db, hr, cashier, branch, me };
}

describe('self check-in', () => {
  it('a self check-in waits for a manager and counts only once confirmed', async () => {
    const w = await world('CONFIRM');
    const row: any = await w.hr.selfCheckIn(w.me(w.cashier));
    assert.equal(row.source, 'SELF');
    assert.equal(row.confirmedAt, null);
    const period = ub().slice(0, 7);
    let p = (await w.hr.attendanceMonth(admin, period)).people.find((x: any) => x.id === w.cashier.id)!;
    assert.equal(p.presentDays, 0, 'not counted before confirmation');
    assert.equal(p.waiting, 1);
    await assert.rejects(() => w.hr.confirmPunches(w.me(w.cashier), [row.id]), ForbiddenException, 'nobody confirms their own');
    await w.hr.confirmPunches(admin, [row.id]);
    p = (await w.hr.attendanceMonth(admin, period)).people.find((x: any) => x.id === w.cashier.id)!;
    assert.equal(p.presentDays, 1);
    const mine: any = await w.hr.myAttendance(w.me(w.cashier), period);
    assert.equal(mine.presentDays, 1);
    await w.hr.selfCheckOut(w.me(w.cashier));
  });

  it('switched off: only managers record', async () => {
    const w = await world('OFF');
    await assert.rejects(() => w.hr.selfCheckIn(w.me(w.cashier)), ForbiddenException);
  });

  it('AUTO: counted at once', async () => {
    const w = await world('AUTO');
    const row: any = await w.hr.selfCheckIn(w.me(w.cashier));
    assert.ok(row.confirmedAt);
  });
});

describe('leave requests and day statuses', () => {
  it('approving writes the status on working days only; a future approved leave can be taken back', async () => {
    const w = await world();
    await w.hr.savePayrollSettings({ workDaysPerWeek: 5 } as any, admin);
    // a full week from next Monday
    let monday = 1;
    while (new Date(`${plusDays(monday)}T00:00:00Z`).getUTCDay() !== 1) monday++;
    const from = plusDays(monday);
    const to = plusDays(monday + 6);
    const req: any = await w.hr.requestLeave(w.me(w.cashier), { kind: 'PAID_LEAVE', fromDate: from, toDate: to, reason: 'Гэр бүлийн асуудал' } as any);
    await assert.rejects(
      () => w.hr.requestLeave(w.me(w.cashier), { kind: 'SICK', fromDate: from, toDate: from, reason: 'давхар' } as any),
      BadRequestException,
      'overlapping request refused',
    );
    await assert.rejects(() => w.hr.decideLeave(w.me(w.cashier), req.id, true, {} as any), ForbiddenException);
    const listed: any[] = await w.hr.listLeave(admin);
    assert.equal(listed.length, 1);
    await w.hr.decideLeave(admin, req.id, true, {} as any);
    const marks = w.db.attendanceDay.rows.filter((r: any) => r.requestId === req.id);
    assert.equal(marks.length, 5, 'Mon–Fri only');
    await w.hr.cancelLeave(w.me(w.cashier), req.id);
    assert.equal(w.db.attendanceDay.rows.filter((r: any) => r.requestId === req.id).length, 0);
  });

  it('a rejection needs a reason', async () => {
    const w = await world();
    const req: any = await w.hr.requestLeave(w.me(w.cashier), { kind: 'UNPAID_LEAVE', fromDate: plusDays(3), toDate: plusDays(3), reason: 'Хувийн ажил' } as any);
    await assert.rejects(() => w.hr.decideLeave(admin, req.id, false, {} as any), BadRequestException);
    await w.hr.decideLeave(admin, req.id, false, { note: 'Ажил ихтэй өдөр' } as any);
  });

  it('a manager marks a day absent; the month and payroll show it, pay is unchanged', async () => {
    const w = await world();
    const yesterday = plusDays(-1);
    const period = yesterday.slice(0, 7);
    const before = (await w.hr.payroll(admin, period)).rows.find((r: any) => r.user.id === w.cashier.id)!;
    await w.hr.setDayMark(admin, { userId: w.cashier.id, date: yesterday, mark: 'ABSENT', note: 'Мэдэгдэлгүй' } as any);
    const p = (await w.hr.attendanceMonth(admin, period)).people.find((x: any) => x.id === w.cashier.id)!;
    assert.equal(p.markCounts.ABSENT, 1);
    const after: any = (await w.hr.payroll(admin, period)).rows.find((r: any) => r.user.id === w.cashier.id)!;
    assert.equal(after.attendanceMarks.ABSENT, 1);
    assert.equal(after.netSalary, before.netSalary, 'no automatic deduction');
    await w.hr.clearDayMark(admin, w.cashier.id, yesterday);
    assert.equal(w.db.editAudit.rows.filter((r: any) => r.entityType === 'ATTENDANCE').length, 2);
  });

  it('someone given the attendance right does not mark their own manager', async () => {
    const w = await world();
    const granted = { ...w.me(w.cashier), permissions: { grant: ['ATTENDANCE_MANAGE'] } };
    await assert.rejects(() => w.hr.setDayMark(granted, { userId: w.branch.id, date: plusDays(-1), mark: 'SICK' } as any), ForbiddenException);
  });
});

describe('records by hand and holidays', () => {
  it('a missing day is added with a reason, overlap refused, and a wrong record removed', async () => {
    const w = await world();
    const d = plusDays(-2);
    const checkIn = new Date(`${d}T09:00:00+08:00`).toISOString();
    const checkOut = new Date(`${d}T18:00:00+08:00`).toISOString();
    const row: any = await w.hr.addRecord(admin, { userId: w.cashier.id, checkIn, checkOut, reason: 'Ирсэн, дараагүй' } as any);
    assert.equal(row.source, 'FIX');
    await assert.rejects(() => w.hr.addRecord(admin, { userId: w.cashier.id, checkIn, checkOut, reason: 'давхар' } as any), BadRequestException);
    await w.hr.deleteRecord(admin, row.id, 'Буруу хүн');
    assert.equal(w.db.attendance.rows.length, 0);
  });

  it('public holidays are not working days', () => {
    assert.equal(countWorkingDays('2026-07', 6) - countWorkingDays('2026-07', 6, ['2026-07-11', '2026-07-12', '2026-07-13']), 2, 'Sunday the 12th was not a working day anyway');
  });
});

describe('second review round', () => {
  it('a shift that ran past midnight is checked out normally; one forgotten for over 16 hours is not', async () => {
    const w = await world('AUTO');
    // Came half an hour before the last midnight (UB): checking out now is fine while within 16 hours.
    const midnight = new Date(`${ub()}T00:00:00+08:00`);
    const checkIn = new Date(midnight.getTime() - 30 * 60_000);
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn, status: 'LATE', source: 'SELF', confirmedAt: checkIn } });
    const within = Date.now() - checkIn.getTime() <= 16 * 3_600_000;
    if (within) {
      const out: any = await w.hr.selfCheckOut(w.me(w.cashier));
      assert.ok(out.checkOut, 'closed now');
    } else {
      await assert.rejects(() => w.hr.selfCheckOut(w.me(w.cashier)), BadRequestException);
    }
    const w2 = await world('AUTO');
    const old = new Date(Date.now() - 30 * 3_600_000);
    await w2.db.attendance.create({ data: { userId: w2.cashier.id, checkIn: old, status: 'ON_TIME', source: 'SELF', confirmedAt: old } });
    await assert.rejects(() => w2.hr.selfCheckOut(w2.me(w2.cashier)), BadRequestException, 'a day and more is not closed «now»');
  });

  it('the board does not record one’s own attendance', async () => {
    const w = await world();
    await assert.rejects(() => w.hr.checkIn(w.me(w.branch), { userId: w.branch.id } as any), ForbiddenException);
    const row: any = await w.hr.checkIn(w.me(w.branch), { userId: w.cashier.id } as any);
    assert.equal(row.source, 'MANAGER');
    await assert.rejects(() => w.hr.checkOut(w.me(w.branch), { userId: w.branch.id } as any), ForbiddenException);
  });

  it('an approved leave is shortened only to a real day inside it, and two cuts at once leave no gap', async () => {
    const w = await world();
    const leave = await w.db.leaveRequest.create({
      data: { userId: w.cashier.id, kind: 'ANNUAL_LEAVE', fromDate: '2030-01-28', toDate: '2030-02-03', reason: 'амралт', status: 'APPROVED' },
    });
    for (const date of ['2030-01-28', '2030-01-29', '2030-01-30', '2030-01-31', '2030-02-01']) {
      await w.db.attendanceDay.create({ data: { userId: w.cashier.id, date, mark: 'ANNUAL_LEAVE', requestId: leave.id } });
    }
    await assert.rejects(() => w.hr.cancelApprovedLeave(admin, leave.id, { toDate: '2030-01-32', note: 'эрт ирсэн' }), BadRequestException);
    const both = await Promise.allSettled([
      w.hr.cancelApprovedLeave(admin, leave.id, { toDate: '2030-01-29', note: 'эрт ирсэн' }),
      w.hr.cancelApprovedLeave(admin, leave.id, { toDate: '2030-01-31', note: 'эрт ирсэн' }),
    ]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, 'only one cut goes through');
    const end = w.db.leaveRequest.rows[0].toDate;
    const marked = w.db.attendanceDay.rows.filter((r: any) => r.requestId === leave.id).map((r: any) => r.date);
    assert.ok(marked.every((d: string) => d <= end), 'no status after the new end');
    assert.ok(marked.includes(end), 'and the days up to it keep theirs');
  });

  it('punches in a paid month are not offered for confirmation', async () => {
    const w = await world('CONFIRM');
    const row: any = await w.hr.selfCheckIn(w.me(w.cashier));
    assert.ok((await w.hr.board(admin)).waiting.some((x: any) => x.id === row.id));
    await w.db.payroll.create({ data: { userId: w.cashier.id, periodMonth: ub().slice(0, 7), status: 'PAID', baseSalaryMnt: 0, netMnt: 0 } });
    assert.ok(!(await w.hr.board(admin)).waiting.some((x: any) => x.id === row.id));
  });
});

describe('third review round', () => {
  it('an evening check-in nobody closed does not block the next morning; a shift past midnight closes normally', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T08:40:00Z') }); // Monday 16:40 in UB
    const w = await world('AUTO');
    const first: any = await w.hr.selfCheckIn(w.me(w.cashier));
    t.mock.timers.setTime(Date.parse('2026-11-03T00:30:00Z')); // Tuesday 08:30, under 16 hours later
    const second: any = await w.hr.selfCheckIn(w.me(w.cashier));
    const closed = w.db.attendance.rows.find((r: any) => r.id === first.id);
    assert.equal(new Date(closed.checkOut).toISOString(), '2026-11-02T10:00:00.000Z', 'Monday closed at the 18:00 shift end');
    assert.ok(second.id !== first.id);

    t.mock.timers.setTime(Date.parse('2026-11-04T15:30:00Z')); // Wednesday 23:30
    const w2 = await world('AUTO');
    await w2.hr.selfCheckIn(w2.me(w2.cashier));
    t.mock.timers.setTime(Date.parse('2026-11-04T16:40:00Z')); // Thursday 00:40
    const out: any = await w2.hr.selfCheckOut(w2.me(w2.cashier));
    assert.equal(new Date(out.checkOut).getTime() - new Date(out.checkIn).getTime(), 70 * 60_000, 'a 70-minute shift past midnight');
    const month: any = await w2.hr.attendanceMonth(admin, '2026-11');
    assert.equal(month.people.find((p: any) => p.id === w2.cashier.id).unclosed.length, 0);
  });

  it('a month marked paid takes no check-in either; reopening it with a reason lets attendance in again', async () => {
    const w = await world('AUTO');
    const pay = await w.db.payroll.create({ data: { userId: w.cashier.id, periodMonth: ub().slice(0, 7), status: 'PAID', baseSalaryMnt: 0, netSalary: 0 } });
    await assert.rejects(() => w.hr.selfCheckIn(w.me(w.cashier)), /Буцааж нээх/);
    await assert.rejects(() => w.hr.reopenPaid(pay.id, 'x', admin), BadRequestException);
    await assert.rejects(() => w.hr.reopenPaid(pay.id, 'Андуурсан', w.me(w.branch)), ForbiddenException);
    const reopened: any = await w.hr.reopenPaid(pay.id, 'Андуурч олгосон гэж тэмдэглэсэн', admin);
    assert.equal(reopened.status, 'DRAFT');
    const row: any = await w.hr.selfCheckIn(w.me(w.cashier));
    assert.ok(row.id);
  });

  it('a check-in forgotten days ago does not block adding a later day by hand', async () => {
    const w = await world();
    const old = new Date(Date.now() - 4 * 86_400_000);
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: old, status: 'ON_TIME', source: 'MANAGER', confirmedAt: old } });
    const d = plusDays(-2);
    const row: any = await w.hr.addRecord(admin, {
      userId: w.cashier.id,
      checkIn: new Date(`${d}T09:00:00+08:00`).toISOString(),
      checkOut: new Date(`${d}T18:00:00+08:00`).toISOString(),
      reason: 'Ирсэн, дараагүй',
    } as any);
    assert.equal(row.source, 'FIX');
  });
});

describe('fourth review round', () => {
  it('marking paid is in the history; the general manager does not reopen his own pay', async () => {
    const w = await world();
    const gm = await w.db.user.create({ data: { username: 'g', fullName: 'Ерөнхий', role: 'SUPER_MANAGER', isActive: true, warehouseId: 'wh-main' } });
    const own = await w.db.payroll.create({ data: { userId: gm.id, periodMonth: '2026-09', status: 'PAID', baseSalaryMnt: 0, netSalary: 0 } });
    await assert.rejects(() => w.hr.reopenPaid(own.id, 'Андуурсан', w.me(gm)), ForbiddenException);
    const theirs = await w.db.payroll.create({ data: { userId: w.cashier.id, periodMonth: '2026-09', status: 'PAID', baseSalaryMnt: 0, netSalary: 0, paidById: 'u-admin' } });
    await w.hr.reopenPaid(theirs.id, 'Андуурсан', w.me(gm));
    const audit = w.db.editAudit.rows.find((a: any) => /буцааж нээв/.test(a.summary));
    assert.equal(audit.before.paidById, 'u-admin', 'who had marked it paid is kept');
  });

  it('one open check-in at a time; a correction cannot lie over another record', async () => {
    const w = await world();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: old, status: 'ON_TIME', source: 'MANAGER', confirmedAt: old } });
    await assert.rejects(
      () => w.hr.addRecord(admin, { userId: w.cashier.id, checkIn: new Date(Date.now() - 3_600_000).toISOString(), reason: 'Ирсэн, дараагүй' } as any),
      /нээлттэй бүртгэлтэй/,
    );
    const d = plusDays(-1);
    const a: any = await w.hr.addRecord(admin, { userId: w.cashier.id, checkIn: new Date(`${d}T09:00:00+08:00`).toISOString(), checkOut: new Date(`${d}T13:00:00+08:00`).toISOString(), reason: 'өглөө' } as any);
    const b: any = await w.hr.addRecord(admin, { userId: w.cashier.id, checkIn: new Date(`${d}T14:00:00+08:00`).toISOString(), checkOut: new Date(`${d}T18:00:00+08:00`).toISOString(), reason: 'үдээс хойш' } as any);
    await assert.rejects(() => w.hr.fixAttendance(b.id, { checkIn: new Date(`${d}T10:00:00+08:00`).toISOString() } as any, admin), /давхц|өөр бүртгэл/);
    assert.ok(a.id);
  });

  it('a leave in a paid month cannot be taken back; a forgotten check-in in a paid month is left as it is', async () => {
    const w = await world('AUTO');
    const leave = await w.db.leaveRequest.create({ data: { userId: w.cashier.id, kind: 'ANNUAL_LEAVE', fromDate: '2099-01-10', toDate: '2099-01-11', reason: 'амралт', status: 'APPROVED' } });
    await w.db.attendanceDay.create({ data: { userId: w.cashier.id, date: '2099-01-10', mark: 'ANNUAL_LEAVE', requestId: leave.id } });
    await w.db.payroll.create({ data: { userId: w.cashier.id, periodMonth: '2099-01', status: 'PAID', baseSalaryMnt: 0, netSalary: 0 } });
    await assert.rejects(() => w.hr.cancelLeave(w.me(w.cashier), leave.id), /олгосон/);

    const before = new Date(Date.now() - 40 * 86_400_000);
    const forgotten = await w.db.attendance.create({ data: { userId: w.cashier.id, checkIn: before, status: 'ON_TIME', source: 'MANAGER', confirmedAt: before } });
    await w.db.payroll.create({ data: { userId: w.cashier.id, periodMonth: ub(before).slice(0, 7), status: 'PAID', baseSalaryMnt: 0, netSalary: 0 } });
    await w.hr.selfCheckIn(w.me(w.cashier));
    assert.equal(w.db.attendance.rows.find((r: any) => r.id === forgotten.id).checkOut, null, 'the paid month is not touched');
  });
});
