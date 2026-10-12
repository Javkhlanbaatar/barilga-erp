import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, OrderStatus, PaymentStatus, PayrollStatus, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { StaffPunchDto } from './dto/hr.dto';

const UB_TZ = 'Asia/Ulaanbaatar';
const SHIFT_START_MINUTES = 9 * 60;
const LATE_AFTER_MINUTES = 9 * 60 + 15;
const SHIFT_END_MINUTES = 18 * 60;
const OVERTIME_MINUTES = 8 * 60 + 30;

export const BASE_SALARY_MNT: Record<Role, number> = {
  ADMIN: 3_500_000,
  MANAGER: 2_800_000,
  BORLUULAGCH: 1_800_000,
  ACHIGCH_BELTGEGCH: 1_600_000,
};

const TICKET_BONUS_MNT = 15_000;
const SALES_COMMISSION_BPS = 50; // 0.50%

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

  async payroll(user: AuthUser, periodMonth?: string) {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only managers or admin can view payroll');
    }
    const period = periodMonth || periodMonthNow();
    const { start, end } = monthBounds(period);
    const staff = await this.prisma.user.findMany({
      where: { isActive: true, username: { not: WEBSHOP_USERNAME } },
      orderBy: { fullName: 'asc' },
    });

    const tickets = await this.prisma.order.groupBy({
      by: ['preparedById'],
      where: {
        status: OrderStatus.COMPLETED,
        preparedById: { not: null },
        preparedAt: { gte: start, lt: end },
      },
      _count: { _all: true },
    });
    const ticketMap = new Map(tickets.map((t) => [t.preparedById!, t._count._all]));

    const sales = await this.prisma.payment.groupBy({
      by: ['orderId'],
      where: {
        status: PaymentStatus.PAID,
        paidAt: { gte: start, lt: end },
        order: { status: { not: OrderStatus.CANCELLED } },
      },
      _sum: { amountMnt: true },
    });
    const orderIds = sales.map((s) => s.orderId);
    const orders =
      orderIds.length === 0
        ? []
        : await this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, createdById: true },
          });
    const amountByOrder = new Map(sales.map((s) => [s.orderId, s._sum.amountMnt ?? 0]));
    const salesByCashier = new Map<string, number>();
    for (const order of orders) {
      salesByCashier.set(order.createdById, (salesByCashier.get(order.createdById) ?? 0) + (amountByOrder.get(order.id) ?? 0));
    }

    const rows = [];
    for (const member of staff) {
      const ticketCount = ticketMap.get(member.id) ?? 0;
      const salesAmountMnt = salesByCashier.get(member.id) ?? 0;
      const ticketBonus = ticketCount * TICKET_BONUS_MNT;
      const salesBonus =
        member.role === Role.BORLUULAGCH ? Math.round((salesAmountMnt * SALES_COMMISSION_BPS) / 10_000) : 0;
      const fulfillmentBonus = ticketBonus + salesBonus;
      const baseSalary = BASE_SALARY_MNT[member.role];
      const netSalary = baseSalary + fulfillmentBonus;

      // Two people opening payroll at once must not crash on the unique (user, month) key, and a row marked
      // PAID meanwhile must keep the amount that was paid: create if missing, then refresh DRAFT rows only.
      const key = { userId_periodMonth: { userId: member.id, periodMonth: period } };
      // skipDuplicates = INSERT ... ON CONFLICT DO NOTHING, atomic in Postgres (Prisma's upsert on a compound
      // key is a read-then-insert and still races).
      await this.prisma.payroll.createMany({
        data: [
          {
            userId: member.id,
            periodMonth: period,
            baseSalary,
            fulfillmentBonus,
            netSalary,
            status: PayrollStatus.DRAFT,
          },
        ],
        skipDuplicates: true,
      });
      await this.prisma.payroll.updateMany({
        where: { userId: member.id, periodMonth: period, status: PayrollStatus.DRAFT },
        data: { baseSalary, fulfillmentBonus, netSalary },
      });
      const payroll = await this.prisma.payroll.findUniqueOrThrow({ where: key });
      rows.push({
        ...payroll,
        ticketCount,
        salesAmountMnt,
        ticketBonus,
        salesBonus,
        user: {
          id: member.id,
          fullName: member.fullName,
          username: member.username,
          role: member.role,
        },
      });
    }

    this.log.log(`Payroll calculated period=${period} staff=${rows.length} by ${user.fullName ?? user.name}`);
    return {
      periodMonth: period,
      timeZone: UB_TZ,
      rates: { ticketBonusMnt: TICKET_BONUS_MNT, salesCommissionBps: SALES_COMMISSION_BPS, baseSalary: BASE_SALARY_MNT },
      rows,
    };
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
      data: { status: PayrollStatus.PAID },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
    });
    this.log.log(`Payroll PAID ${row.periodMonth} ${row.user.fullName} amount=${row.netSalary} by ${user.id}`);
    return updated;
  }
}
