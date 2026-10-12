import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATALOG_READ_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CompanySettingsDto } from './company.dto';
import { PrintSettingsDto } from './print.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Any staff member can read it: invoices and receipts are printed from the POS and the warehouse. */
  @Get('company')
  @Roles(...CATALOG_READ_ROLES)
  company() {
    return this.settings.company();
  }

  @Put('company')
  @Roles(Role.ADMIN)
  setCompany(@Body() dto: CompanySettingsDto, @CurrentUser() user: AuthUser) {
    return this.settings.setCompany(dto, user.id);
  }

  /** Paper layout per document; everyone reads it so printing never asks again. */
  @Get('print')
  @Roles(...CATALOG_READ_ROLES)
  print() {
    return this.settings.print();
  }

  @Put('print')
  @Roles(Role.ADMIN)
  setPrint(@Body() dto: PrintSettingsDto, @CurrentUser() user: AuthUser) {
    return this.settings.setPrint(dto, user.id);
  }
}
