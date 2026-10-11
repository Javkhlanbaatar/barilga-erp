import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { REPORT_ROLES } from '../auth/rbac';
import { DailyQueryDto } from './dto/daily-query.dto';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
}
