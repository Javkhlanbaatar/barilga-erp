import { WarehouseKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateWarehouseDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,20}$/, { message: 'code must be 2–20 letters, digits, "-" or "_"' })
  code!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  phone?: string;

  /** SHOP = дэлгүүр (sells at the till), WAREHOUSE = агуулах (stores and sends). */
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Only `true` is accepted: it makes this warehouse the default and clears the flag elsewhere. */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class AdjustStockDto {
  @IsString()
  @MaxLength(64)
  warehouseId!: string;

  @IsString()
  @MaxLength(64)
  productId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;

  /** Add (+) or remove (−) this quantity. Give either `delta` or `countedQuantity`. */
  @ValidateIf((o: AdjustStockDto) => o.countedQuantity === undefined)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(-1_000_000)
  @Max(1_000_000)
  delta?: number;

  /** The quantity physically counted; the system works out the difference. */
  @ValidateIf((o: AdjustStockDto) => o.delta === undefined)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1_000_000_000)
  countedQuantity?: number;
}
