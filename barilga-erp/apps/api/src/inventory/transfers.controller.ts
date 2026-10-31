import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, TRANSFER_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CancelTransferDto, CreateTransferDto } from './dto/transfer.dto';
import { TransfersService } from './transfers.service';

@Controller('inventory/transfers')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('STOCK_TRANSFERS')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @Roles(...TRANSFER_ROLES)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transfers.list(user, { status, warehouseId, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @Roles(...TRANSFER_ROLES)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.get(id, user);
  }

  /** Creates the transfer and takes the stock out of the source warehouse immediately. */
  @Post()
  @Roles(...TRANSFER_ROLES)
  send(@Body() dto: CreateTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.send(dto, user);
  }

  @Post(':id/receive')
  @Roles(...TRANSFER_ROLES)
  receive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.receive(id, user);
  }

  @Post(':id/cancel')
  @Roles(...OVERSIGHT_ROLES)
  cancel(@Param('id') id: string, @Body() dto: CancelTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.cancel(id, dto.reason, user);
  }
}
