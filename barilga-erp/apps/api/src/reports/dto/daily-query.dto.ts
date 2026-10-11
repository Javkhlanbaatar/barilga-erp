import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class DailyQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsUUID()
  cashierId?: string;
}
