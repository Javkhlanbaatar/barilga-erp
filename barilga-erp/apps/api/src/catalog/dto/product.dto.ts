import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

function emptyToNull(value: unknown) {
  if (value === '' || value === undefined) return null;
  return value;
}

export class CreateProductDto {
  @IsString()
  sku!: string;
  @IsString()
  nameMn!: string;
  @IsString()
  nameEn!: string;
  @IsString()
  unit!: string;
  @IsInt()
  @Min(0)
  priceMnt!: number;
  @IsNumber()
  weightKg!: number;
  @IsNumber()
  lengthM!: number;
  @IsNumber()
  volumeM3!: number;
  @IsNumber()
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
  @IsOptional()
  @IsString()
  category?: string;
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  sku?: string;
  @IsOptional()
  @IsString()
  nameMn?: string;
  @IsOptional()
  @IsString()
  nameEn?: string;
  @IsOptional()
  @IsString()
  unit?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  priceMnt?: number;
  @IsOptional()
  @IsNumber()
  weightKg?: number;
  @IsOptional()
  @IsNumber()
  lengthM?: number;
  @IsOptional()
  @IsNumber()
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
  @IsString()
  category?: string;
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
