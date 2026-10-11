import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CATALOG_READ_ROLES } from '../auth/rbac';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

class UpdateZoneDto {
  @IsOptional()
  @IsString()
  nameMn?: string;

  @IsOptional()
  @IsString()
  nameEn?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseDeliveryFeeMnt?: number;

  @IsOptional()
  @IsBoolean()
  nightDiscountApplies?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@Controller('zones')
export class ZonesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_READ_ROLES)
  list() {
    return this.prisma.zone.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateZoneDto) {
    return this.prisma.zone.update({ where: { id }, data: dto });
  }
}
