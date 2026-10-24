import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

function emptyToNull(value: unknown) {
  if (value === '' || value === undefined) return null;
  return value;
}

/**
 * One item handed over with every unit sold, e.g. { name: 'Хатаагч', qtyPerUnit: 1, unit: 'ш' }.
 * It may be picked from the catalog (`productId`); then a name or unit left empty is copied from that product.
 * Display only: printed on tickets and pick lists, never a stock line, a price or an order line.
 */
export class CompanionDto {
  /** The catalog product this item is, when it was picked from the list. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(64)
  productId?: string | null;

  /** Required unless a product is picked (then empty = the product's name). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: CompanionDto) => !o.productId || (o.name !== undefined && o.name !== null && o.name !== ''))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(1000)
  qtyPerUnit!: number;

  /** Empty = 'ш', or the picked product's unit. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: CompanionDto) => !o.productId || (o.unit !== undefined && o.unit !== null))
  @IsString()
  @MaxLength(16)
  unit!: string;
}

export class CreateProductDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  /** Manufacturer barcode; empty = an in-store EAN-13 is assigned. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s+/g, '') : value))
  @ValidateIf((_o, v) => v !== '' && v !== null)
  @Matches(/^[0-9A-Za-z-]{4,32}$/, { message: 'Баркод 4–32 тэмдэгт (тоо, латин үсэг) / Barcode must be 4–32 letters or digits' })
  barcode?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  nameMn!: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(160)
  nameEn!: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  unit!: string;
  @IsInt()
  @Min(0)
  priceMnt!: number;
  /** Every product is registered with its weight (delivery vehicle and unloading fee depend on it). */
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Жинг кг-аар, 3 хүртэлх бутархай оронтой оруулна уу / weightKg: a number with at most 3 decimals' })
  @Min(0.001, { message: 'Жинг кг-аар оруулна уу (0-ээс их) / weightKg must be greater than 0' })
  @Max(100_000)
  weightKg!: number;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  lengthM!: number;
  /** Package width / height (m), optional; with the length they give the volume. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  widthM?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  heightM?: number | null;
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1000)
  volumeM3!: number;
  @IsNumber()
  @Min(0)
  stockQty!: number;
  /** Warehouse that receives the starting quantity (defaults to the user's, then the default warehouse). */
  @IsOptional()
  @IsString()
  warehouseId?: string;
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStockLevel?: number;
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  imageUrl?: string | null;
  @IsOptional()
  @Transform(({ value }) => emptyToNull(typeof value === 'string' ? value.trim() : value))
  @IsString()
  description?: string | null;
  /** Required: products are always filed under a category (price sheets and reports group by it). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ангиллаа сонгоно уу / category is required' })
  @MinLength(1, { message: 'Ангиллаа сонгоно уу / category is required' })
  @MaxLength(60)
  category!: string;
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Items that go out with this product (e.g. a hardener with resin paint). Empty / null = none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CompanionDto)
  companions?: CompanionDto[] | null;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  sku?: string;

  /** Manufacturer barcode; empty = an in-store EAN-13 is assigned. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s+/g, '') : value))
  @ValidateIf((_o, v) => v !== '' && v !== null)
  @Matches(/^[0-9A-Za-z-]{4,32}$/, { message: 'Баркод 4–32 тэмдэгт (тоо, латин үсэг) / Barcode must be 4–32 letters or digits' })
  barcode?: string | null;

  @IsOptional()
  @IsString()
  nameMn?: string;
  @IsOptional()
  @IsString()
  nameEn?: string;
  /** Same check as on create; a unit missing from the saved list (Тохиргоо → хэмжих нэгж) is still accepted. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  unit?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  priceMnt?: number;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Жинг кг-аар, 3 хүртэлх бутархай оронтой оруулна уу / weightKg: a number with at most 3 decimals' })
  @Min(0.001, { message: 'Жинг кг-аар оруулна уу (0-ээс их) / weightKg must be greater than 0' })
  @Max(100_000)
  weightKg?: number;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  lengthM?: number;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  widthM?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  heightM?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1000)
  volumeM3?: number;
  @IsOptional()
  @IsNumber()
  stockQty?: number;
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStockLevel?: number;
  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  imageUrl?: string | null;
  @IsOptional()
  @Transform(({ value }) => emptyToNull(typeof value === 'string' ? value.trim() : value))
  @IsString()
  description?: string | null;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ангиллаа сонгоно уу / category is required' })
  @MinLength(1, { message: 'Ангиллаа сонгоно уу / category is required' })
  @MaxLength(60)
  category?: string;
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Items that go out with this product (e.g. a hardener with resin paint). Empty / null = none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CompanionDto)
  companions?: CompanionDto[] | null;
}
