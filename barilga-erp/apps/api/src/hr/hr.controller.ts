import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { OVERSIGHT_ROLES, TOP_ROLES } from '../auth/rbac';
import { AttendanceFixDto, AttendanceSettingsDto, BaseSalaryDto, PayrollAdjustmentDto, PayrollQueryDto, PayrollSettingsDto, StaffPunchDto } from './dto/hr.dto';
import { HrService } from './hr.service';

@Controller('hr')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('HR')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @Get('attendance')
  @Permission('ATTENDANCE_MANAGE')
  attendance(@CurrentUser() user: AuthUser) {
    return this.hr.board(user);
  }

  @Get('attendance/month')
  @Permission('ATTENDANCE_MANAGE')
  attendanceMonth(@CurrentUser() user: AuthUser, @Query() query: PayrollQueryDto) {
    return this.hr.attendanceMonth(user, query.periodMonth);
  }

  @Get('attendance/settings')
  @Roles(...OVERSIGHT_ROLES)
  attendanceSettings() {
    return this.hr.attendanceSettings();
  }

  @Put('attendance/settings')
  @Roles(Role.ADMIN)
  saveAttendanceSettings(@Body() dto: AttendanceSettingsDto, @CurrentUser() user: AuthUser) {
    return this.hr.saveAttendanceSettings(dto, user);
  }

  /** Correct a record (forgotten check-out, wrong time); kept in the edits report. */
  @Patch('attendance/:id')
  @Permission('ATTENDANCE_MANAGE')
  fixAttendance(@Param('id') id: string, @Body() dto: AttendanceFixDto, @CurrentUser() user: AuthUser) {
    return this.hr.fixAttendance(id, dto, user);
  }

  @Post('check-in')
  @Permission('ATTENDANCE_MANAGE')
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: StaffPunchDto) {
    return this.hr.checkIn(user, dto);
  }

  @Post('check-out')
  @Permission('ATTENDANCE_MANAGE')
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
  @Permission('SALARY_SET')
  setBaseSalary(@Param('userId') userId: string, @Body() dto: BaseSalaryDto, @CurrentUser() user: AuthUser) {
    if (dto.baseSalaryMnt === undefined) throw new BadRequestException('baseSalaryMnt is required');
    return this.hr.setBaseSalary(userId, dto.baseSalaryMnt, user, { fromMonth: dto.fromMonth, reason: dto.reason });
  }

  @Get('payroll/salary/:userId')
  @Roles(...OVERSIGHT_ROLES)
  salaryHistory(@Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.hr.salaryHistory(userId, user);
  }

  @Post('payroll/adjustments')
  @Permission('PAYROLL_ADJUST')
  addAdjustment(@Body() dto: PayrollAdjustmentDto, @CurrentUser() user: AuthUser) {
    return this.hr.addAdjustment(dto, user);
  }

  @Delete('payroll/adjustments/:id')
  @Permission('PAYROLL_ADJUST')
  removeAdjustment(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.hr.removeAdjustment(id, user);
  }

  @Patch('payroll/:id/pay')
  @Permission('SALARY_SET')
  markPaid(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.hr.markPaid(id, user);
  }
}
