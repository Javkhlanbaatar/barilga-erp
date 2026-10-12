import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { CreatePriceListDto, SetPricesDto, UpdatePriceListDto } from './dto/price-list.dto';
import { PriceListsService } from './price-lists.service';

/** Managers/admin keep the lists and their prices; the till only needs their names. */
@Controller('price-lists')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('PRICE_LISTS')
export class PriceListsController {
  constructor(private readonly lists: PriceListsService) {}

  @Get()
  @Roles(...POS_ROLES)
  list(@Query('all') all?: string) {
    return this.lists.list(all === 'true');
  }

  @Post()
  @Roles(...OVERSIGHT_ROLES)
  create(@Body() dto: CreatePriceListDto) {
    return this.lists.create(dto);
  }

  @Patch(':id')
  @Roles(...OVERSIGHT_ROLES)
  update(@Param('id') id: string, @Body() dto: UpdatePriceListDto) {
    return this.lists.update(id, dto);
  }

  @Get(':id/prices')
  @Roles(...OVERSIGHT_ROLES)
  prices(@Param('id') id: string) {
    return this.lists.prices(id);
  }

  @Put(':id/prices')
  @Roles(...OVERSIGHT_ROLES)
  setPrices(@Param('id') id: string, @Body() dto: SetPricesDto, @CurrentUser() user: AuthUser) {
    return this.lists.setPrices(id, dto, user.id);
  }
}
