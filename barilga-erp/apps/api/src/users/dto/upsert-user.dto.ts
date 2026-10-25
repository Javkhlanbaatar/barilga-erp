import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function emptyToUndef(value: unknown) {
  if (value === '' || value === undefined || value === null) return undefined;
  return value;
}

export class CreateUserDto {
  @IsString()
  @Matches(USERNAME_RE, { message: 'Username must be 3–32 letters, numbers, dot, dash, or underscore' })
  username!: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndef(value))
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @Transform(({ obj, value }) => value || obj.name)
  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(Role)
  role!: Role;

  /** Warehouse/shop the user works in (staff roles are limited to it). Empty = not assigned. */
  @IsOptional()
  @Transform(({ value }) => emptyToUndef(value))
  @IsString()
  warehouseId?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(USERNAME_RE, { message: 'Username must be 3–32 letters, numbers, dot, dash, or underscore' })
  username?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @Transform(({ obj, value }) => value || obj.name)
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** A warehouse id, or "" / null to clear the assignment. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  warehouseId?: string | null;

  @IsOptional()
  @Transform(({ obj, value }) => (value === undefined ? obj.active : value))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class UpdateUserStatusDto {
  @Transform(({ obj, value }) => (value === undefined ? obj.active : value))
  @IsBoolean()
  isActive!: boolean;
}
