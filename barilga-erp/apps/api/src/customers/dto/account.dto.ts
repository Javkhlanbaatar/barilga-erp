import { AccountEntryKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AddAccountEntryDto {
  /** PURCHASE: we got goods from them · PAYMENT_TO_PARTNER: we paid them · ADJUSTMENT: correction (±). */
  @IsIn([AccountEntryKind.PURCHASE, AccountEntryKind.PAYMENT_TO_PARTNER, AccountEntryKind.ADJUSTMENT])
  kind!: AccountEntryKind;

  /** ₮. Positive for purchases and payments; adjustments may be negative. */
  @IsInt()
  @Min(-2_000_000_000)
  @Max(2_000_000_000)
  amountMnt!: number;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  description!: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}

export class EditAccountEntryDto {
  @IsOptional()
  @IsInt()
  @Min(-2_000_000_000)
  @Max(2_000_000_000)
  amountMnt?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  /** Why it is being changed — kept for the admin's edit report. */
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class OffsetDto {
  /** Leave out to offset as much as possible. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountMnt?: number;
}
