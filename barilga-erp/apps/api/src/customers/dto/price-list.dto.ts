import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreatePriceListDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class UpdatePriceListDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** YYYY-MM-DD printed as "valid until"; null clears it. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'validUntil must be YYYY-MM-DD' })
  validUntil?: string | null;
}

export class ListPriceDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  /** Price in ₮; null removes the product from the list (it then sells at retail). */
  @ValidateIf((o: ListPriceDto) => o.priceMnt !== null)
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  priceMnt!: number | null;
}

export class SetPricesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ListPriceDto)
  prices!: ListPriceDto[];
}
