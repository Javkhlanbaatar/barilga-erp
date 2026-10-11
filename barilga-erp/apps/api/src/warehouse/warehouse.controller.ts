import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FULFILLMENT_ROLES } from '../auth/rbac';
import { CompleteFulfillmentDto } from '../orders/dto/order.dto';
import { OrdersService } from '../orders/orders.service';

@Controller('warehouse')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WarehouseController {
  constructor(private readonly orders: OrdersService) {}

  @Get('tickets')
  @Roles(...FULFILLMENT_ROLES)
  tickets(@CurrentUser() user: AuthUser) {
    return this.orders.listReleaseTickets(user);
  }

  @Patch('tickets/:id/complete')
  @Roles(...FULFILLMENT_ROLES)
  complete(@Param('id') id: string, @Body() dto: CompleteFulfillmentDto, @CurrentUser() user: AuthUser) {
    return this.orders.complete(id, user, dto ?? {});
  }
}
