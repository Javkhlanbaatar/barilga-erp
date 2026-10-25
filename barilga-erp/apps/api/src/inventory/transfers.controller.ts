import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TRANSFER_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CancelTransferDto, CreateTransferDto, DispatchTransferDto, ReceiveTransferDto } from './dto/transfer.dto';
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

  /** Counts for the menu badge: requests to send and stock on its way to the user's warehouse. */
  @Get('pending')
  @Roles(...TRANSFER_ROLES)
  pending(@CurrentUser() user: AuthUser) {
    return this.transfers.pending(user);
  }

  /** Products below their minimum at `to` that `from` can supply. */
  @Get('suggest')
  @Roles(...TRANSFER_ROLES)
  suggest(@Query('to') to: string, @Query('from') from: string, @CurrentUser() user: AuthUser) {
    return this.transfers.suggest(to, from, user);
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

  /** A shop asks another warehouse for stock; nothing moves yet. */
  @Post('request')
  @Roles(...TRANSFER_ROLES)
  request(@Body() dto: CreateTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.request(dto, user);
  }

  /** The source sends a request (optionally fewer than asked). */
  @Post(':id/dispatch')
  @Roles(...TRANSFER_ROLES)
  dispatch(@Param('id') id: string, @Body() dto: DispatchTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.dispatch(id, dto, user);
  }

  @Post(':id/receive')
  @Roles(...TRANSFER_ROLES)
  receive(@Param('id') id: string, @Body() dto: ReceiveTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.receive(id, user, dto);
  }

  /** Withdraw/refuse a request (its two warehouses), or return in-transit stock to the source (managers). */
  @Post(':id/cancel')
  @Roles(...TRANSFER_ROLES)
  cancel(@Param('id') id: string, @Body() dto: CancelTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.cancel(id, dto.reason, user);
  }
}
