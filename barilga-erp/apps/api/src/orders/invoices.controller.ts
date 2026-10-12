import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CreateInvoiceDto, MarkInvoiceSentDto } from './dto/invoice.dto';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('INVOICES')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @Roles(...POS_ROLES)
  list(@CurrentUser() user: AuthUser, @Query('state') state?: string, @Query('customerId') customerId?: string, @Query('q') q?: string) {
    return this.invoices.list(user, { state, customerId, q });
  }

  @Get('order/:orderId')
  @Roles(...POS_ROLES)
  forOrder(@Param('orderId') orderId: string, @CurrentUser() user: AuthUser) {
    return this.invoices.forOrder(orderId, user);
  }

  @Post()
  @Roles(...POS_ROLES)
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: AuthUser) {
    return this.invoices.create(dto, user);
  }

  @Post(':id/sent')
  @Roles(...POS_ROLES)
  sent(@Param('id') id: string, @Body() dto: MarkInvoiceSentDto, @CurrentUser() user: AuthUser) {
    return this.invoices.markSent(id, dto.via, user);
  }

  @Post(':id/cancel')
  @Roles(...OVERSIGHT_ROLES)
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invoices.cancel(id, user);
  }
}
