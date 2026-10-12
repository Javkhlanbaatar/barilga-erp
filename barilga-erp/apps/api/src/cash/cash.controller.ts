import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CashMovementKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CashService } from './cash.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class OpenCashDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  openingFloatMnt!: number;
}

export class CashMoveDto {
  @IsEnum(CashMovementKind)
  kind!: CashMovementKind;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amountMnt!: number;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

export class CloseCashDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  countedCashMnt!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  note?: string;
}

@Controller('cash')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('CASH_SESSIONS')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get('current')
  @Roles(...POS_ROLES)
  current(@CurrentUser() user: AuthUser) {
    return this.cash.current(user);
  }

  @Post('open')
  @Roles(...POS_ROLES)
  open(@Body() dto: OpenCashDto, @CurrentUser() user: AuthUser) {
    return this.cash.open(dto.openingFloatMnt, user);
  }

  @Post('movements')
  @Roles(...POS_ROLES)
  move(@Body() dto: CashMoveDto, @CurrentUser() user: AuthUser) {
    return this.cash.move(dto.kind, dto.amountMnt, dto.reason, user);
  }

  @Post('close')
  @Roles(...POS_ROLES)
  close(@Body() dto: CloseCashDto, @CurrentUser() user: AuthUser) {
    return this.cash.close(dto.countedCashMnt, dto.note, user);
  }

  /** A manager closes a drawer someone left open. */
  @Post('sessions/:id/close')
  @Roles(...OVERSIGHT_ROLES)
  closeOther(@Param('id') id: string, @Body() dto: CloseCashDto, @CurrentUser() user: AuthUser) {
    return this.cash.close(dto.countedCashMnt, dto.note, user, id);
  }

  @Get('sessions')
  @Roles(...OVERSIGHT_ROLES)
  list(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('userId') userId?: string) {
    return this.cash.list(user, { from, to, userId });
  }
}
