import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

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
