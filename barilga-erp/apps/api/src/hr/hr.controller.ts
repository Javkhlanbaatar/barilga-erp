import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { OVERSIGHT_ROLES, TOP_ROLES } from '../auth/rbac';
import {
  AttendanceAddDto,
  AttendanceDeleteDto,
  AttendanceFixDto,
  AttendanceSettingsDto,
  BaseSalaryDto,
  ConfirmPunchesDto,
  DayMarkDto,
  LeaveCancelDto,
  LeaveDecisionDto,
  LeaveRequestDto,
  PayrollAdjustmentDto,
  PayrollQueryDto,
  PayrollReopenDto,
  PayrollSettingsDto,
  StaffPunchDto,
} from './dto/hr.dto';
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

  // ---- The person themselves (any signed-in staff; the admin decides whether self check-in is on)

  @Get('me/attendance')
  myAttendance(@CurrentUser() user: AuthUser, @Query() query: PayrollQueryDto) {
    return this.hr.myAttendance(user, query.periodMonth);
  }

  @Post('me/check-in')
  selfCheckIn(@CurrentUser() user: AuthUser) {
    return this.hr.selfCheckIn(user);
  }

  @Post('me/check-out')
  selfCheckOut(@CurrentUser() user: AuthUser) {
    return this.hr.selfCheckOut(user);
  }

  @Post('me/leave')
  requestLeave(@CurrentUser() user: AuthUser, @Body() dto: LeaveRequestDto) {
    return this.hr.requestLeave(user, dto);
  }

  @Post('me/leave/:id/cancel')
  cancelLeave(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.hr.cancelLeave(user, id);
  }

  // ---- Managers (or anyone given the attendance right)

  @Get('leave')
  @Permission('ATTENDANCE_MANAGE')
  listLeave(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.hr.listLeave(user, status);
  }

  @Post('leave/:id/approve')
  @Permission('ATTENDANCE_MANAGE')
  approveLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LeaveDecisionDto) {
    return this.hr.decideLeave(user, id, true, dto);
  }

  @Post('leave/:id/reject')
  @Permission('ATTENDANCE_MANAGE')
  rejectLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LeaveDecisionDto) {
    return this.hr.decideLeave(user, id, false, dto);
  }

  /** Cancel an approved leave, or shorten it (back early). */
  @Post('leave/:id/cancel')
  @Permission('ATTENDANCE_MANAGE')
  cancelApprovedLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LeaveCancelDto) {
    return this.hr.cancelApprovedLeave(user, id, dto);
  }

  /** One day's status for a person (тасалсан, өвчтэй, чөлөө…). */
  @Put('attendance/days')
  @Permission('ATTENDANCE_MANAGE')
  setDayMark(@CurrentUser() user: AuthUser, @Body() dto: DayMarkDto) {
    return this.hr.setDayMark(user, dto);
  }

  @Delete('attendance/days/:userId/:date')
  @Permission('ATTENDANCE_MANAGE')
  clearDayMark(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Param('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Огноо YYYY-MM-DD хэлбэртэй байна / date must be YYYY-MM-DD');
    return this.hr.clearDayMark(user, userId, date);
  }

  /** Confirm check-ins people recorded themselves. */
  @Post('attendance/confirm')
  @Permission('ATTENDANCE_MANAGE')
  confirmPunches(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPunchesDto) {
    return this.hr.confirmPunches(user, dto.ids);
  }

  /** A record added by hand, with a reason. */
  @Post('attendance')
  @Permission('ATTENDANCE_MANAGE')
  addRecord(@CurrentUser() user: AuthUser, @Body() dto: AttendanceAddDto) {
    return this.hr.addRecord(user, dto);
  }

  @Delete('attendance/:id')
  @Permission('ATTENDANCE_MANAGE')
  deleteRecord(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AttendanceDeleteDto) {
    return this.hr.deleteRecord(user, id, dto.reason);
  }

  @Get('attendance/settings')
  // Also for someone given the attendance right (they need the working day to correct times).
  @Permission('ATTENDANCE_MANAGE', ...OVERSIGHT_ROLES)
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

  /** Undo «олгосон» with a reason (admin or the general manager). */
  @Patch('payroll/:id/reopen')
  @Permission('SALARY_SET')
  reopenPaid(@Param('id') id: string, @Body() dto: PayrollReopenDto, @CurrentUser() user: AuthUser) {
    return this.hr.reopenPaid(id, dto.reason, user);
  }
}
