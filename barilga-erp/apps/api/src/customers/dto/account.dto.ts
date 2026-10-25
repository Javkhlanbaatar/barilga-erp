import { AccountEntryKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AddAccountEntryDto {
  /**
   * PURCHASE: we got goods/services from them (amount only; goods with quantities go through a receipt) ·
   * PAYMENT_TO_PARTNER: we paid them · CHARGE: they owe us more without an order · ADJUSTMENT: correction (±).
   * Money from them is recorded with the receive action.
   */
  @IsIn([AccountEntryKind.PURCHASE, AccountEntryKind.PAYMENT_TO_PARTNER, AccountEntryKind.CHARGE, AccountEntryKind.ADJUSTMENT])
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

  /** How we paid them (PAYMENT_TO_PARTNER); cash leaves the drawer. */
  @IsOptional()
  @IsIn(['CASH', 'CARD', 'TRANSFER'])
  method?: 'CASH' | 'CARD' | 'TRANSFER';
}

/** The partner paid us: order debts first, the rest is kept as their advance. */
export class ReceiveFromPartnerDto {
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  amountMnt!: number;

  @IsIn(['CASH', 'CARD', 'TRANSFER'])
  method!: 'CASH' | 'CARD' | 'TRANSFER';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class VoidAccountEntryDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
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
