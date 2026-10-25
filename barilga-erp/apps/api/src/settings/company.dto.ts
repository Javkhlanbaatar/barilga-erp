import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class BankAccountDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  bankName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  accountNumber!: string;

  /** Account holder name as the bank shows it. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  accountName?: string;
}

/** Seller details printed on invoices (нэхэмжлэх) and receipts. */
export class CompanySettingsDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  regNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => BankAccountDto)
  bankAccounts?: BankAccountDto[];

  /** Printed at the bottom of invoices, e.g. payment terms. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(600)
  invoiceNote?: string;

  /** Printed at the bottom of sales receipts, e.g. return policy. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(400)
  receiptFooter?: string;

  /** Print the company logo faintly behind invoices and receipts (needs an uploaded logo). */
  @IsOptional()
  @IsBoolean()
  watermark?: boolean;
}
