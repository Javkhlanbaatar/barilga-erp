import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The whole list of product categories offered in the product form (барааны ангилал). The service trims, drops
 * empty lines, 'General' and repeats (any letter case), then checks 1–60 characters each and at most 100 categories.
 */
export class CategoriesDto {
  @IsArray({ message: 'Ангиллын жагсаалт илгээнэ үү / categories must be a list' })
  @ArrayMaxSize(300)
  @IsString({ each: true, message: 'Ангилал бичвэр байна / each category must be text' })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value))
  categories!: string[];
}

/** One category added from the product form ('+ шинэ ангилал'). */
export class AddCategoryDto {
  @Transform(trim)
  @IsString({ message: 'Ангиллаа оруулна уу / category is required' })
  @MinLength(1, { message: 'Ангиллаа оруулна уу / category is required' })
  @MaxLength(60, { message: 'Ангилал 60 тэмдэгтээс ихгүй / category must be at most 60 characters' })
  category!: string;
}
