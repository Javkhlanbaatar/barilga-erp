import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { AccountsService } from './accounts.service';
import { AddAccountEntryDto, EditAccountEntryDto, OffsetDto } from './dto/account.dto';

/** Partner accounts: everyone at the till may read a balance; only managers/admin change it. */
@Controller('accounts')
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@RequireFeature('PARTNER_ACCOUNTS')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @Roles(...OVERSIGHT_ROLES)
  balances() {
    return this.accounts.balances();
  }

  @Get(':customerId')
  @Roles(...POS_ROLES)
  statement(@Param('customerId') customerId: string) {
    return this.accounts.statement(customerId);
  }

  @Post(':customerId/entries')
  @Roles(...OVERSIGHT_ROLES)
  addEntry(@Param('customerId') customerId: string, @Body() dto: AddAccountEntryDto, @CurrentUser() user: AuthUser) {
    return this.accounts.addEntry(customerId, dto, user);
  }

  @Patch('entries/:entryId')
  @Roles(...OVERSIGHT_ROLES)
  editEntry(@Param('entryId') entryId: string, @Body() dto: EditAccountEntryDto, @CurrentUser() user: AuthUser) {
    return this.accounts.editEntry(entryId, dto, user);
  }

  @Post(':customerId/offset')
  @Roles(...OVERSIGHT_ROLES)
  offset(@Param('customerId') customerId: string, @Body() dto: OffsetDto, @CurrentUser() user: AuthUser) {
    return this.accounts.offset(customerId, dto.amountMnt, user);
  }
}
