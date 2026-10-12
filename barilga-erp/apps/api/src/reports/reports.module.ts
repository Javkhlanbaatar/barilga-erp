import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { WarehouseReportService } from './warehouse-report.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, WarehouseReportService],
})
export class ReportsModule {}
