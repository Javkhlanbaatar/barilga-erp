import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATALOG_READ_ROLES, OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { SettingsService } from '../settings/settings.service';
import { CreatePriceListDto, CreatePriceShareDto, PriceSheetQueryDto, SetPricesDto, UpdatePriceListDto } from './dto/price-list.dto';
import { PriceListsService } from './price-lists.service';

/**
 * Managers/admin keep the lists and their prices; the till only needs their names. Every handler except the
 * retail sheet sits behind the PRICE_LISTS module (shelf prices print even while the module is off).
 */
@Controller('price-lists')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
export class PriceListsController {
  constructor(private readonly lists: PriceListsService) {}

  @Get()
  @RequireFeature('PRICE_LISTS')
  // The till reads them; anyone given the price-list right needs the list too.
  @Permission('PRICE_LIST_WRITE', ...POS_ROLES)
  list(@Query('all') all?: string) {
    return this.lists.list(all === 'true');
  }

  @Post()
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE')
  create(@Body() dto: CreatePriceListDto) {
    return this.lists.create(dto);
  }

  /**
   * Shelf prices for printing (till, warehouse, inventory screen): every role that reads the catalog, no
   * module or list needed. `ids` / `cat` limit it to chosen products or categories.
   */
  @Get('retail/sheet')
  @Roles(...CATALOG_READ_ROLES)
  retailSheet(@Query() q: PriceSheetQueryDto) {
    return this.lists.retailSheet({ productIds: q.ids, categories: q.cat });
  }

  /** Links of one list, or `?priceListId=retail` for the retail ones (the till may manage those). */
  @Get('shares')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE', ...POS_ROLES)
  shares(@Query('priceListId') priceListId: string | undefined, @CurrentUser() user: AuthUser) {
    return this.lists.listShares(priceListId, user);
  }

  /** A link limited to chosen products / categories. Retail prices are public, so the till may send them. */
  @Post('shares')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE', ...POS_ROLES)
  createShare(@Body() dto: CreatePriceShareDto, @CurrentUser() user: AuthUser) {
    return this.lists.createShare(dto, user);
  }

  @Delete('shares/:id')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE', ...POS_ROLES)
  revokeShare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.lists.revokeShare(id, user);
  }

  @Patch(':id')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE')
  update(@Param('id') id: string, @Body() dto: UpdatePriceListDto) {
    return this.lists.update(id, dto);
  }

  /**
   * The printable sheet: listed products at list price (`all=true` adds the rest at retail), optionally only
   * the chosen products / categories (`ids`, `cat`). No costs.
   */
  @Get(':id/sheet')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE', ...OVERSIGHT_ROLES)
  sheet(@Param('id') id: string, @Query() q: PriceSheetQueryDto) {
    return this.lists.sheet(id, { all: q.all === 'true', productIds: q.ids, categories: q.cat });
  }

  /** The list's own whole-list link: returned if it exists, made otherwise. */
  @Post(':id/share')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE')
  share(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.lists.share(id, user.id);
  }

  /** Closes the list's own everyday link (links made for someone are closed one by one). */
  @Delete(':id/share')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE')
  unshare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.lists.unshare(id, user.id);
  }

  @Get(':id/prices')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE', ...OVERSIGHT_ROLES)
  prices(@Param('id') id: string) {
    return this.lists.prices(id);
  }

  @Put(':id/prices')
  @RequireFeature('PRICE_LISTS')
  @Permission('PRICE_LIST_WRITE')
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

  /** Only the products the link was made for; refused once the link is closed, past its day or the list is off. */
  @Get(':token')
  @RateLimit({ name: 'public-price-list', limit: 60, windowMs: 60_000 })
  async sheet(@Param('token') token: string) {
    const [sheet, company] = await Promise.all([this.lists.publicSheet(token), this.settings.company()]);
    return { ...sheet, company };
  }
}
