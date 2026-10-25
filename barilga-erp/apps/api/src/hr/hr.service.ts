import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AttendanceSource, AttendanceStatus, DayMark, LeaveStatus, OrderStatus, PaymentStatus, PayMethod, PayrollStatus, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { isManagerRole, isTopRole, seesAllWarehouses, warehouseWhere } from '../inventory/warehouse-scope';
import { FeaturesService } from '../features/features.service';
import { audit } from '../common/audit';
import { assertCan } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttendanceAddDto,
  AttendanceFixDto,
  AttendanceSettingsDto,
  DayMarkDto,
  LeaveDecisionDto,
  LeaveRequestDto,
  PayrollAdjustmentDto,
  PayrollSettingsDto,
  StaffPunchDto,
} from './dto/hr.dto';

const UB_TZ = 'Asia/Ulaanbaatar';

const PAYROLL_KEY = 'PAYROLL';
const ATTENDANCE_KEY = 'ATTENDANCE';

/** The working day used to mark late arrivals and overtime (admin sets it on the attendance page). */
export type AttendanceSettings = {
  /** "09:00" — the shift starts. */
  shiftStart: string;
  /** Minutes after the start still counted as on time. */
  graceMinutes: number;
  /** "18:00" — leaving later is overtime. */
  shiftEnd: string;
  /** Hours worked in a day beyond which it is overtime, whatever the clock says. */
  overtimeAfterHours: number;
  /**
   * Staff press «Ирлээ / Явлаа» themselves: OFF = only managers record; CONFIRM = recorded, counted once a
   * manager confirms; AUTO = counted at once.
   */
  selfCheckIn: 'OFF' | 'CONFIRM' | 'AUTO';
  /** Public holidays (YYYY-MM-DD): not working days. */
  holidays: string[];
};

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = {
  shiftStart: '09:00',
  graceMinutes: 15,
  shiftEnd: '18:00',
  overtimeAfterHours: 8.5,
  selfCheckIn: 'CONFIRM',
  holidays: [],
};

/** Day statuses in Mongolian (summaries, audit lines). */
export const DAY_MARK_MN: Record<DayMark, string> = {
  PAID_LEAVE: 'цалинтай чөлөө',
  UNPAID_LEAVE: 'цалингүй чөлөө',
  SICK: 'өвчтэй',
  ANNUAL_LEAVE: 'ээлжийн амралт',
  BUSINESS_TRIP: 'томилолт',
  ABSENT: 'тасалсан',
  DAY_OFF: 'амралтын өдөр',
};
/** What an employee may ask for (тасалсан and амралтын өдөр are set by a manager). */
const REQUESTABLE: DayMark[] = [DayMark.PAID_LEAVE, DayMark.UNPAID_LEAVE, DayMark.SICK, DayMark.ANNUAL_LEAVE, DayMark.BUSINESS_TRIP];

/** A punch counts as a day at work unless the person recorded it themselves and nobody confirmed it yet. */
export const counts = (r: { source?: AttendanceSource | string | null; confirmedAt?: Date | null }) => r.source !== AttendanceSource.SELF || Boolean(r.confirmedAt);

/** Dates from..to inclusive (YYYY-MM-DD). */
function datesBetween(from: string, to: string) {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const isWorkingDate = (date: string, perWeek: number, holidays: string[]) => {
  if (holidays.includes(date)) return false;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return perWeek >= 7 || (dow >= 1 && dow <= perWeek);
};

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

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
  defaultBaseMnt: { ADMIN: 3_500_000, SUPER_MANAGER: 3_200_000, MANAGER: 2_800_000, BORLUULAGCH: 1_800_000, ACHIGCH_BELTGEGCH: 1_600_000 },
  ticketBonusMnt: 15_000,
  salesCommissionPct: 0.5,
  prorateByAttendance: false,
  workDaysPerWeek: 6,
  socialInsurancePct: 0,
  incomeTaxPct: 0,
};

/** Days in the month that are working days (Mon–Fri, Mon–Sat or all), public holidays not counted. */
export function countWorkingDays(periodMonth: string, perWeek: number, holidays: string[] = []) {
  const [y, m] = periodMonth.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= days; d++) {
    const date = `${periodMonth}-${String(d).padStart(2, '0')}`;
    if (isWorkingDate(date, perWeek, holidays)) n++;
  }
  return n;
}

function ymdInUlaanbaatar(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UB_TZ }).format(date);
}

function periodMonthNow() {
  return ymdInUlaanbaatar().slice(0, 7);
}

/**
 * A check-in can still be closed «now» when it is today's, or from the day before and at most this long ago: a
 * shift that ran past midnight (came 23:30, leaves 00:40). Older ones were forgotten; a manager enters their
 * check-out. Checking in again on a later day always closes the earlier one at that day's shift end, so an
 * evening check-in nobody closed never blocks the next morning. The web pages use the same 16 hours.
 */
const MAX_SHIFT_MS = 16 * 3_600_000;
const onCurrentShift = (checkIn: Date, now = new Date()) =>
  ymdInUlaanbaatar(checkIn) === ymdInUlaanbaatar(now) || now.getTime() - checkIn.getTime() <= MAX_SHIFT_MS;

/**
 * Where a record ends when checking overlaps: its check-out; a shift still running, now; a check-in forgotten on
 * an earlier day, that day's shift end (where checking in again closes it) — not every day since.
 */
function recordEnd(r: { checkIn: Date; checkOut: Date | null }, shiftEnd: string) {
  if (r.checkOut) return r.checkOut;
  if (onCurrentShift(r.checkIn)) return new Date();
  const end = new Date(`${ymdInUlaanbaatar(r.checkIn)}T${shiftEnd}:00.000+08:00`);
  return end > r.checkIn ? end : new Date(r.checkIn.getTime() + 60_000);
}

/** The refusal for an overlap, naming a forgotten check-in when that is what is in the way. */
function overlapError(r: { checkIn: Date; checkOut: Date | null }) {
  return new BadRequestException(
    !r.checkOut && !onCurrentShift(r.checkIn)
      ? `${ymdInUlaanbaatar(r.checkIn)}-ны гарсан цаг бүртгээгүй бүртгэлтэй давхцаж байна — эхлээд түүнийг «засах»-аар хаана уу / Overlaps a check-in left open`
      : 'Энэ хугацаанд өөр бүртгэл байна / Another record covers this time',
  );
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

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly features?: FeaturesService,
  ) {}

  /**
   * With the PAYROLL_FORMULA module off (the default) pay is entered by hand: each person's base salary plus
   * the bonuses and deductions written for the month. The formula (per-order bonus, commission, insurance,
   * income tax, role defaults, attendance pro-rating) only applies when the module is switched on.
   */
  private async formulaOn() {
    return this.features ? this.features.isEnabled('PAYROLL_FORMULA') : true;
  }

  assertManager(user: AuthUser) {
    if (!isManagerRole(user.role)) {
      throw new ForbiddenException('Only managers or admin can manage attendance');
    }
  }

  /**
   * The staff a manager looks after: everyone for admin and the general manager; for a branch manager the
   * people of their warehouses, never admin or the general manager.
   */
  private async staffScope(user: AuthUser): Promise<Prisma.UserWhereInput> {
    if (seesAllWarehouses(user)) return {};
    const def = await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    // Someone given the attendance right without being a manager does not record their managers either.
    const above = isManagerRole(user.role) ? [Role.ADMIN, Role.SUPER_MANAGER] : [Role.ADMIN, Role.SUPER_MANAGER, Role.MANAGER];
    return { AND: [warehouseWhere(user, def?.id) as Prisma.UserWhereInput, { role: { notIn: above } }] };
  }

  private async assertStaffInScope(user: AuthUser, staffId: string) {
    if (seesAllWarehouses(user)) return;
    const n = await this.prisma.user.count({ where: { AND: [{ id: staffId }, await this.staffScope(user)] } });
    if (!n) throw new ForbiddenException('Энэ ажилтан өөр салбарынх / This employee belongs to another warehouse');
  }

  /** Salaries are set and paid by admin or the general manager. */
  private assertPayroller(user: AuthUser, what: string) {
    if (!isTopRole(user.role)) throw new ForbiddenException(`Only admin or the general manager can ${what}`);
  }

  async board(actor: AuthUser) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const staff = await this.prisma.user.findMany({
      where: { AND: [{ isActive: true, username: { not: WEBSHOP_USERNAME } }, await this.staffScope(actor)] },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, username: true, role: true },
    });
    const openRows = await this.prisma.attendance.findMany({
      where: { checkOut: null, userId: { in: staff.map((s) => s.id) } },
      orderBy: { checkIn: 'desc' },
    });
    // Rows come newest first: keep the newest open check-in per person.
    const openByUser = new Map<string, (typeof openRows)[number]>();
    for (const row of openRows) if (!openByUser.has(row.userId)) openByUser.set(row.userId, row);
    const today = ymdInUlaanbaatar();
    const start = new Date(`${today}T00:00:00.000+08:00`);
    const end = new Date(`${today}T23:59:59.999+08:00`);
    const recent = await this.prisma.attendance.findMany({
      where: { checkIn: { gte: start, lte: end }, userId: { in: staff.map((s) => s.id) } },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
      orderBy: { checkIn: 'desc' },
      take: 80,
    });
    const ids = staff.map((s) => s.id);
    const [todayMarks, waiting, pendingRequests] = await Promise.all([
      this.prisma.attendanceDay.findMany({ where: { userId: { in: ids }, date: today } }),
      // Check-ins people made themselves that a manager has not confirmed yet (last 31 days).
      this.prisma.attendance.findMany({
        where: { userId: { in: ids }, source: AttendanceSource.SELF, confirmedAt: null, checkIn: { gte: new Date(Date.now() - 31 * 86_400_000) } },
        include: { user: { select: { id: true, fullName: true } } },
        orderBy: { checkIn: 'desc' },
      }),
      this.prisma.leaveRequest.count({ where: { userId: { in: actor.role === Role.ADMIN ? ids : ids.filter((id) => id !== actor.id) }, status: LeaveStatus.PENDING } }),
    ]);
    const markBy = new Map(todayMarks.map((m) => [m.userId, m]));
    // A month already paid cannot be confirmed into any more: those punches are not shown as waiting.
    const paid = waiting.length
      ? await this.prisma.payroll.findMany({
          where: { userId: { in: [...new Set(waiting.map((w) => w.userId))] }, status: PayrollStatus.PAID },
          select: { userId: true, periodMonth: true },
        })
      : [];
    const paidKey = new Set(paid.map((p) => `${p.userId}:${p.periodMonth}`));
    const confirmable = waiting.filter((w) => !paidKey.has(`${w.userId}:${ymdInUlaanbaatar(w.checkIn).slice(0, 7)}`));
    return {
      timeZone: UB_TZ,
      date: today,
      staff: staff.map((member) => ({
        ...member,
        open: openByUser.get(member.id) ?? null,
        mark: markBy.get(member.id)?.mark ?? null,
        markNote: markBy.get(member.id)?.note ?? null,
        markFromRequest: Boolean(markBy.get(member.id)?.requestId),
      })),
      recent,
      waiting: confirmable,
      pendingRequests,
    };
  }

  /** The board records others; one's own check-in goes through «Миний ирц», where a manager confirms it. */
  private assertNotOwnPunch(actor: AuthUser, userId: string) {
    if (userId === actor.id && actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Өөрийн ирцийг самбараас бүртгэхгүй — «Миний ирц»-ээс, эсвэл өөр менежер бүртгэнэ / Not your own attendance from the board');
    }
  }

  async checkIn(actor: AuthUser, dto: StaffPunchDto) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    this.assertNotOwnPunch(actor, dto.userId);
    await this.assertStaffInScope(actor, dto.userId);
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!staff || !staff.isActive) throw new NotFoundException('Staff member not found');
    return this.punchIn(staff, actor, { source: AttendanceSource.MANAGER, confirmed: true, notes: dto.notes });
  }

  /** The person presses «Ирлээ» themselves (when the admin allows it); a manager confirms it unless AUTO. */
  async selfCheckIn(user: AuthUser) {
    const settings = await this.attendanceSettings();
    if (settings.selfCheckIn === 'OFF') throw new ForbiddenException('Ирцээ өөрөө бүртгүүлэх боломж унтраалттай — менежерт хандана уу / Self check-in is off');
    const staff = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!staff || !staff.isActive) throw new NotFoundException('Staff member not found');
    return this.punchIn(staff, user, { source: AttendanceSource.SELF, confirmed: settings.selfCheckIn === 'AUTO' });
  }

  async selfCheckOut(user: AuthUser) {
    const settings = await this.attendanceSettings();
    if (settings.selfCheckIn === 'OFF') throw new ForbiddenException('Ирцээ өөрөө бүртгүүлэх боломж унтраалттай — менежерт хандана уу / Self check-in is off');
    return this.punchOut(user.id, user);
  }

  /** One check-in for a person: shared by the manager board, self check-in and nothing else. */
  private async punchIn(
    staff: { id: string; fullName: string; warehouseId: string | null },
    actor: AuthUser,
    opts: { source: AttendanceSource; confirmed: boolean; notes?: string },
  ) {
    const checkIn = new Date();
    // Same as checking out: a month marked paid takes no more attendance (it would not be paid for).
    await this.assertMonthOpen(staff.id, ymdInUlaanbaatar(checkIn).slice(0, 7));
    const settings = await this.attendanceSettings();
    const status = this.statusFor(checkIn, null, settings);
    const alreadyIn = () => new BadRequestException(`${staff.fullName} is already checked in`);
    // Check and insert in one SERIALIZABLE transaction: a double click sends two requests that would both
    // see "no open check-in" and both insert. Postgres aborts one of them (P2034), reported as already in.
    let row;
    try {
      row = await this.prisma.$transaction(
        async (tx) => {
          const open = await tx.attendance.findFirst({ where: { userId: staff.id, checkOut: null }, orderBy: { checkIn: 'desc' } });
          if (open && ymdInUlaanbaatar(open.checkIn) === ymdInUlaanbaatar(checkIn)) throw alreadyIn();
          const openMonthPaid =
            open && (await tx.payroll.findUnique({ where: { userId_periodMonth: { userId: staff.id, periodMonth: ymdInUlaanbaatar(open.checkIn).slice(0, 7) } } }))?.status === PayrollStatus.PAID;
          if (open && !openMonthPaid) {
            // Forgot to check out on an earlier day: that day is closed at the end of the shift (or left as
            // it was if they came after it) and marked, so the manager can correct it on the attendance page.
            // (In a month already paid nothing is changed.)
            const day = ymdInUlaanbaatar(open.checkIn);
            const end = new Date(`${day}T${settings.shiftEnd}:00.000+08:00`);
            await tx.attendance.update({
              where: { id: open.id },
              data: {
                checkOut: end > open.checkIn ? end : open.checkIn,
                notes: `${open.notes ? `${open.notes} · ` : ''}Гарсан цаг бүртгээгүй — ажлын төгсгөлөөр хаав`,
              },
            });
          }
          return tx.attendance.create({
            data: {
              userId: staff.id,
              checkIn,
              status,
              notes: opts.notes?.trim() || (opts.source === AttendanceSource.SELF ? 'Өөрөө бүртгүүлсэн' : `Бүртгэсэн: ${actor.fullName ?? actor.name}`),
              source: opts.source,
              recordedById: actor.id,
              confirmedById: opts.confirmed ? actor.id : null,
              confirmedAt: opts.confirmed ? checkIn : null,
              warehouseId: staff.warehouseId,
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
    assertCan(actor, 'ATTENDANCE_MANAGE');
    this.assertNotOwnPunch(actor, dto.userId);
    await this.assertStaffInScope(actor, dto.userId);
    return this.punchOut(dto.userId, actor);
  }

  private async punchOut(userId: string, actor: AuthUser) {
    const open = await this.prisma.attendance.findFirst({
      where: { userId, checkOut: null },
      orderBy: { checkIn: 'desc' },
      include: { user: true },
    });
    if (!open) {
      throw new BadRequestException('No open check-in to close');
    }
    // A forgotten check-in from an earlier day is not closed "now" (that would be a 20+ hour day): a manager
    // enters its check-out with «засах»; checking in again also closes it at the end of that shift.
    // A shift that only ran past midnight is closed normally.
    if (!onCurrentShift(open.checkIn)) {
      throw new BadRequestException('Өмнөх өдрийн бүртгэл нээлттэй — гарсан цагийг менежер «засах»-аар оруулна / An earlier day is still open; a manager enters its check-out');
    }
    await this.assertMonthOpen(open.userId, ymdInUlaanbaatar(open.checkIn).slice(0, 7));
    const checkOut = new Date();
    const workedMin = Math.round((checkOut.getTime() - open.checkIn.getTime()) / 60_000);
    const status = this.statusFor(open.checkIn, checkOut, await this.attendanceSettings());
    const row = await this.prisma.attendance.update({
      where: { id: open.id },
      data: { checkOut, status },
    });
    this.log.log(
      `Check-out ${open.user.fullName} (${open.userId}) status=${status} workedMin=${workedMin} by ${actor.fullName ?? actor.name} (${actor.id})`,
    );
    return row;
  }

  async attendanceSettings(): Promise<AttendanceSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: ATTENDANCE_KEY } });
    const saved = (row?.value ?? {}) as Partial<AttendanceSettings>;
    return { ...DEFAULT_ATTENDANCE_SETTINGS, ...saved, holidays: Array.isArray(saved.holidays) ? saved.holidays : [] };
  }

  async saveAttendanceSettings(dto: AttendanceSettingsDto, user: AuthUser) {
    if (user.role !== Role.ADMIN) throw new ForbiddenException('Only admin can change the working day');
    const before = await this.attendanceSettings();
    const next: AttendanceSettings = {
      shiftStart: dto.shiftStart ?? before.shiftStart,
      graceMinutes: dto.graceMinutes ?? before.graceMinutes,
      shiftEnd: dto.shiftEnd ?? before.shiftEnd,
      overtimeAfterHours: dto.overtimeAfterHours ?? before.overtimeAfterHours,
      selfCheckIn: dto.selfCheckIn ?? before.selfCheckIn,
      holidays: dto.holidays ? [...new Set(dto.holidays)].sort() : before.holidays,
    };
    if (hhmm(next.shiftEnd) <= hhmm(next.shiftStart)) throw new BadRequestException('Ажлын өдрийн төгсгөл эхлэлээс хойш байх ёстой / shiftEnd must be after shiftStart');
    await this.prisma.appSetting.upsert({
      where: { key: ATTENDANCE_KEY },
      create: { key: ATTENDANCE_KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: user.id },
      update: { value: next as unknown as Prisma.InputJsonValue, updatedById: user.id },
    });
    await audit(this.prisma, { entityType: 'SETTINGS', entityId: ATTENDANCE_KEY, summary: 'Ажлын цагийн тохиргоо', before, after: next, actorId: user.id });
    return next;
  }

  /**
   * A check-out time put in afterwards, or a wrong time corrected (forgotten check-out, check-in pressed late).
   * The old and new times and the reason go to the edits report. A month already paid is not changed.
   */
  async fixAttendance(id: string, dto: AttendanceFixDto, actor: AuthUser) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const row = await this.prisma.attendance.findUnique({ where: { id }, include: { user: { select: { fullName: true } } } });
    if (!row) throw new NotFoundException('Attendance record not found');
    await this.assertStaffInScope(actor, row.userId);
    if (row.userId === actor.id && actor.role !== Role.ADMIN) throw new ForbiddenException('Өөрийн ирцийг засахгүй / You cannot change your own attendance');
    const checkIn = dto.checkIn ? new Date(dto.checkIn) : row.checkIn;
    const checkOut = dto.checkOut === null ? null : dto.checkOut ? new Date(dto.checkOut) : row.checkOut;
    if (checkOut && checkOut <= checkIn) throw new BadRequestException('Гарсан цаг ирсэн цагаас хойш байх ёстой / checkOut must be after checkIn');
    if (checkOut && checkOut.getTime() - checkIn.getTime() > 24 * 3_600_000) throw new BadRequestException('Нэг бүртгэл 24 цагаас урт байж болохгүй / A record cannot be longer than 24 hours');
    if (checkOut && checkOut > new Date()) throw new BadRequestException('Ирээдүйн цаг оруулахгүй / Time is in the future');
    if (checkIn > new Date()) throw new BadRequestException('Ирээдүйн цаг оруулахгүй / Time is in the future');
    if (!checkOut) {
      // "Still at work" only for the current shift (today's, or one running past midnight), and a person has one
      // open check-in at a time.
      if (!onCurrentShift(checkIn)) throw new BadRequestException('Зөвхөн өнөөдрийн бүртгэлийг «ажил дээр» гэж үлдээнэ / Only today can stay open');
      const otherOpen = await this.prisma.attendance.count({ where: { userId: row.userId, checkOut: null, id: { not: id } } });
      if (otherOpen) throw new BadRequestException('Энэ ажилтан өөр нээлттэй бүртгэлтэй / Another check-in is still open');
    }
    for (const when of [row.checkIn, checkIn]) await this.assertMonthOpen(row.userId, ymdInUlaanbaatar(when).slice(0, 7));
    const settings = await this.attendanceSettings();
    // A correction must not lie over another record (hours would count twice).
    const until = checkOut ?? new Date();
    const others = await this.prisma.attendance.findMany({ where: { userId: row.userId, id: { not: id }, checkIn: { lt: until } } });
    const overlap = others.find((r) => recordEnd(r, settings.shiftEnd) > checkIn);
    if (overlap) throw overlapError(overlap);
    const updated = await this.prisma.attendance.update({
      where: { id },
      data: { checkIn, checkOut, status: this.statusFor(checkIn, checkOut, settings) },
    });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: id,
      summary: `${row.user.fullName}: ирц засав (${ymdInUlaanbaatar(row.checkIn)})`,
      before: { checkIn: row.checkIn.toISOString(), checkOut: row.checkOut?.toISOString() ?? null },
      after: { checkIn: checkIn.toISOString(), checkOut: checkOut?.toISOString() ?? null },
      reason: dto.reason.trim(),
      actorId: actor.id,
    });
    return updated;
  }

  private statusFor(checkIn: Date, checkOut: Date | null, s: AttendanceSettings) {
    const inMin = minutesInUlaanbaatar(checkIn);
    let status: AttendanceStatus = inMin > hhmm(s.shiftStart) + s.graceMinutes && inMin < hhmm(s.shiftEnd) ? AttendanceStatus.LATE : AttendanceStatus.ON_TIME;
    if (checkOut) {
      const worked = (checkOut.getTime() - checkIn.getTime()) / 60_000;
      const sameDay = ymdInUlaanbaatar(checkOut) === ymdInUlaanbaatar(checkIn);
      if (worked > s.overtimeAfterHours * 60 || !sameDay || minutesInUlaanbaatar(checkOut) > hhmm(s.shiftEnd)) status = AttendanceStatus.OVERTIME;
    }
    return status;
  }

  /**
   * The month per person: days present, late days, hours, and check-ins never closed — for the manager and
   * for paying by attendance.
   */
  async attendanceMonth(actor: AuthUser, periodMonth?: string) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const period = periodMonth || periodMonthNow();
    const { start, end } = monthBounds(period);
    const staff = await this.prisma.user.findMany({
      where: { AND: [{ username: { not: WEBSHOP_USERNAME } }, { createdAt: { lt: end } }, await this.staffScope(actor)] },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, role: true, isActive: true, createdAt: true },
    });
    const [rows, marks] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { userId: { in: staff.map((s) => s.id) }, checkIn: { gte: start, lt: end } },
        orderBy: { checkIn: 'asc' },
      }),
      this.prisma.attendanceDay.findMany({ where: { userId: { in: staff.map((s) => s.id) }, date: { startsWith: period } } }),
    ]);
    const [settings, day] = await Promise.all([this.payrollSettings(), this.attendanceSettings()]);
    const workingDays = countWorkingDays(period, settings.workDaysPerWeek, day.holidays);
    const today = ymdInUlaanbaatar();
    const worked = (r: { checkIn: Date; checkOut: Date | null }) => (r.checkOut ? Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 60_000) : 0);
    const people = staff
      .map((s) => {
        const all = rows.filter((r) => r.userId === s.id);
        // Self check-ins nobody confirmed yet are listed but not counted.
        const mine = all.filter(counts);
        const myMarks = marks.filter((m) => m.userId === s.id);
        const markCounts: Partial<Record<DayMark, number>> = {};
        for (const m of myMarks) markCounts[m.mark] = (markCounts[m.mark] ?? 0) + 1;
        // A day is late when its first arrival is after the start + grace (a second check-in after lunch is
        // not lateness), and overtime when the day's hours or its last departure go past the working day.
        const byDay = new Map<string, typeof mine>();
        for (const r of mine) byDay.set(ymdInUlaanbaatar(r.checkIn), [...(byDay.get(ymdInUlaanbaatar(r.checkIn)) ?? []), r]);
        let lateDays = 0;
        let overtimeDays = 0;
        for (const list of byDay.values()) {
          if (minutesInUlaanbaatar(list[0].checkIn) > hhmm(day.shiftStart) + day.graceMinutes) lateDays++;
          const total = list.reduce((m, r) => m + worked(r), 0);
          const lastOut = list.map((r) => r.checkOut).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
          if (total > day.overtimeAfterHours * 60 || (lastOut && minutesInUlaanbaatar(lastOut) > hhmm(day.shiftEnd))) overtimeDays++;
        }
        const minutes = mine.reduce((m, r) => m + worked(r), 0);
        // Forgotten check-outs (a shift still running past midnight is not one).
        const unclosed = all.filter((r) => !r.checkOut && !onCurrentShift(r.checkIn));
        // Past working days with nothing at all (no check-in, no status): for the manager to resolve.
        const [y, mo] = period.split('-').map(Number);
        const last = Math.min(new Date(Date.UTC(y, mo, 0)).getUTCDate(), period === today.slice(0, 7) ? Number(today.slice(8)) - 1 : 31);
        const markedDays = new Set(myMarks.map((m) => m.date));
        const unknownDays: string[] = [];
        for (let d = 1; d <= last; d++) {
          const date = `${period}-${String(d).padStart(2, '0')}`;
          if (date >= today) break;
          if (date < ymdInUlaanbaatar(s.createdAt)) continue; // not with us yet
          if (isWorkingDate(date, settings.workDaysPerWeek, day.holidays) && !byDay.has(date) && !markedDays.has(date)) unknownDays.push(date);
        }
        const { createdAt: _since, ...person } = s;
        return {
          ...person,
          startedOn: ymdInUlaanbaatar(s.createdAt),
          presentDays: byDay.size,
          lateDays,
          overtimeDays,
          hours: Math.round(minutes / 6) / 10,
          unclosed: unclosed.map((r) => ({ id: r.id, checkIn: r.checkIn })),
          waiting: all.filter((r) => !counts(r)).length,
          markCounts,
          marks: myMarks.map((m) => ({ date: m.date, mark: m.mark, note: m.note, fromRequest: Boolean(m.requestId) })),
          unknownDays,
          records: all.map((r) => ({
            id: r.id,
            checkIn: r.checkIn,
            checkOut: r.checkOut,
            status: r.status,
            notes: r.notes,
            source: r.source,
            confirmed: counts(r),
          })),
        };
      })
      .filter((p) => p.isActive || p.records.length > 0 || p.marks.length > 0);
    return { periodMonth: period, workingDays, holidays: day.holidays.filter((h) => h.startsWith(period)), people };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Self service, leave requests and day statuses
  // ---------------------------------------------------------------------------------------------------------

  /** Only the admin records or changes their own attendance; everyone else goes through someone else. */
  private assertNotSelf(actor: AuthUser, userId: string) {
    if (userId === actor.id && actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Өөрийн ирцийг өөрөө батлах, засахгүй / You cannot do this for yourself');
    }
  }

  /** The person's own month: days with check-ins, day statuses and requests, for «Миний ирц». */
  async myAttendance(user: AuthUser, periodMonth?: string) {
    const period = periodMonth || periodMonthNow();
    const { start, end } = monthBounds(period);
    const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true } });
    const startedOn = me ? ymdInUlaanbaatar(me.createdAt) : '0000-00-00';
    const [settings, att, records, marks, requests, open] = await Promise.all([
      this.payrollSettings(),
      this.attendanceSettings(),
      this.prisma.attendance.findMany({ where: { userId: user.id, checkIn: { gte: start, lt: end } }, orderBy: { checkIn: 'asc' } }),
      this.prisma.attendanceDay.findMany({ where: { userId: user.id, date: { startsWith: period } } }),
      this.prisma.leaveRequest.findMany({
        where: { userId: user.id, OR: [{ fromDate: { startsWith: period } }, { toDate: { startsWith: period } }, { status: LeaveStatus.PENDING }] },
        orderBy: { createdAt: 'desc' },
        include: { decidedBy: { select: { fullName: true } } },
      }),
      this.prisma.attendance.findFirst({ where: { userId: user.id, checkOut: null }, orderBy: { checkIn: 'desc' } }),
    ]);
    const markBy = new Map(marks.map((m) => [m.date, m]));
    const [y, m] = period.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = `${period}-${String(i + 1).padStart(2, '0')}`;
      const own = records.filter((r) => ymdInUlaanbaatar(r.checkIn) === date);
      return {
        date,
        working: isWorkingDate(date, settings.workDaysPerWeek, att.holidays),
        beforeStart: date < startedOn,
        holiday: att.holidays.includes(date),
        records: own.map((r) => ({ id: r.id, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, confirmed: counts(r), source: r.source })),
        mark: markBy.get(date)?.mark ?? null,
        note: markBy.get(date)?.note ?? null,
      };
    });
    const present = new Set(records.filter(counts).map((r) => ymdInUlaanbaatar(r.checkIn)));
    return {
      periodMonth: period,
      today: ymdInUlaanbaatar(),
      settings: { selfCheckIn: att.selfCheckIn, shiftStart: att.shiftStart, shiftEnd: att.shiftEnd, graceMinutes: att.graceMinutes },
      open: open ? { id: open.id, checkIn: open.checkIn, confirmed: counts(open) } : null,
      workingDays: countWorkingDays(period, settings.workDaysPerWeek, att.holidays),
      presentDays: present.size,
      waiting: records.filter((r) => !counts(r)).length,
      days,
      requests: requests.map((r) => ({ ...r, decidedBy: r.decidedBy?.fullName ?? null })),
    };
  }

  /** «Чөлөө хүсэх»: some days of leave, sick days, a business trip… waiting for a manager. */
  async requestLeave(user: AuthUser, dto: LeaveRequestDto) {
    if (!REQUESTABLE.includes(dto.kind)) throw new BadRequestException('Энэ төрлийг хүсэхгүй / This kind cannot be requested');
    if (dto.toDate < dto.fromDate) throw new BadRequestException('Дуусах өдөр эхлэхээс өмнө байна / toDate is before fromDate');
    const span = datesBetween(dto.fromDate, dto.toDate).length;
    if (span > 31) throw new BadRequestException('Нэг хүсэлтэд 31 хоногоос ихгүй / At most 31 days per request');
    const today = ymdInUlaanbaatar();
    const monthAgo = ymdInUlaanbaatar(new Date(Date.now() - 31 * 86_400_000));
    if (dto.fromDate < monthAgo) throw new BadRequestException('Сар гаруйн өмнөх өдрийг хүсэхгүй — менежерт хандана уу / Too far in the past');
    const open = await this.prisma.leaveRequest.findMany({
      where: { userId: user.id, status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] } },
      select: { fromDate: true, toDate: true },
    });
    if (open.some((r) => r.fromDate <= dto.toDate && r.toDate >= dto.fromDate)) throw new BadRequestException('Эдгээр өдөрт өөр хүсэлт байна / Another request covers these days');
    const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { warehouseId: true } });
    const row = await this.prisma.leaveRequest.create({
      data: { userId: user.id, kind: dto.kind, fromDate: dto.fromDate, toDate: dto.toDate, reason: dto.reason.trim(), warehouseId: me?.warehouseId ?? null },
    });
    this.log.log(`Leave request ${row.id} ${dto.kind} ${dto.fromDate}..${dto.toDate} by ${user.id} (${today})`);
    return row;
  }

  /** The person takes back a request: a pending one, or an approved one that has not started yet. */
  async cancelLeave(user: AuthUser, id: string) {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) throw new NotFoundException('Request not found');
    const today = ymdInUlaanbaatar();
    if (row.status === LeaveStatus.APPROVED && row.fromDate <= today) {
      throw new BadRequestException('Эхэлсэн чөлөөг менежер «Ирц → Хүсэлтүүд»-ээс цуцалж, богиносгоно / Already started; a manager cancels or shortens it');
    }
    if (row.status !== LeaveStatus.PENDING && row.status !== LeaveStatus.APPROVED) {
      throw new BadRequestException('Энэ хүсэлтийг цуцлах боломжгүй / This request cannot be cancelled');
    }
    // Its day statuses go too: not out of a month already paid.
    const marked = await this.prisma.attendanceDay.findMany({ where: { requestId: id }, select: { date: true } });
    for (const month of new Set(marked.map((m) => m.date.slice(0, 7)))) await this.assertMonthOpen(row.userId, month);
    return this.prisma.$transaction(async (tx) => {
      // Only if nobody decided it meanwhile (a manager approving at the same moment).
      const claimed = await tx.leaveRequest.updateMany({ where: { id, status: row.status }, data: { status: LeaveStatus.CANCELLED } });
      if (claimed.count !== 1) throw new ConflictException('Хүсэлт сая өөрчлөгдсөн, дахин ачаална уу / The request changed meanwhile; reload');
      await tx.attendanceDay.deleteMany({ where: { requestId: id } });
      return tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    });
  }

  /**
   * A manager cancels an approved leave, or shortens it (the person came back early): the day statuses from
   * the chosen end onwards are removed. Paid months are not touched.
   */
  async cancelApprovedLeave(actor: AuthUser, id: string, dto: { toDate?: string; note: string }) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { user: { select: { fullName: true } } } });
    if (!row) throw new NotFoundException('Request not found');
    await this.assertStaffInScope(actor, row.userId);
    this.assertNotSelf(actor, row.userId);
    if (row.status !== LeaveStatus.APPROVED) throw new BadRequestException('Зөвхөн зөвшөөрсөн чөлөөг цуцалж, богиносгоно / Only an approved leave');
    if (dto.toDate && !(dto.toDate >= row.fromDate && dto.toDate < row.toDate)) {
      throw new BadRequestException('Шинэ дуусах өдөр чөлөөний дотор байх ёстой / The new end must be inside the leave');
    }
    // A real calendar day only (JavaScript would read 2030-02-30 as 2 March).
    if (dto.toDate && datesBetween(dto.toDate, dto.toDate)[0] !== dto.toDate) throw new BadRequestException('Огноо буруу / Invalid date');
    // The first day that is no longer leave.
    const cut = dto.toDate ? datesBetween(dto.toDate, row.toDate)[1] : row.fromDate;
    if (!cut) throw new BadRequestException('Огноо буруу / Invalid date');
    for (const month of new Set(datesBetween(cut, row.toDate).map((d) => d.slice(0, 7)))) await this.assertMonthOpen(row.userId, month);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Only the leave as it was read: two managers shortening it at once must not leave days without marks.
      const claimed = await tx.leaveRequest.updateMany({
        where: { id, status: LeaveStatus.APPROVED, toDate: row.toDate },
        data: dto.toDate
          ? { toDate: dto.toDate, decidedById: actor.id, decidedAt: new Date(), decisionNote: dto.note.trim() }
          : { status: LeaveStatus.CANCELLED, decidedById: actor.id, decidedAt: new Date(), decisionNote: dto.note.trim() },
      });
      if (claimed.count !== 1) throw new ConflictException('Хүсэлт сая өөрчлөгдсөн, дахин ачаална уу / The request changed meanwhile; reload');
      const marks = await tx.attendanceDay.findMany({ where: { requestId: id } });
      for (const m of marks) if (m.date >= cut) await tx.attendanceDay.delete({ where: { id: m.id } });
      return tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: row.userId,
      summary: `${row.user.fullName}: ${DAY_MARK_MN[row.kind]} ${row.fromDate}–${row.toDate} ${dto.toDate ? `${dto.toDate} хүртэл богиносгосон` : 'цуцалсан'}`,
      before: { toDate: row.toDate, status: row.status, decidedById: row.decidedById, decisionNote: row.decisionNote },
      after: { toDate: updated.toDate, status: updated.status },
      reason: dto.note.trim(),
      actorId: actor.id,
    });
    return updated;
  }

  /** Requests of the people this manager looks after (pending first). */
  async listLeave(actor: AuthUser, status?: string) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const people = await this.prisma.user.findMany({ where: await this.staffScope(actor), select: { id: true } });
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        userId: { in: people.map((p) => p.id) },
        ...(status && status !== 'ALL' && status in LeaveStatus ? { status: status as LeaveStatus } : status === 'ALL' ? {} : { status: LeaveStatus.PENDING }),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 300,
      include: { user: { select: { id: true, fullName: true, role: true } }, decidedBy: { select: { fullName: true } } },
    });
    return rows.map((r) => ({ ...r, decidedBy: r.decidedBy?.fullName ?? null }));
  }

  /**
   * Approve or reject. Approving writes the day status on each working day of the request (public holidays and
   * days off are skipped); a status already set on those days is replaced. Pay does not change by itself.
   */
  async decideLeave(actor: AuthUser, id: string, approve: boolean, dto: LeaveDecisionDto) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { user: { select: { fullName: true } } } });
    if (!row) throw new NotFoundException('Request not found');
    await this.assertStaffInScope(actor, row.userId);
    this.assertNotSelf(actor, row.userId);
    if (row.status !== LeaveStatus.PENDING) throw new BadRequestException('Энэ хүсэлт шийдэгдсэн байна / Already decided');
    if (!approve && !(dto.note?.trim().length ?? 0)) throw new BadRequestException('Татгалзсан шалтгаанаа бичнэ үү / A reason is required');
    const [settings, att] = await Promise.all([this.payrollSettings(), this.attendanceSettings()]);
    const dates = approve ? datesBetween(row.fromDate, row.toDate).filter((d) => isWorkingDate(d, settings.workDaysPerWeek, att.holidays)) : [];
    for (const month of new Set(dates.map((d) => d.slice(0, 7)))) await this.assertMonthOpen(row.userId, month);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Claim it first: a second manager, or the employee cancelling at the same moment, gets a conflict.
      const claimed = await tx.leaveRequest.updateMany({
        where: { id, status: LeaveStatus.PENDING },
        data: { status: approve ? LeaveStatus.APPROVED : LeaveStatus.REJECTED, decidedById: actor.id, decidedAt: new Date(), decisionNote: dto.note?.trim() || null },
      });
      if (claimed.count !== 1) throw new ConflictException('Хүсэлт сая өөрчлөгдсөн, дахин ачаална уу / The request changed meanwhile; reload');
      for (const date of dates) {
        await tx.attendanceDay.upsert({
          where: { userId_date: { userId: row.userId, date } },
          create: { userId: row.userId, date, mark: row.kind, note: row.reason, requestId: row.id, createdById: actor.id },
          update: { mark: row.kind, note: row.reason, requestId: row.id, createdById: actor.id },
        });
      }
      return tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: row.userId,
      summary: `${row.user.fullName}: ${DAY_MARK_MN[row.kind]} ${row.fromDate}–${row.toDate} ${approve ? `зөвшөөрсөн (${dates.length} ажлын өдөр)` : 'татгалзсан'}`,
      after: { status: updated.status, days: dates.length },
      reason: dto.note?.trim() || undefined,
      actorId: actor.id,
    });
    return updated;
  }

  /** A manager sets one day's status for a person (тасалсан, өвчтэй, чөлөө…) without a request. */
  async setDayMark(actor: AuthUser, dto: DayMarkDto) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    await this.assertStaffInScope(actor, dto.userId);
    this.assertNotSelf(actor, dto.userId);
    if (dto.date > ymdInUlaanbaatar(new Date(Date.now() + 366 * 86_400_000))) throw new BadRequestException('Хэт хол ирээдүй / Too far ahead');
    await this.assertMonthOpen(dto.userId, dto.date.slice(0, 7));
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { fullName: true } });
    if (!staff) throw new NotFoundException('Staff member not found');
    const before = await this.prisma.attendanceDay.findUnique({ where: { userId_date: { userId: dto.userId, date: dto.date } } });
    const row = await this.prisma.attendanceDay.upsert({
      where: { userId_date: { userId: dto.userId, date: dto.date } },
      create: { userId: dto.userId, date: dto.date, mark: dto.mark, note: dto.note?.trim() || null, createdById: actor.id },
      update: { mark: dto.mark, note: dto.note?.trim() || null, requestId: null, createdById: actor.id },
    });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: dto.userId,
      summary: `${staff.fullName} ${dto.date}: ${before ? `${DAY_MARK_MN[before.mark]} → ` : ''}${DAY_MARK_MN[dto.mark]}`,
      before: { mark: before?.mark ?? null },
      after: { mark: dto.mark },
      reason: dto.note?.trim() || undefined,
      actorId: actor.id,
    });
    return row;
  }

  async clearDayMark(actor: AuthUser, userId: string, date: string) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    await this.assertStaffInScope(actor, userId);
    this.assertNotSelf(actor, userId);
    await this.assertMonthOpen(userId, date.slice(0, 7));
    const row = await this.prisma.attendanceDay.findUnique({ where: { userId_date: { userId, date } }, include: { user: { select: { fullName: true } } } });
    if (!row) throw new NotFoundException('Day status not found');
    await this.prisma.attendanceDay.delete({ where: { id: row.id } });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: userId,
      summary: `${row.user.fullName} ${date}: ${DAY_MARK_MN[row.mark]} арилгасан`,
      before: { mark: row.mark },
      after: { mark: null },
      actorId: actor.id,
    });
    return { removed: true };
  }

  /** Confirm check-ins people recorded themselves (only then they count as days at work). */
  async confirmPunches(actor: AuthUser, ids: string[]) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const rows = await this.prisma.attendance.findMany({
      where: { id: { in: ids }, source: AttendanceSource.SELF, confirmedAt: null },
      include: { user: { select: { fullName: true } } },
    });
    const ok: string[] = [];
    let skipped = 0;
    for (const r of rows) {
      await this.assertStaffInScope(actor, r.userId);
      this.assertNotSelf(actor, r.userId);
      // A month already paid keeps what was paid: its check-ins are not confirmed afterwards.
      const paid = await this.prisma.payroll.findUnique({ where: { userId_periodMonth: { userId: r.userId, periodMonth: ymdInUlaanbaatar(r.checkIn).slice(0, 7) } } });
      if (paid?.status === PayrollStatus.PAID) {
        skipped++;
        continue;
      }
      ok.push(r.id);
    }
    if (ok.length) await this.prisma.attendance.updateMany({ where: { id: { in: ok } }, data: { confirmedAt: new Date(), confirmedById: actor.id } });
    if (ok.length) {
      await audit(this.prisma, {
        entityType: 'ATTENDANCE',
        entityId: rows.find((r) => ok.includes(r.id))!.userId,
        summary: `Өөрөө бүртгүүлсэн ${ok.length} ирц баталсан: ${[...new Set(rows.filter((r) => ok.includes(r.id)).map((r) => r.user.fullName))].join(', ')}`,
        after: { ids: ok },
        actorId: actor.id,
      });
    }
    return { confirmed: ok.length, skipped };
  }

  /** A day someone worked but nobody pressed «Ирсэн»: added by hand with a reason. */
  async addRecord(actor: AuthUser, dto: AttendanceAddDto) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    await this.assertStaffInScope(actor, dto.userId);
    this.assertNotSelf(actor, dto.userId);
    const checkIn = new Date(dto.checkIn);
    const checkOut = dto.checkOut ? new Date(dto.checkOut) : null;
    if (checkIn > new Date() || (checkOut && checkOut > new Date())) throw new BadRequestException('Ирээдүйн цаг оруулахгүй / Time is in the future');
    if (checkOut && checkOut <= checkIn) throw new BadRequestException('Гарсан цаг ирсэн цагаас хойш байх ёстой / checkOut must be after checkIn');
    if (checkOut && checkOut.getTime() - checkIn.getTime() > 24 * 3_600_000) throw new BadRequestException('Нэг бүртгэл 24 цагаас урт байж болохгүй / A record cannot be longer than 24 hours');
    if (!checkOut && !onCurrentShift(checkIn)) throw new BadRequestException('Өмнөх өдрийн бүртгэлд явсан цагийг оруулна уу / Add the check-out time');
    await this.assertMonthOpen(dto.userId, ymdInUlaanbaatar(checkIn).slice(0, 7));
    const settings = await this.attendanceSettings();
    const nearby = await this.prisma.attendance.findMany({ where: { userId: dto.userId, checkIn: { lt: checkOut ?? new Date() } } });
    const overlap = nearby.find((r) => recordEnd(r, settings.shiftEnd) > checkIn);
    if (overlap) throw overlapError(overlap);
    // One open check-in at a time (as for a correction): a forgotten one is closed first.
    if (!checkOut && (await this.prisma.attendance.count({ where: { userId: dto.userId, checkOut: null } }))) {
      throw new BadRequestException('Энэ ажилтан өөр нээлттэй бүртгэлтэй — эхлээд түүнийг хаана уу / Another check-in is still open');
    }
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { fullName: true, warehouseId: true } });
    if (!staff) throw new NotFoundException('Staff member not found');
    const row = await this.prisma.attendance.create({
      data: {
        userId: dto.userId,
        checkIn,
        checkOut,
        status: this.statusFor(checkIn, checkOut, settings),
        notes: `Гараар нэмсэн: ${dto.reason.trim()}`,
        source: AttendanceSource.FIX,
        recordedById: actor.id,
        confirmedById: actor.id,
        confirmedAt: new Date(),
        warehouseId: staff.warehouseId,
      },
    });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: row.id,
      summary: `${staff.fullName}: ирц гараар нэмсэн (${ymdInUlaanbaatar(checkIn)})`,
      before: { checkIn: null, checkOut: null },
      after: { checkIn: checkIn.toISOString(), checkOut: checkOut?.toISOString() ?? null },
      reason: dto.reason.trim(),
      actorId: actor.id,
    });
    return row;
  }

  /** A wrong record (the wrong person pressed, a test) removed with a reason. */
  async deleteRecord(actor: AuthUser, id: string, reason: string) {
    assertCan(actor, 'ATTENDANCE_MANAGE');
    const row = await this.prisma.attendance.findUnique({ where: { id }, include: { user: { select: { fullName: true } } } });
    if (!row) throw new NotFoundException('Attendance record not found');
    await this.assertStaffInScope(actor, row.userId);
    this.assertNotSelf(actor, row.userId);
    await this.assertMonthOpen(row.userId, ymdInUlaanbaatar(row.checkIn).slice(0, 7));
    await this.prisma.attendance.delete({ where: { id } });
    await audit(this.prisma, {
      entityType: 'ATTENDANCE',
      entityId: id,
      summary: `${row.user.fullName}: ирц устгасан (${ymdInUlaanbaatar(row.checkIn)})`,
      before: { checkIn: row.checkIn.toISOString(), checkOut: row.checkOut?.toISOString() ?? null },
      after: { checkIn: null, checkOut: null },
      reason: reason.trim(),
      actorId: actor.id,
    });
    return { removed: id };
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

  /**
   * Sets one employee's monthly base salary from a month on (default: this month); earlier months keep what
   * they had. null = no own salary from then (the role default when the formula is on, otherwise 0). Nobody
   * sets their own salary except the admin, and only the admin sets the general manager's or another admin's.
   */
  async setBaseSalary(userId: string, baseSalaryMnt: number | null, user: AuthUser, opts: { fromMonth?: string; reason?: string } = {}) {
    this.assertPayroller(user, 'set salaries');
    const staff = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!staff) throw new NotFoundException('Staff member not found');
    if (user.role !== Role.ADMIN) {
      if (userId === user.id) throw new ForbiddenException('Өөрийн цалинг өөрөө өөрчлөхгүй / You cannot set your own salary');
      if (isTopRole(staff.role)) throw new ForbiddenException('Ерөнхий менежер, админы цалинг зөвхөн админ тогтооно / Only admin sets this salary');
    }
    const fromMonth = opts.fromMonth || periodMonthNow();
    monthBounds(fromMonth);
    const paid = await this.prisma.payroll.findUnique({ where: { userId_periodMonth: { userId, periodMonth: fromMonth } } });
    if (paid?.status === PayrollStatus.PAID) {
      throw new BadRequestException(`${fromMonth} сарын цалин олгогдсон — дараагийн сараас тогтооно уу / That month is already paid`);
    }
    const before = await this.baseOn(userId, fromMonth, staff.baseSalaryMnt);
    await this.prisma.$transaction(async (tx) => {
      await tx.salaryRate.upsert({
        where: { userId_fromMonth: { userId, fromMonth } },
        create: { userId, fromMonth, baseSalaryMnt, reason: opts.reason?.trim() || null, createdById: user.id },
        update: { baseSalaryMnt, reason: opts.reason?.trim() || null, createdById: user.id },
      });
      // The user row mirrors the salary in force this month (shown in lists).
      const current = await tx.salaryRate.findFirst({ where: { userId, fromMonth: { lte: periodMonthNow() } }, orderBy: { fromMonth: 'desc' } });
      await tx.user.update({ where: { id: userId }, data: { baseSalaryMnt: current ? current.baseSalaryMnt : null } });
    });
    this.log.log(`Base salary of ${staff.fullName} from ${fromMonth} set to ${baseSalaryMnt ?? 'none'} by ${user.id}`);
    await audit(this.prisma, {
      entityType: 'SALARY',
      entityId: userId,
      summary: `${staff.fullName}: үндсэн цалин ${fromMonth} сараас`,
      before: { amountMnt: before },
      after: { amountMnt: baseSalaryMnt },
      reason: opts.reason?.trim() || undefined,
      actorId: user.id,
    });
    return { userId, fromMonth, baseSalaryMnt };
  }

  /** Salary history of one person (newest first). */
  async salaryHistory(userId: string, user: AuthUser) {
    this.assertManager(user);
    await this.assertStaffInScope(user, userId);
    const rows = await this.prisma.salaryRate.findMany({
      where: { userId },
      orderBy: { fromMonth: 'desc' },
      include: { createdBy: { select: { fullName: true } } },
    });
    return rows
      .sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))
      .map((r) => (r.fromMonth === '2000-01' && r.createdById === r.userId ? { ...r, createdBy: null, carriedOver: true } : r));
  }

  /** Own base salary in force in a month: the latest rate from that month or before; none = not set. */
  private async baseOn(userId: string, periodMonth: string, legacy: number | null) {
    const rates = await this.prisma.salaryRate.findMany({ where: { userId }, orderBy: { fromMonth: 'desc' } });
    return HrService.pickBase(rates, periodMonth, legacy);
  }

  static pickBase(rates: Array<{ fromMonth: string; baseSalaryMnt: number | null }>, periodMonth: string, legacy: number | null) {
    if (!rates.length) return legacy; // salaries set before history was kept
    const r = rates.filter((x) => x.fromMonth <= periodMonth).sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0];
    return r ? r.baseSalaryMnt : null;
  }

  /** A one-off bonus (+) or deduction (−) for an unpaid month. */
  async addAdjustment(dto: PayrollAdjustmentDto, user: AuthUser) {
    this.assertManager(user);
    monthBounds(dto.periodMonth);
    if (!dto.amountMnt) throw new BadRequestException('Дүн 0 байж болохгүй / Amount cannot be 0');
    await this.assertStaffInScope(user, dto.userId);
    if (dto.userId === user.id && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Өөртөө урамшуулал/суутгал бичихгүй / You cannot adjust your own pay');
    }
    const staff = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.assertMonthOpen(dto.userId, dto.periodMonth);
    const row = await this.prisma.payrollAdjustment.create({
      data: { userId: dto.userId, periodMonth: dto.periodMonth, amountMnt: dto.amountMnt, reason: dto.reason.trim(), createdById: user.id },
    });
    await audit(this.prisma, {
      entityType: 'SALARY',
      entityId: dto.userId,
      summary: `${staff.fullName} ${dto.periodMonth}: ${dto.amountMnt > 0 ? 'урамшуулал' : 'суутгал'} нэмсэн`,
      before: { amountMnt: null },
      after: { amountMnt: dto.amountMnt },
      reason: dto.reason.trim(),
      actorId: user.id,
    });
    return row;
  }

  async removeAdjustment(id: string, user: AuthUser) {
    this.assertManager(user);
    const row = await this.prisma.payrollAdjustment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Adjustment not found');
    await this.assertStaffInScope(user, row.userId);
    if (row.userId === user.id && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Өөртөө урамшуулал/суутгал бичихгүй / You cannot adjust your own pay');
    }
    await this.assertMonthOpen(row.userId, row.periodMonth);
    await this.prisma.payrollAdjustment.delete({ where: { id } });
    await audit(this.prisma, {
      entityType: 'SALARY',
      entityId: row.userId,
      summary: `${row.periodMonth}: ${row.amountMnt > 0 ? 'урамшуулал' : 'суутгал'} устгасан`,
      before: { amountMnt: row.amountMnt },
      after: { amountMnt: null },
      reason: row.reason,
      actorId: user.id,
    });
    return { removed: id };
  }

  private async assertMonthOpen(userId: string, periodMonth: string) {
    const row = await this.prisma.payroll.findUnique({ where: { userId_periodMonth: { userId, periodMonth } } });
    if (row?.status === PayrollStatus.PAID) {
      throw new BadRequestException(
        `${periodMonth} сарын цалинг «олгосон» гэж тэмдэглэсэн тул энэ сарын ирцийг өөрчлөхгүй. Буруу тэмдэглэсэн бол админ «Цалин» хуудаснаас «Буцааж нээх» дарна / Payroll already paid`,
      );
    }
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
    const formula = await this.formulaOn();
    // Someone who left during the month is still paid for it: deactivated people with attendance or a
    // payroll row in the month are included.
    const [leaverAttendance, leaverRows, monthAdjustments] = await Promise.all([
      this.prisma.attendance
        .findMany({ where: { checkIn: { gte: start, lt: end } }, select: { userId: true, source: true, confirmedAt: true } })
        .then((rows) => rows.filter(counts)),
      this.prisma.payroll.findMany({ where: { periodMonth: period }, select: { userId: true, status: true } }),
      this.prisma.payrollAdjustment.findMany({ where: { periodMonth: period }, select: { userId: true } }),
    ]);
    const workedThisMonth = [...new Set([...leaverAttendance, ...leaverRows].map((r) => r.userId))];
    // Signs that someone really was there that month (a draft row made by just opening the month is not one).
    const inMonth = [
      ...new Set([...leaverAttendance, ...monthAdjustments, ...leaverRows.filter((r) => r.status === PayrollStatus.PAID)].map((r) => r.userId)),
    ];
    const staff = await this.prisma.user.findMany({
      where: {
        AND: [
          { username: { not: WEBSHOP_USERNAME } },
          { OR: [{ isActive: true }, { id: { in: workedThisMonth } }] },
          // Someone registered after the month is not in it.
          { OR: [{ createdAt: { lt: end } }, { id: { in: inMonth } }] },
          await this.staffScope(user),
        ],
      },
      orderBy: { fullName: 'asc' },
    });
    const ids = staff.map((m) => m.id);
    const allRates = await this.prisma.salaryRate.findMany({ where: { userId: { in: ids } } });

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
        select: { amountMnt: true, recordedById: true, order: { select: { createdById: true } } },
      }),
      this.prisma.salesReturn.findMany({
        where: { createdAt: { gte: start, lt: end }, refundMethod: { notIn: [PayMethod.CREDIT, PayMethod.OFFSET] } },
        select: { refundAmount: true, createdById: true, order: { select: { createdById: true } } },
      }),
      this.prisma.attendance.findMany({
        where: { userId: { in: ids }, checkIn: { gte: start, lt: end } },
        select: { userId: true, checkIn: true, source: true, confirmedAt: true },
      }),
      this.prisma.payrollAdjustment.findMany({
        where: { userId: { in: ids }, periodMonth: period },
        include: { createdBy: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const ticketMap = new Map(tickets.map((t) => [t.preparedById!, t._count._all]));
    const salesBy = new Map<string, number>();
    // Credited like the daily report and the cash drawer: to whoever took the money (or handed it back);
    // older rows without that fall back to whoever made the order.
    const credit = (id: string, amount: number) => salesBy.set(id, (salesBy.get(id) ?? 0) + amount);
    for (const p of sales) credit(p.recordedById ?? p.order.createdById, p.amountMnt);
    for (const r of refunds) credit(r.createdById ?? r.order.createdById, -r.refundAmount);
    const daysBy = new Map<string, Set<string>>();
    // Self check-ins nobody confirmed are not days at work yet.
    for (const a of attendance.filter(counts)) {
      const set = daysBy.get(a.userId) ?? new Set<string>();
      set.add(ymdInUlaanbaatar(a.checkIn));
      daysBy.set(a.userId, set);
    }
    const att = await this.attendanceSettings();
    const workingDays = countWorkingDays(period, settings.workDaysPerWeek, att.holidays);
    // Day statuses (тасалсан, чөлөө…) are shown next to the pay for the manager; they do not change it by
    // themselves — how each one is paid is the owner's decision (bonuses/deductions are written by hand).
    const monthMarks = await this.prisma.attendanceDay.findMany({ where: { userId: { in: ids }, date: { startsWith: period } }, select: { userId: true, mark: true } });
    const marksBy = new Map<string, Partial<Record<DayMark, number>>>();
    for (const m of monthMarks) {
      const c = marksBy.get(m.userId) ?? {};
      c[m.mark] = (c[m.mark] ?? 0) + 1;
      marksBy.set(m.userId, c);
    }

    const rows = [];
    for (const member of staff) {
      const own = HrService.pickBase(
        allRates.filter((r) => r.userId === member.id),
        period,
        member.baseSalaryMnt,
      );
      const base = own ?? (formula ? (settings.defaultBaseMnt[member.role] ?? 0) : 0);
      const workedDays = daysBy.get(member.id)?.size ?? 0;
      const earnedBase =
        formula && settings.prorateByAttendance && workingDays > 0
          ? Math.round((base * Math.min(workedDays, workingDays)) / workingDays)
          : base;
      const ticketCount = ticketMap.get(member.id) ?? 0;
      const ticketBonus = formula ? ticketCount * settings.ticketBonusMnt : 0;
      const salesAmountMnt = Math.max(0, salesBy.get(member.id) ?? 0);
      const salesBonus =
        formula && member.role === Role.BORLUULAGCH ? Math.round((salesAmountMnt * settings.salesCommissionPct) / 100) : 0;
      const mine = adjustments.filter((a) => a.userId === member.id);
      const adjustmentsMnt = mine.reduce((s, a) => s + a.amountMnt, 0);
      const grossSalary = earnedBase + ticketBonus + salesBonus + adjustmentsMnt;
      const socialInsuranceMnt = formula ? Math.max(0, Math.round((grossSalary * settings.socialInsurancePct) / 100)) : 0;
      const incomeTaxMnt = formula ? Math.max(0, Math.round(((grossSalary - socialInsuranceMnt) * settings.incomeTaxPct) / 100)) : 0;
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
        customBase: own !== null,
        attendanceMarks: marksBy.get(member.id) ?? {},
        bonusMnt: mine.filter((a) => a.amountMnt > 0).reduce((s, a) => s + a.amountMnt, 0),
        deductionMnt: mine.filter((a) => a.amountMnt < 0).reduce((s, a) => s - a.amountMnt, 0),
        adjustments: mine.map((a) => ({ id: a.id, amountMnt: a.amountMnt, reason: a.reason, createdAt: a.createdAt, by: a.createdBy?.fullName ?? '' })),
        user: { id: member.id, fullName: member.fullName, username: member.username, role: member.role, isActive: member.isActive },
      });
    }

    const totals = { base: 0, bonus: 0, deduction: 0, gross: 0, net: 0, insurance: 0, tax: 0, paid: 0, unpaid: 0 };
    for (const r of rows) {
      totals.base += r.earnedBase;
      totals.bonus += r.bonusMnt + r.ticketBonus + r.salesBonus;
      totals.deduction += r.deductionMnt;
      if (r.status === PayrollStatus.PAID) totals.paid += r.netSalary;
      else totals.unpaid += r.netSalary;
      totals.gross += r.grossSalary;
      totals.net += r.netSalary;
      totals.insurance += r.socialInsuranceMnt;
      totals.tax += r.incomeTaxMnt;
    }
    this.log.log(`Payroll calculated period=${period} staff=${rows.length} by ${user.fullName ?? user.name}`);
    return { periodMonth: period, timeZone: UB_TZ, formula, settings, workingDays, totals, rows };
  }

  async markPaid(id: string, user: AuthUser) {
    this.assertPayroller(user, 'mark payroll as paid');
    const found = await this.prisma.payroll.findUnique({ where: { id }, include: { user: true } });
    if (!found) throw new NotFoundException('Payroll row not found');
    if (found.status === PayrollStatus.PAID) return found;
    // Bonuses, salary changes or sales may have come in since the page was opened: recalculate the month
    // first so what is frozen as paid is the current amount, then claim the row only while it is still DRAFT.
    await this.payroll(user, found.periodMonth);
    const claimed = await this.prisma.payroll.updateMany({
      where: { id, status: PayrollStatus.DRAFT },
      data: { status: PayrollStatus.PAID, paidAt: new Date(), paidById: user.id },
    });
    const updated = await this.prisma.payroll.findUniqueOrThrow({
      where: { id },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
    });
    if (claimed.count === 1) {
      this.log.log(`Payroll PAID ${updated.periodMonth} ${updated.user.fullName} amount=${updated.netSalary} by ${user.id}`);
      await audit(this.prisma, {
        entityType: 'SALARY',
        entityId: updated.userId,
        summary: `${updated.user.fullName}: ${updated.periodMonth} сарын цалинг олгосон гэж тэмдэглэв (гарт ${updated.netSalary}₮)`,
        after: { status: PayrollStatus.PAID, netSalary: updated.netSalary },
        actorId: user.id,
      });
    }
    return updated;
  }

  /**
   * Undoes «олгосон» (marked by mistake, or before the month was over): the row is recalculated again and the
   * month's attendance can be changed. Marking paid records nothing else (no cash or ledger entry), so nothing
   * else needs undoing; the reason stays in the edit history.
   */
  async reopenPaid(id: string, reason: string, user: AuthUser) {
    this.assertPayroller(user, 'reopen a paid payroll');
    const why = (reason ?? '').trim();
    if (why.length < 3) throw new BadRequestException('Шалтгаанаа бичнэ үү / A reason is required');
    const found = await this.prisma.payroll.findUnique({ where: { id }, include: { user: { select: { fullName: true, role: true } } } });
    if (!found) throw new NotFoundException('Payroll row not found');
    // As for setting a salary: one's own pay and a top role's are reopened by the admin only.
    if (user.role !== Role.ADMIN && (found.userId === user.id || isTopRole(found.user.role))) {
      throw new ForbiddenException('Өөрийн болон ерөнхий менежер, админы цалинг зөвхөн админ буцааж нээнэ / Only admin reopens this payroll');
    }
    if (found.status === PayrollStatus.PAID) {
      const reopened = await this.prisma.payroll.updateMany({
        where: { id, status: PayrollStatus.PAID },
        data: { status: PayrollStatus.DRAFT, paidAt: null, paidById: null },
      });
      if (reopened.count === 1) {
        await audit(this.prisma, {
          entityType: 'SALARY',
          entityId: found.userId,
          summary: `${found.user.fullName}: ${found.periodMonth} сарын цалинг «олгосон»-оос буцааж нээв`,
          before: { status: found.status, paidAt: found.paidAt, paidById: found.paidById, netSalary: found.netSalary },
          after: { status: PayrollStatus.DRAFT },
          reason: why,
          actorId: user.id,
        });
        this.log.log(`Payroll REOPENED ${found.periodMonth} ${found.user.fullName} by ${user.id}`);
      }
    }
    return this.prisma.payroll.findUniqueOrThrow({
      where: { id },
      include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
    });
  }
}
