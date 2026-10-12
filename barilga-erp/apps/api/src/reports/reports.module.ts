import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { FulfillmentReportService } from './fulfillment-report.service';
import { ReportsService } from './reports.service';
import { WarehouseReportService } from './warehouse-report.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, WarehouseReportService, FulfillmentReportService],
})
export class ReportsModule {}
