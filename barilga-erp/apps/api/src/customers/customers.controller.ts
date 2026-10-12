import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { AccountsService } from './accounts.service';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, PayDebtDto, UpdateCustomerDto } from './dto/customer.dto';

@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('CUSTOMERS')
@Roles(...POS_ROLES)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly accounts: AccountsService,
  ) {}

  /** The customer pays off their debt; the money goes to the oldest open orders first. */
  @Post(':id/pay-debt')
  @Roles(...POS_ROLES)
  @RequireFeature('CREDIT_SALES')
  payDebt(@Param('id') id: string, @Body() dto: PayDebtDto, @CurrentUser() user: AuthUser) {
    return this.accounts.payDebt(id, dto.method, dto.amountMnt, user);
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
