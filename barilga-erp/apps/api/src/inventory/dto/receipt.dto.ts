import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ReceiptItemDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Max(1_000_000)
  quantity!: number;

  /** Optional purchase price per unit (₮). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  unitCostMnt?: number;
}

export class CreateReceiptDto {
  @IsString()
  @MaxLength(64)
  warehouseId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  supplierName!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  supplierInvoiceNo?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ReceiptItemDto)
  items!: ReceiptItemDto[];
}
