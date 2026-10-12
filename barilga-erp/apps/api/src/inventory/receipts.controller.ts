import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CreateReceiptDto } from './dto/receipt.dto';
import { ReceiptsService } from './receipts.service';

/** Goods receipts: managers/admin anywhere; warehouse staff only into their own warehouse. */
const RECEIPT_ROLES = [Role.ADMIN, Role.MANAGER, Role.ACHIGCH_BELTGEGCH] as const;

@Controller('inventory/receipts')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('STOCK_RECEIPTS')
@Roles(...RECEIPT_ROLES)
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('warehouseId') warehouseId?: string, @Query('limit') limit?: string) {
    return this.receipts.list(user, { warehouseId, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.receipts.get(id, user);
  }

  @Post()
  create(@Body() dto: CreateReceiptDto, @CurrentUser() user: AuthUser) {
    return this.receipts.create(dto, user);
  }
}
