import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const trimOrUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? undefined : v;
};

export class CreateInvoiceDto {
  @IsUUID()
  orderId!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value))
  @IsEmail()
  recipientEmail?: string;

  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(40)
  recipientPhone?: string;

  /** YYYY-MM-DD; the last day to pay. */
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export const SEND_CHANNELS = ['LINK', 'EMAIL', 'PRINT'] as const;

export class MarkInvoiceSentDto {
  @IsIn(SEND_CHANNELS)
  via!: (typeof SEND_CHANNELS)[number];
}
