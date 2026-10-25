import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { FeatureGuard, RequireFeature } from '../features/feature.guard';
import { AccountsService } from './accounts.service';
import { AddAccountEntryDto, EditAccountEntryDto, OffsetDto, ReceiveFromPartnerDto, VoidAccountEntryDto } from './dto/account.dto';

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
  statement(@Param('customerId') customerId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.accounts.statement(customerId, { from, to });
  }

  /** The partner paid us money: their order debts first, the rest is their advance. */
  @Post(':customerId/receive')
  @Permission('PARTNER_LEDGER')
  receive(@Param('customerId') customerId: string, @Body() dto: ReceiveFromPartnerDto, @CurrentUser() user: AuthUser) {
    return this.accounts.receive(customerId, dto.amountMnt, dto.method, dto.description ?? '', user);
  }

  /** Cancel a hand-written line (an opposite line is written; both stay in the history). */
  @Post('entries/:entryId/void')
  @Permission('PARTNER_LEDGER')
  voidEntry(@Param('entryId') entryId: string, @Body() dto: VoidAccountEntryDto, @CurrentUser() user: AuthUser) {
    return this.accounts.voidEntry(entryId, dto.reason, user);
  }

  @Post(':customerId/entries')
  @Permission('PARTNER_LEDGER')
  addEntry(@Param('customerId') customerId: string, @Body() dto: AddAccountEntryDto, @CurrentUser() user: AuthUser) {
    return this.accounts.addEntry(customerId, dto, user);
  }

  @Patch('entries/:entryId')
  @Permission('PARTNER_LEDGER')
  editEntry(@Param('entryId') entryId: string, @Body() dto: EditAccountEntryDto, @CurrentUser() user: AuthUser) {
    return this.accounts.editEntry(entryId, dto, user);
  }

  @Post(':customerId/offset')
  @Permission('PARTNER_LEDGER')
  offset(@Param('customerId') customerId: string, @Body() dto: OffsetDto, @CurrentUser() user: AuthUser) {
    return this.accounts.offset(customerId, dto.amountMnt, user);
  }
}
