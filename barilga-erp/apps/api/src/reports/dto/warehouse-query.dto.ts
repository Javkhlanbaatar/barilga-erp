import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class WarehouseReportQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Omit for all warehouses (managers/admin). Warehouse staff always get their own. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  warehouseId?: string;
}
