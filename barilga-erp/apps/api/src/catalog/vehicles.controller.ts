import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CATALOG_READ_ROLES } from '../auth/rbac';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  nameMn?: string;

  @IsOptional()
  @IsString()
  nameEn?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxWeightKg?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxLengthM?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxVolumeM3?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_READ_ROLES)
  list() {
    return this.prisma.vehicleType.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateVehicleDto) {
    return this.prisma.vehicleType.update({ where: { id }, data: dto });
  }
}
