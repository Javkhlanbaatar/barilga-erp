import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATALOG_READ_ROLES, OVERSIGHT_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdjustStockDto, CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';
import { InventoryService } from './inventory.service';
import { allowedWarehouseIds, assertWarehouseAccess } from './warehouse-scope';
import { WarehousesService } from './warehouses.service';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WarehousesController {
  constructor(
    private readonly warehouses: WarehousesService,
    private readonly inventory: InventoryService,
  ) {}

  @Get('warehouses')
  @Roles(...CATALOG_READ_ROLES)
  list(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    // Who works where is shown to admin only (the shop/warehouse settings page).
    return this.warehouses.list(all === 'true', user.role === Role.ADMIN);
  }

  @Post('warehouses')
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(dto);
  }

  @Patch('warehouses/:id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouses.update(id, dto);
  }

  /** Manual stock correction (counted quantity or +/- delta) with a mandatory reason, written to the ledger. */
  @Post('adjust')
  @Roles(...OVERSIGHT_ROLES)
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: AuthUser) {
    // A branch manager corrects stock in their own warehouses only.
    assertWarehouseAccess(user, dto.warehouseId);
    return this.inventory.adjust({
      warehouseId: dto.warehouseId,
      productId: dto.productId,
      reason: dto.reason,
      actorId: user.id,
      ...(dto.countedQuantity !== undefined ? { countedQuantity: dto.countedQuantity } : { delta: dto.delta as number }),
    });
  }

  @Get('movements')
  @Roles(...OVERSIGHT_ROLES)
  movements(
    @CurrentUser() user: AuthUser,
    @Query('productId') productId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    const allowed = allowedWarehouseIds(user);
    if (allowed && warehouseId && !allowed.includes(warehouseId)) throw new ForbiddenException('You can only view your own warehouses');
    return this.inventory.listMovements({ productId, warehouseId, allowed, limit: limit ? Number(limit) : undefined });
  }
}
