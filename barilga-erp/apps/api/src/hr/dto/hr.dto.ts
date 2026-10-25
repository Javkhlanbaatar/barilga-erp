import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class StaffPunchDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}

export class PayrollQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth?: string;
}
