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

/** A sheet or a link shows at most this many hand-picked products and categories. */
export const MAX_SHEET_PRODUCTS = 200;
export const MAX_SHEET_CATEGORIES = 100;
/** Product ids are Prisma uuid()s. */
export const PRODUCT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `a,b,c` (or a repeated query key) → ['a', 'b', 'c']; nothing → undefined. Reads the raw value. */
const csv = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
};

/** A repeated query key (or one value) → list, NOT split on commas: a category name may contain one. */
const many = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return (Array.isArray(raw) ? raw : [raw]).map((s) => String(s).trim()).filter(Boolean);
};

/** ?all=true&ids=<id,id>&cat=<category>&cat=<category> on the printable sheets. */
export class PriceSheetQueryDto {
  /** `true` adds the products that are not on the list (at retail). */
  @IsOptional()
  @IsString()
  all?: string;

  /** Only these products (or those in `cat`); empty = no limit. */
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(MAX_SHEET_PRODUCTS, { message: `Нэг удаад ${MAX_SHEET_PRODUCTS} хүртэл бараа сонгоно / Choose at most ${MAX_SHEET_PRODUCTS} products` })
  @Matches(PRODUCT_ID_RE, { each: true, message: 'Барааны дугаар буруу / Invalid product id' })
  ids?: string[];

  /** Only products in these categories (or those in `ids`); repeat ?cat= for several. */
  @IsOptional()
  @Transform(many)
  @IsArray()
  @ArrayMaxSize(MAX_SHEET_CATEGORIES, { message: `Нэг удаад ${MAX_SHEET_CATEGORIES} хүртэл ангилал сонгоно / Choose at most ${MAX_SHEET_CATEGORIES} categories` })
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  cat?: string[];
}

/** A link for a customer: one list (or the retail prices), optionally limited to some products / categories. */
export class CreatePriceShareDto {
  /** The list to share; null = the retail prices. */
  @ValidateIf((_o, v) => v !== null)
  @IsString({ message: 'Үнийн жагсаалтаа сонгоно уу / priceListId is required (null for retail prices)' })
  @MaxLength(64, { message: 'Үнийн жагсаалт олдсонгүй / priceListId is too long' })
  priceListId!: string | null;

  /** Who it is for (shown in the list of links), e.g. the customer's name. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SHEET_PRODUCTS, { message: `Нэг удаад ${MAX_SHEET_PRODUCTS} хүртэл бараа сонгоно / Choose at most ${MAX_SHEET_PRODUCTS} products` })
  @Matches(PRODUCT_ID_RE, { each: true, message: 'Барааны дугаар буруу / Invalid product id' })
  productIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SHEET_CATEGORIES, { message: `Нэг удаад ${MAX_SHEET_CATEGORIES} хүртэл ангилал сонгоно / Choose at most ${MAX_SHEET_CATEGORIES} categories` })
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  categories?: string[];

  /** Also show the products that are not on the list, at retail. */
  @IsOptional()
  @IsBoolean()
  includeUnlisted?: boolean;

  /** YYYY-MM-DD: the link works through this day (Ulaanbaatar time); empty = no end. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дуусах өдрийг ОООО-СС-ӨӨ хэлбэрээр оруулна уу / expiresAt must be YYYY-MM-DD' })
  expiresAt?: string | null;
}

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
