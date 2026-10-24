import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { AccountsService } from './accounts.service';
import { CustomersService } from './customers.service';
import { PartnerTradeService } from './partner-trade.service';
import { CreateCustomerDto, PayDebtDto, UpdateCustomerDto } from './dto/customer.dto';

@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('CUSTOMERS')
@Roles(...POS_ROLES)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly accounts: AccountsService,
    private readonly trade: PartnerTradeService,
  ) {}

  /** Order debt this user may collect for the customer (their own warehouses). */
  @Get(':id/owed-here')
  owedHere(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.accounts.owedHere(id, user);
  }

  /** What we sold them and bought from them in a period (purchases for managers). */
  @Get(':id/trade')
  tradeWith(@Param('id') id: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentUser() user: AuthUser) {
    return this.trade.trade(id, { from, to }, user);
  }

  /** The customer pays off their debt; the money goes to the oldest open orders first. */
  @Post(':id/pay-debt')
  @Permission('PAY_DEBT')
  @RequireFeature('CREDIT_SALES')
  payDebt(@Param('id') id: string, @Body() dto: PayDebtDto, @CurrentUser() user: AuthUser) {
    return this.accounts.payDebt(id, dto.method, dto.amountMnt, user);
  }

  /** The customer's own prices, set at the till by someone with the right. */
  @Get(':id/prices')
  ownPrices(@Param('id') id: string) {
    return this.customers.ownPrices(id);
  }

  @Delete(':id/prices/:productId')
  @Permission('PRICE_OVERRIDE')
  removeOwnPrice(@Param('id') id: string, @Param('productId') productId: string, @CurrentUser() user: AuthUser) {
    return this.customers.removeOwnPrice(id, productId, user);
  }

  @Get()
  search(@Query('q') q?: string, @Query('all') all?: string) {
    return this.customers.search(q, all === 'true');
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Post()
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthUser) {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto, @CurrentUser() user: AuthUser) {
    return this.customers.update(id, dto, user);
  }
}
