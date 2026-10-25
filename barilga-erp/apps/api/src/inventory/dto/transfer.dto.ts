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

/** A line on dispatch: what the sending warehouse actually sends (0 = not sending this one). */
export class DispatchItemDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Max(1_000_000)
  quantity!: number;
}

export class DispatchTransferDto {
  /** Leave out to send exactly what was asked for. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DispatchItemDto)
  items?: DispatchItemDto[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** A line on receipt: what actually arrived; less than sent needs a reason. */
export class ReceiveItemDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Max(1_000_000)
  receivedQty!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ReceiveTransferDto {
  /** Leave out when everything arrived as sent. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items?: ReceiveItemDto[];
}
