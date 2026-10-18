import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { OVERSIGHT_ROLES, TOP_ROLES } from '../auth/rbac';
import { BaseSalaryDto, PayrollAdjustmentDto, PayrollQueryDto, PayrollSettingsDto, StaffPunchDto } from './dto/hr.dto';
import { HrService } from './hr.service';

@Controller('hr')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('HR')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @Get('attendance')
  @Roles(...OVERSIGHT_ROLES)
  attendance(@CurrentUser() user: AuthUser) {
    return this.hr.board(user);
  }

  @Post('check-in')
  @Roles(...OVERSIGHT_ROLES)
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: StaffPunchDto) {
    return this.hr.checkIn(user, dto);
  }

  @Post('check-out')
  @Roles(...OVERSIGHT_ROLES)
  checkOut(@CurrentUser() user: AuthUser, @Body() dto: StaffPunchDto) {
    return this.hr.checkOut(user, dto);
  }

  @Get('payroll')
  @Roles(...OVERSIGHT_ROLES)
  payroll(@CurrentUser() user: AuthUser, @Query() query: PayrollQueryDto) {
    return this.hr.payroll(user, query.periodMonth);
  }

  @Get('payroll/settings')
  @Roles(...OVERSIGHT_ROLES)
  payrollSettings() {
    return this.hr.payrollSettings();
  }

  @Put('payroll/settings')
  @Roles(Role.ADMIN)
  savePayrollSettings(@Body() dto: PayrollSettingsDto, @CurrentUser() user: AuthUser) {
    return this.hr.savePayrollSettings(dto, user);
  }

  @Put('payroll/salary/:userId')
  @Roles(...TOP_ROLES)
  setBaseSalary(@Param('userId') userId: string, @Body() dto: BaseSalaryDto, @CurrentUser() user: AuthUser) {
    return this.hr.setBaseSalary(userId, dto.baseSalaryMnt ?? null, user);
  }

  @Post('payroll/adjustments')
  @Roles(...OVERSIGHT_ROLES)
  addAdjustment(@Body() dto: PayrollAdjustmentDto, @CurrentUser() user: AuthUser) {
    return this.hr.addAdjustment(dto, user);
  }

  @Delete('payroll/adjustments/:id')
  @Roles(...OVERSIGHT_ROLES)
  removeAdjustment(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.hr.removeAdjustment(id, user);
  }

  @Patch('payroll/:id/pay')
  @Roles(...TOP_ROLES)
  markPaid(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.hr.markPaid(id, user);
  }
}
