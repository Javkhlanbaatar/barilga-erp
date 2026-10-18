import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { REPORT_ROLES } from '../auth/rbac';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { DailyQueryDto } from './dto/daily-query.dto';
import { WarehouseReportQueryDto } from './dto/warehouse-query.dto';
import { EditsReportService } from './edits-report.service';
import { ReturnsReportService } from './returns-report.service';
import { PartnerReportsService } from './partner-reports.service';
import { FulfillmentReportService } from './fulfillment-report.service';
import { ReportsService } from './reports.service';
import { WarehouseReportService } from './warehouse-report.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly warehouseReport: WarehouseReportService,
    private readonly fulfillmentReport: FulfillmentReportService,
    private readonly editsReport: EditsReportService,
    private readonly returnsReport: ReturnsReportService,
    private readonly partnerReports: PartnerReportsService,
  ) {}

  @Get('daily')
  @Roles(...REPORT_ROLES)
  daily(@Query() query: DailyQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.daily(query, user);
  }

  @Get('cashiers')
  @Roles(Role.ADMIN, Role.MANAGER)
  cashiers(@CurrentUser() user: AuthUser) {
    return this.reports.listCashiers(user);
  }

  /** Stock in/out per product for a warehouse and date range (warehouse staff: their own warehouse). */
  @Get('warehouse')
  @Roles(Role.ADMIN, Role.MANAGER, Role.ACHIGCH_BELTGEGCH)
  @RequireFeature('WAREHOUSE_REPORT')
  warehouse(@Query() query: WarehouseReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.warehouseReport.report(query, user);
  }

  /** Preparation times: paid → started → completed, per order and per person (managers/admin). */
  @Get('fulfillment')
  @Roles(Role.ADMIN, Role.MANAGER)
  @RequireFeature('PICKING')
  fulfillment(@Query() query: WarehouseReportQueryDto) {
    return this.fulfillmentReport.report(query);
  }

  /** Returns in a date range: goods, reasons, refunds and whether they were paid out. */
  @Get('returns')
  @Roles(Role.ADMIN, Role.MANAGER)
  returns(@Query() query: WarehouseReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.returnsReport.report(query, user);
  }

  /** Who owes us and for how long (0–30 / 31–60 / 61–90 / 90+ days). */
  @Get('partners/aging')
  @Roles(Role.ADMIN, Role.MANAGER)
  partnerAging(@CurrentUser() user: AuthUser) {
    return this.partnerReports.aging(user);
  }

  /** Sales per customer for a period. */
  @Get('partners/sales')
  @Roles(Role.ADMIN, Role.MANAGER)
  partnerSales(@Query() query: WarehouseReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.partnerReports.salesByCustomer(query, user);
  }

  /** Purchases per supplier for a period. */
  @Get('partners/purchases')
  @Roles(Role.ADMIN, Role.MANAGER)
  partnerPurchases(@Query() query: WarehouseReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.partnerReports.purchasesBySupplier(query, user);
  }

  /** Later edits of money figures, settings, users and salaries: admin and the general manager. */
  @Get('edits')
  @Roles(Role.ADMIN, Role.SUPER_MANAGER)
  edits(@Query() query: WarehouseReportQueryDto) {
    return this.editsReport.report(query);
  }
}
