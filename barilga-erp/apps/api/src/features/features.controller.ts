import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATALOG_READ_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeaturesService } from './features.service';

class SetFeatureDto {
  @IsBoolean()
  enabled!: boolean;
}

@Controller('features')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  /** Every signed-in user may read the switches so the UI can hide modules that are off. */
  @Get()
  @Roles(...CATALOG_READ_ROLES)
  list() {
    return this.features.list();
  }

  @Patch(':key')
  @Roles(Role.ADMIN)
  set(@Param('key') key: string, @Body() dto: SetFeatureDto, @CurrentUser() user: AuthUser) {
    return this.features.set(key, dto.enabled, user.id);
  }
}
