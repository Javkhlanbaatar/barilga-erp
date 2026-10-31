import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TransferItemDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Max(1_000_000)
  quantity!: number;
}

export class CreateTransferDto {
  @IsString()
  @MaxLength(64)
  fromWarehouseId!: string;

  @IsString()
  @MaxLength(64)
  toWarehouseId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CancelTransferDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
