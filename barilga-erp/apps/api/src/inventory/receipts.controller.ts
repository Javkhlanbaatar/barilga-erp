import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CreateReceiptDto, EditReceiptCostDto } from './dto/receipt.dto';
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
  list(
    @CurrentUser() user: AuthUser,
    @Query('warehouseId') warehouseId?: string,
    @Query('limit') limit?: string,
    @Query('supplierCustomerId') supplierCustomerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.receipts.list(user, { warehouseId, supplierCustomerId, from, to, limit: limit ? Number(limit) : undefined });
  }

  /** Put an existing receipt on a partner's account (or take it off). Managers only. */
  @Patch(':id/partner')
  attachPartner(@Param('id') id: string, @Body() body: { supplierCustomerId?: string | null; reason?: string }, @CurrentUser() user: AuthUser) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3) throw new BadRequestException('reason is required');
    return this.receipts.attachPartner(id, body?.supplierCustomerId || null, reason, user);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.receipts.get(id, user);
  }

  @Post()
  create(@Body() dto: CreateReceiptDto, @CurrentUser() user: AuthUser) {
    return this.receipts.create(dto, user);
  }

  /** Correct a purchase price later (managers/admin; logged for the admin edit report). */
  @Patch(':id/items/:itemId/cost')
  editCost(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: EditReceiptCostDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.receipts.editItemCost(id, itemId, dto.unitCostMnt, dto.reason, user);
  }
}
