import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The whole list of measuring units offered in the product form (хэмжих нэгж). The service trims, drops empty
 * lines and repeats (any letter case), then checks 1–16 characters each and at most 60 units.
 */
export class UnitsDto {
  @IsArray({ message: 'Хэмжих нэгжийн жагсаалт илгээнэ үү / units must be a list' })
  @ArrayMaxSize(200)
  @IsString({ each: true, message: 'Хэмжих нэгж бичвэр байна / each unit must be text' })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value))
  units!: string[];
}

/** One unit added from the product form ('+ шинэ нэгж'). */
export class AddUnitDto {
  @Transform(trim)
  @IsString({ message: 'Хэмжих нэгжээ оруулна уу / unit is required' })
  @MinLength(1, { message: 'Хэмжих нэгжээ оруулна уу / unit is required' })
  @MaxLength(16, { message: 'Хэмжих нэгж 16 тэмдэгтээс ихгүй / unit must be at most 16 characters' })
  unit!: string;
}
