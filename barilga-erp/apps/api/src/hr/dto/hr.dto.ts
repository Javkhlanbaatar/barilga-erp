import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

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
  /** null = back to the role default. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  baseSalaryMnt!: number | null;
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
