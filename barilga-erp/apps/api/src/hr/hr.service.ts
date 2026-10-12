import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, OrderStatus, PaymentStatus, PayMethod, PayrollStatus, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollAdjustmentDto, PayrollSettingsDto, StaffPunchDto } from './dto/hr.dto';

const UB_TZ = 'Asia/Ulaanbaatar';
const SHIFT_START_MINUTES = 9 * 60;
const LATE_AFTER_MINUTES = 9 * 60 + 15;
const SHIFT_END_MINUTES = 18 * 60;
const OVERTIME_MINUTES = 8 * 60 + 30;

const PAYROLL_KEY = 'PAYROLL';

export type PayrollSettings = {
  /** Base salary for each role when an employee has none of their own. */
  defaultBaseMnt: Record<Role, number>;
  /** Paid per order a person prepared and handed over. */
  ticketBonusMnt: number;
  /** Cashier commission, percent of money received on their sales. */
  salesCommissionPct: number;
  /** Pay the base only for the days actually checked in. */
  prorateByAttendance: boolean;
  /** 5 = Mon–Fri, 6 = Mon–Sat, 7 = every day. */
  workDaysPerWeek: number;
  /** Employee social insurance (НДШ), percent of gross. 0 until the accountant confirms the rate. */
  socialInsurancePct: number;
  /** Personal income tax (ХХОАТ), percent of gross minus insurance. 0 until confirmed. */
  incomeTaxPct: number;
};

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  defaultBaseMnt: { ADMIN: 3_500_000, MANAGER: 2_800_000, BORLUULAGCH: 1_800_000, ACHIGCH_BELTGEGCH: 1_600_000 },
  ticketBonusMnt: 15_000,
  salesCommissionPct: 0.5,
  prorateByAttendance: false,
  workDaysPerWeek: 6,
  socialInsurancePct: 0,
  incomeTaxPct: 0,
};

/** Days in the month that are working days (Mon–Fri, Mon–Sat or all). */
export function countWorkingDays(periodMonth: string, perWeek: number) {
  const [y, m] = periodMonth.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun … 6 Sat
    if (perWeek >= 7 || (dow >= 1 && dow <= perWeek)) n++;
  }
  return n;
}

function ymdInUlaanbaatar(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date);
}

function periodMonthNow() {
  return ymdInUlaanbaatar().slice(0, 7);
}

function minutesInUlaanbaatar(date: Date): number {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: UB_TZ, hour: 'numeric', hourCycle: 'h23' }).format(date),
  );
  const minute = Number(new Intl.DateTimeFormat('en-US', { timeZone: UB_TZ, minute: 'numeric' }).format(date));
  return hour * 60 + minute;
}

function monthBounds(periodMonth: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
    throw new BadRequestException('periodMonth must be YYYY-MM');
  }
  const [year, month] = periodMonth.split('-').map(Number);
  const start = new Date(`${periodMonth}-01T00:00:00.000+08:00`);
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = new Date(`${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00.000+08:00`);
  return { start, end };
}

@Injectable()
export class HrService {
  private readonly log = new Logger(HrService.name);

  constructor(private readonly prisma: PrismaService) {}

  assertManager(user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only managers or admin can manage attendance');
    }
  }

  async board(actor: AuthUser) {
    this.assertManager(actor);
    const staff = await this.prisma.user.findMany({
      where: { isActive: true, username: { not: WEBSHOP_USERNAME } },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, username: true, role: true },
    });
    const openRows = await this.prisma.attendance.findMany({
      where: { checkOut: null, userId: { in: staff.map((s) => s.id) } },
      orderBy: { checkIn: 'desc' },
    });
    const openByUser = new Map(openRows.map((row) => [row.userId, row]));
    const today = ymdInUlaanbaatar();
    const start = new Date(`${today}T00:00:00.000+08:00`);
    const end = new Date(`${today}T23:59:59.999+08:00`);
    const recent = await this.prisma.attendance.findMany({
      where: { checkIn: { gte: start, lte: end } },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
      orderBy: { checkIn: 'desc' },
      take: 80,
    });
    return {
      timeZone: UB_TZ,
      date: today,
      staff: staff.map((member) => ({
        ...member,
        open: openByUser.get(member.id) ?? null,
      })),
      recent,
    };
  }

  async checkIn(actor: AuthUser, dto: StaffPunchDto) {
    this.assertManager(actor);
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!staff || !staff.isActive) throw new NotFoundException('Staff member not found');
    const checkIn = new Date();
    const minutes = minutesInUlaanbaatar(checkIn);
    const status =
      minutes > LATE_AFTER_MINUTES && minutes < SHIFT_END_MINUTES
        ? AttendanceStatus.LATE
        : AttendanceStatus.ON_TIME;
    const alreadyIn = () => new BadRequestException(`${staff.fullName} is already checked in`);
    // Check and insert in one SERIALIZABLE transaction: a double click sends two requests that would both
    // see "no open check-in" and both insert. Postgres aborts one of them (P2034), reported as already in.
    let row;
    try {
      row = await this.prisma.$transaction(
        async (tx) => {
          const open = await tx.attendance.findFirst({ where: { userId: staff.id, checkOut: null } });
          if (open) throw alreadyIn();
          return tx.attendance.create({
            data: {
              userId: staff.id,
              checkIn,
              status,
              notes: dto.notes?.trim() || `Recorded by ${actor.fullName ?? actor.name}`,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2034') throw alreadyIn();
      throw err;
    }
    this.log.log(
      `Check-in ${staff.fullName} (${staff.id}) status=${status} by ${actor.fullName ?? actor.name} (${actor.id}) at ${checkIn.toISOString()}`,
    );
    return row;
  }

  async checkOut(actor: AuthUser, dto: StaffPunchDto) {
    this.assertManager(actor);
    const open = await this.prisma.attendance.findFirst({
      where: { userId: dto.userId, checkOut: null },
      orderBy: { checkIn: 'desc' },
      include: { user: true },
    });
    if (!open) {
      throw new BadRequestException('No open check-in to close');
    }
    const checkOut = new Date();
    const workedMin = Math.round((checkOut.getTime() - open.checkIn.getTime()) / 60_000);
    const outMinutes = minutesInUlaanbaatar(checkOut);
    let status = open.status;
    if (outMinutes > SHIFT_END_MINUTES || workedMin > OVERTIME_MINUTES) {
      status = AttendanceStatus.OVERTIME;
    }
    const row = await this.prisma.attendance.update({
      where: { id: open.id },
      data: { checkOut, status },
    });
    this.log.log(
      `Check-out ${open.user.fullName} (${open.userId}) status=${status} workedMin=${workedMin} by ${actor.fullName ?? actor.name} (${actor.id})`,
    );
    return row;
  }

  /** Payroll rates set by admin. Tax and social-insurance rates start at 0: confirm them with the accountant. */
  async payrollSettings(): Promise<PayrollSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: PAYROLL_KEY } });
    const saved = (row?.value ?? {}) as Partial<PayrollSettings>;
    return {
      ...DEFAULT_PAYROLL_SETTINGS,
      ...saved,
      defaultBaseMnt: { ...DEFAULT_PAYROLL_SETTINGS.defaultBaseMnt, ...(saved.defaultBaseMnt ?? {}) },
    };
  }

  async savePayrollSettings(dto: PayrollSettingsDto, user: AuthUser) {
    if (user.role !== Role.ADMIN) throw new ForbiddenException('Only admin can change payroll rates');
    const current = await this.payrollSettings();
    const next: PayrollSettings = {
      defaultBaseMnt: { ...current.defaultBaseMnt, ...(dto.defaultBaseMnt ?? {}) },
      ticketBonusMnt: dto.ticketBonusMnt ?? current.ticketBonusMnt,
      salesCommissionPct: dto.salesCommissionPct ?? current.salesCommissionPct,
      prorateByAttendance: dto.prorateByAttendance ?? current.prorateByAttendance,
      workDaysPerWeek: dto.workDaysPerWeek ?? current.workDaysPerWeek,
      socialInsurancePct: dto.socialInsurancePct ?? current.socialInsurancePct,
      incomeTaxPct: dto.incomeTaxPct ?? current.incomeTaxPct,
    };
    await this.prisma.appSetting.upsert({
      where: { key: PAYROLL_KEY },
      create: { key: PAYROLL_KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: user.id },
      update: { value: next as unknown as Prisma.InputJsonValue, updatedById: user.id },
    });
    this.log.log(`Payroll settings changed by ${user.id}`);
    return next;
  }

  /** Admin sets one employee's monthly base salary; null goes back to the default for their role. */
  async setBaseSalary(userId: string, baseSalaryMnt: number | null, user: AuthUser) {
    if (user.role !== Role.ADMIN) throw new ForbiddenException('Only admin can set salaries');
    const staff = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.prisma.user.update({ where: { id: userId }, data: { baseSalaryMnt } });
    this.log.log(`Base salary of ${staff.fullName} set to ${baseSalaryMnt ?? 'role default'} by ${user.id}`);
    return { userId, baseSalaryMnt };
  }

  /** A one-off bonus (+) or deduction (−) for an unpaid month. */
  async addAdjustment(dto: PayrollAdjustmentDto, user: AuthUser) {
    this.assertManager(user);
    monthBounds(dto.periodMonth);
    if (!dto.amountMnt) throw new BadRequestException('Дүн 0 байж болохгүй / Amount cannot be 0');
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.assertMonthOpen(dto.userId, dto.periodMonth);
    return this.prisma.payrollAdjustment.create({
      data: { userId: dto.userId, periodMonth: dto.periodMonth, amountMnt: dto.amountMnt, reason: dto.reason.trim(), createdById: user.id },
    });
  }

  async removeAdjustment(id: string, user: AuthUser) {
    this.assertManager(user);
    const row = await this.prisma.payrollAdjustment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Adjustment not found');
    await this.assertMonthOpen(row.userId, row.periodMonth);
    await this.prisma.payrollAdjustment.delete({ where: { id } });
    return { removed: id };
  }

  private async assertMonthOpen(userId: string, periodMonth: string) {
    const row = await this.prisma.payroll.findUnique({ where: { userId_periodMonth: { userId, periodMonth } } });
    if (row?.status === PayrollStatus.PAID) throw new BadRequestException('Энэ сарын цалин олгогдсон / Payroll already paid');
  }

  /**
   * One month's payroll for every active employee. Unpaid (DRAFT) rows are recalculated from the month's
   * data each time; a PAID row keeps exactly what was paid.
   *
   *   earned base  = base salary (× worked days / working days when pro-rating by attendance is on)
   *   + prep bonus = orders this person prepared and handed over × per-order bonus
   *   + commission = cashiers only: money received on their sales (no offsets) − their refunds, × rate
   *   + bonuses / − deductions entered for the month
   *   = gross;  − social insurance (gross × rate);  − income tax ((gross − insurance) × rate)  = net
   */
  async payroll(user: AuthUser, periodMonth?: string) {
    this.assertManager(user);
    const period = periodMonth || periodMonthNow();
    const { start, end } = monthBounds(period);
    const settings = await this.payrollSettings();
    const staff = await this.prisma.user.findMany({
      where: { isActive: true, username: { not: WEBSHOP_USERNAME } },
      orderBy: { fullName: 'asc' },
    });
    const ids = staff.map((m) => m.id);

    const [tickets, sales, refunds, attendance, adjustments] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['preparedById'],
        where: { status: OrderStatus.COMPLETED, preparedById: { not: null }, preparedAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
      // Same money as the sales report: real payments only (a contract offset or an on-account part is not
      // money received), booked in the month it was paid.
      this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.PAID,
          method: { notIn: [PayMethod.OFFSET, PayMethod.CREDIT] },
          paidAt: { gte: start, lt: end },
          order: { status: { not: OrderStatus.CANCELLED } },
        },
        select: { amountMnt: true, order: { select: { createdById: true } } },
      }),
      this.prisma.salesReturn.findMany({
        where: { createdAt: { gte: start, lt: end }, refundMethod: { notIn: [PayMethod.CREDIT, PayMethod.OFFSET] } },
        select: { refundAmount: true, order: { select: { createdById: true } } },
      }),
      this.prisma.attendance.findMany({ where: { userId: { in: ids }, checkIn: { gte: start, lt: end } }, select: { userId: true, checkIn: true } }),
      this.prisma.payrollAdjustment.findMany({
        where: { userId: { in: ids }, periodMonth: period },
        include: { createdBy: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const ticketMap = new Map(tickets.map((t) => [t.preparedById!, t._count._all]));
    const salesBy = new Map<string, number>();
    for (const p of sales) salesBy.set(p.order.createdById, (salesBy.get(p.order.createdById) ?? 0) + p.amountMnt);
    for (const r of refunds) salesBy.set(r.order.createdById, (salesBy.get(r.order.createdById) ?? 0) - r.refundAmount);
    const daysBy = new Map<string, Set<string>>();
    for (const a of attendance) {
      const set = daysBy.get(a.userId) ?? new Set<string>();
      set.add(ymdInUlaanbaatar(a.checkIn));
      daysBy.set(a.userId, set);
    }
    const workingDays = countWorkingDays(period, settings.workDaysPerWeek);

    const rows = [];
    for (const member of staff) {
      const base = member.baseSalaryMnt ?? settings.defaultBaseMnt[member.role] ?? 0;
      const workedDays = daysBy.get(member.id)?.size ?? 0;
      const earnedBase =
        settings.prorateByAttendance && workingDays > 0 ? Math.round((base * Math.min(workedDays, workingDays)) / workingDays) : base;
      const ticketCount = ticketMap.get(member.id) ?? 0;
      const ticketBonus = ticketCount * settings.ticketBonusMnt;
      const salesAmountMnt = Math.max(0, salesBy.get(member.id) ?? 0);
      const salesBonus = member.role === Role.BORLUULAGCH ? Math.round((salesAmountMnt * settings.salesCommissionPct) / 100) : 0;
      const mine = adjustments.filter((a) => a.userId === member.id);
      const adjustmentsMnt = mine.reduce((s, a) => s + a.amountMnt, 0);
      const grossSalary = earnedBase + ticketBonus + salesBonus + adjustmentsMnt;
      const socialInsuranceMnt = Math.max(0, Math.round((grossSalary * settings.socialInsurancePct) / 100));
      const incomeTaxMnt = Math.max(0, Math.round(((grossSalary - socialInsuranceMnt) * settings.incomeTaxPct) / 100));
      const calc = {
        baseSalary: base,
        fulfillmentBonus: ticketBonus + salesBonus,
        netSalary: grossSalary - socialInsuranceMnt - incomeTaxMnt,
        ticketCount,
        salesAmountMnt,
        ticketBonus,
        salesBonus,
        workedDays,
        workingDays,
        earnedBase,
        adjustmentsMnt,
        grossSalary,
        socialInsuranceMnt,
        incomeTaxMnt,
      };

      // Two people opening payroll at once must not crash on the unique (user, month) key, and a row marked
      // PAID meanwhile must keep the amount that was paid: create if missing, then refresh DRAFT rows only.
      await this.prisma.payroll.createMany({
        data: [{ userId: member.id, periodMonth: period, status: PayrollStatus.DRAFT, ...calc }],
        skipDuplicates: true,
      });
      await this.prisma.payroll.updateMany({
        where: { userId: member.id, periodMonth: period, status: PayrollStatus.DRAFT },
        data: calc,
      });
      const payroll = await this.prisma.payroll.findUniqueOrThrow({ where: { userId_periodMonth: { userId: member.id, periodMonth: period } } });
      rows.push({
        ...payroll,
        customBase: member.baseSalaryMnt !== null,
        adjustments: mine.map((a) => ({ id: a.id, amountMnt: a.amountMnt, reason: a.reason, createdAt: a.createdAt, by: a.createdBy?.fullName ?? '' })),
        user: { id: member.id, fullName: member.fullName, username: member.username, role: member.role },
      });
    }

    const totals = { gross: 0, net: 0, insurance: 0, tax: 0 };
    for (const r of rows) {
      totals.gross += r.grossSalary;
      totals.net += r.netSalary;
      totals.insurance += r.socialInsuranceMnt;
      totals.tax += r.incomeTaxMnt;
    }
    this.log.log(`Payroll calculated period=${period} staff=${rows.length} by ${user.fullName ?? user.name}`);
    return { periodMonth: period, timeZone: UB_TZ, settings, workingDays, totals, rows };
  }

  async markPaid(id: string, user: AuthUser) {
    if (user.role !== Role.ADMIN) {
      throw new ForbiddenException('Only admin can mark payroll as paid');
    }
    const row = await this.prisma.payroll.findUnique({ where: { id }, include: { user: true } });
    if (!row) throw new NotFoundException('Payroll row not found');
    if (row.status === PayrollStatus.PAID) return row;
    const updated = await this.prisma.payroll.update({
      where: { id },
      data: { status: PayrollStatus.PAID, paidAt: new Date(), paidById: user.id },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
    });
    this.log.log(`Payroll PAID ${row.periodMonth} ${row.user.fullName} amount=${row.netSalary} by ${user.id}`);
    return updated;
  }
}
