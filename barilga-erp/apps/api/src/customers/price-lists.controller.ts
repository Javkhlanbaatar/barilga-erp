import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, POS_ROLES, TOP_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { SettingsService } from '../settings/settings.service';
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
  @Roles(...TOP_ROLES)
  create(@Body() dto: CreatePriceListDto) {
    return this.lists.create(dto);
  }

  @Patch(':id')
  @Roles(...TOP_ROLES)
  update(@Param('id') id: string, @Body() dto: UpdatePriceListDto) {
    return this.lists.update(id, dto);
  }

  /** Shelf prices of every product, for printing at the till (no module or list needed). */
  @Get('retail/sheet')
  @Roles(...POS_ROLES)
  retailSheet() {
    return this.lists.retailSheet();
  }

  /** The printable sheet: listed products at list price (`all=true` adds the rest at retail). No costs. */
  @Get(':id/sheet')
  @Roles(...OVERSIGHT_ROLES)
  sheet(@Param('id') id: string, @Query('all') all?: string) {
    return this.lists.sheet(id, all === 'true');
  }

  @Post(':id/share')
  @Roles(...TOP_ROLES)
  share(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.lists.share(id, user.id);
  }

  @Delete(':id/share')
  @Roles(...TOP_ROLES)
  unshare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.lists.unshare(id, user.id);
  }

  @Get(':id/prices')
  @Roles(...OVERSIGHT_ROLES)
  prices(@Param('id') id: string) {
    return this.lists.prices(id);
  }

  @Put(':id/prices')
  @Roles(...TOP_ROLES)
  setPrices(@Param('id') id: string, @Body() dto: SetPricesDto, @CurrentUser() user: AuthUser) {
    return this.lists.setPrices(id, dto, user.id);
  }
}

/** The customer's read-only price list behind the link we sent (no login). */
@Controller('public/price-lists')
@UseGuards(RateLimitGuard, FeatureGuard)
@RequireFeature('PRICE_LISTS')
export class PublicPriceListsController {
  constructor(
    private readonly lists: PriceListsService,
    private readonly settings: SettingsService,
  ) {}

  @Get(':token')
  @RateLimit({ name: 'public-price-list', limit: 60, windowMs: 60_000 })
  async sheet(@Param('token') token: string) {
    const [sheet, company] = await Promise.all([this.lists.publicSheet(token), this.settings.company()]);
    return { ...sheet, company };
  }
}
