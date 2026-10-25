import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The ID token (credential) Google Identity Services gives the page after the person picks their account. */
export class GoogleCredentialDto {
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  credential!: string;
}

/** Linking a Google account from «Миний бүртгэл»: Google's ID token and the current password. */
export class GoogleLinkDto extends GoogleCredentialDto {
  @IsString()
  @MinLength(1, { message: 'Одоогийн нууц үгээ оруулна уу / currentPassword is required' })
  @MaxLength(200)
  currentPassword!: string;
}

/** Steps that change how one signs in (sign out everywhere, take Google off) ask for the current password. */
export class CurrentPasswordDto {
  @IsString()
  @MinLength(1, { message: 'Одоогийн нууц үгээ оруулна уу / currentPassword is required' })
  @MaxLength(200)
  currentPassword!: string;
}

/** The person changes their own password: the current one first. */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  // bcrypt reads at most 72 bytes; longer would silently ignore the end.
  @IsString()
  @MinLength(8, { message: 'Шинэ нууц үг 8-аас доошгүй тэмдэгт / newPassword must be at least 8 characters' })
  @MaxLength(72, { message: 'Шинэ нууц үг 72-оос ихгүй тэмдэгт / newPassword must be at most 72 characters' })
  newPassword!: string;
}

/** The person's own details. Changing the e-mail (it signs in too) needs the current password. */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Нэр 2-оос доошгүй тэмдэгт / fullName must be at least 2 characters' })
  @MaxLength(80)
  fullName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  phone?: string;

  /** Empty clears it. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @ValidateIf((_o, v) => v !== '')
  @IsEmail({}, { message: 'Имэйл хаяг буруу / email must be an e-mail address' })
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;
}
