import { applyDecorators } from '@nestjs/common';
import { DayMark } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const YMD_MESSAGE = 'Огноо YYYY-MM-DD хэлбэртэй бодит өдөр байна / date must be a real YYYY-MM-DD day';
/** A calendar day written YYYY-MM-DD that exists (no 2026-10-32 or 2026-02-30). */
const Ymd = (each = false) =>
  applyDecorators(Matches(/^\d{4}-\d{2}-\d{2}$/, { each, message: YMD_MESSAGE }), IsISO8601({ strict: true }, { each, message: YMD_MESSAGE }));

export class StaffPunchDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}

export class PayrollQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth?: string;
}

export class RoleSalariesDto {
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) ADMIN?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) SUPER_MANAGER?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) MANAGER?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) BORLUULAGCH?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) ACHIGCH_BELTGEGCH?: number;
}

export class PayrollSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RoleSalariesDto)
  defaultBaseMnt?: RoleSalariesDto;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) ticketBonusMnt?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) salesCommissionPct?: number;
  @IsOptional() @IsBoolean() prorateByAttendance?: boolean;
  @IsOptional() @IsInt() @Min(5) @Max(7) workDaysPerWeek?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) socialInsurancePct?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) incomeTaxPct?: number;
}

export class BaseSalaryDto {
  /** null = no own salary from that month (role default with the formula on). Required: an empty body must not wipe a salary. */
  @ValidateIf((o: BaseSalaryDto) => o.baseSalaryMnt !== null)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  baseSalaryMnt!: number | null;

  /** First month (YYYY-MM) it applies to; default this month. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  fromMonth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class AttendanceFixDto {
  @IsOptional()
  @IsDateString()
  checkIn?: string;

  /** null = still at work (re-opens the record). */
  @ValidateIf((o: AttendanceFixDto) => o.checkOut !== null && o.checkOut !== undefined)
  @IsDateString()
  checkOut?: string | null;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

export class AttendanceSettingsDto {
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time must be HH:MM' }) shiftStart?: string;
  @IsOptional() @IsInt() @Min(0) @Max(180) graceMinutes?: number;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time must be HH:MM' }) shiftEnd?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(24) overtimeAfterHours?: number;
  /** OFF = only managers record; CONFIRM = staff record, a manager confirms; AUTO = counted at once. */
  @IsOptional() @IsIn(['OFF', 'CONFIRM', 'AUTO']) selfCheckIn?: 'OFF' | 'CONFIRM' | 'AUTO';
  /** Public holidays, YYYY-MM-DD. */
  @IsOptional() @IsArray() @ArrayMaxSize(60) @Ymd(true) holidays?: string[];
}

/** A record added by hand (someone was at work but nobody pressed «Ирсэн»). */
export class AttendanceAddDto {
  @IsString() @MaxLength(64) userId!: string;
  @IsDateString() checkIn!: string;
  @IsOptional() @IsDateString() checkOut?: string;
  @IsString() @MinLength(3) @MaxLength(200) reason!: string;
}

export class AttendanceDeleteDto {
  @IsString() @MinLength(3) @MaxLength(200) reason!: string;
}

/** A whole day's status for one person, set by a manager. */
export class DayMarkDto {
  @IsString() @MaxLength(64) userId!: string;
  @IsString() @Ymd() date!: string;
  @IsEnum(DayMark) mark!: DayMark;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** An employee asks for leave for some days. */
export class LeaveRequestDto {
  @IsIn([DayMark.PAID_LEAVE, DayMark.UNPAID_LEAVE, DayMark.SICK, DayMark.ANNUAL_LEAVE, DayMark.BUSINESS_TRIP])
  kind!: DayMark;
  @IsString() @Ymd() fromDate!: string;
  @IsString() @Ymd() toDate!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class LeaveDecisionDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ConfirmPunchesDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids!: string[];
}

export class PayrollAdjustmentDto {
  @IsString()
  userId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth!: string;

  /** + bonus, − deduction (advance, fine…). */
  @IsInt()
  @Min(-100_000_000)
  @Max(100_000_000)
  amountMnt!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

export class PayrollReopenDto {
  @IsString() @MinLength(3) @MaxLength(200) reason!: string;
}

/** A manager cancels an approved leave, or shortens it to end on toDate. */
export class LeaveCancelDto {
  @IsOptional() @IsString() @Ymd() toDate?: string;
  @IsString() @MinLength(3) @MaxLength(300) note!: string;
}
