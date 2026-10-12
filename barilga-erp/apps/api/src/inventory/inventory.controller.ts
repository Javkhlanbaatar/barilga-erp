import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OVERSIGHT_ROLES } from '../auth/rbac';
import { InventoryService } from './inventory.service';
import { lockedWarehouseId } from './warehouse-scope';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** Staff assigned to a warehouse only ever see that warehouse; admin/manager may pick one or see the total. */
  @Get('stock')
  @Roles(Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH, Role.ACHIGCH_BELTGEGCH)
  stock(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.inventory.listStock(q ?? search, { warehouseId: lockedWarehouseId(user) ?? (warehouseId || null) });
  }

  /**
   * Read-only "where is it": how many of one product each active warehouse holds and what is on its way.
   * Any staff may ask, so a cashier can send a customer to the shop that has it.
   */
  @Get('availability/:productId')
  @Roles(Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH, Role.ACHIGCH_BELTGEGCH)
  availability(@Param('productId') productId: string) {
    return this.inventory.availability(productId);
  }

  @Get('reconciliation')
  @Roles(...OVERSIGHT_ROLES)
  reconciliation() {
    return this.inventory.listReconciliation();
  }
}
