import { CustomerType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const PHONE = /^[0-9+\-\s]{8,15}$/;

export class CreateCustomerDto {
  @IsEnum(CustomerType)
  type!: CustomerType;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @Transform(trim)
  @Matches(PHONE, { message: 'phone must be 8–15 digits' })
  phone!: string;

  /** Required for companies (РД); optional for individuals. Format is checked in the service per type. */
  @IsOptional()
  @Transform(upper)
  @IsString()
  @MaxLength(20)
  regNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(PHONE, { message: 'phone must be 8–15 digits' })
  phone?: string;

  @IsOptional()
  @Transform(upper)
  @IsString()
  @MaxLength(20)
  regNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Deactivating hides the customer from POS search; managers/admin only (checked in the service). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
