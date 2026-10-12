import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { OVERSIGHT_ROLES } from '../auth/rbac';
import { PayrollQueryDto, StaffPunchDto } from './dto/hr.dto';
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

  @Patch('payroll/:id/pay')
  @Roles(Role.ADMIN)
  markPaid(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.hr.markPaid(id, user);
  }
}
