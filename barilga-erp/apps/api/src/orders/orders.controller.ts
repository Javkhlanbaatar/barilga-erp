import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FULFILLMENT_ROLES, OVERSIGHT_ROLES, POS_ROLES, RETURN_ROLES, TRANSPORT_ROLES } from '../auth/rbac';
import { CreateReturnDto } from '../returns/dto/create-return.dto';
import { ReturnsService } from '../returns/returns.service';
import {
  AssignDriverDto,
  AssignSupplierDto,
  CancelOrderDto,
  CompleteFulfillmentDto,
  CreateOrderDto,
  OverrideFeesDto,
  PickItemDto,
  PayRemainingDto,
  SettleCreditDto,
  QuoteOrderDto,
} from './dto/order.dto';
import { GatherService } from './gather.service';
import { InvoicesService } from './invoices.service';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly returns: ReturnsService,
    private readonly gather: GatherService,
    private readonly invoices: InvoicesService,
  ) {}

  @Post('quote')
  @Roles(...POS_ROLES)
  quote(@Body() dto: QuoteOrderDto) {
    return this.orders.quote(dto);
  }

  @Post()
  @Roles(...POS_ROLES)
  async create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) {
    const order = await this.orders.create(dto, user);
    // "Pay by invoice" at the till: the invoice is made right away, ready to send from the order page.
    if (dto.payments?.some((p) => p.method === 'INVOICE') || dto.paymentMethod === 'INVOICE') {
      await this.invoices.create({ orderId: order.id }, user);
    }
    return order;
  }

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: OrderStatus,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.orders.list(user, status, { q, from, to, skip: skip ? Number(skip) : undefined, take: take ? Number(take) : undefined });
  }

  /** Paid release tickets for warehouse loading only. */
  @Get('tickets')
  @Roles(...FULFILLMENT_ROLES)
  tickets(@CurrentUser() user: AuthUser) {
    return this.orders.listReleaseTickets(user);
  }

  @Get('tickets/recent')
  @Roles(...FULFILLMENT_ROLES)
  recentTickets(@CurrentUser() user: AuthUser) {
    return this.orders.listRecentlyPrepared(user);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH, Role.ACHIGCH_BELTGEGCH)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.findOne(id, user);
  }

  @Post(':id/override-fees')
  @Roles(Role.BORLUULAGCH)
  override(@Param('id') id: string, @Body() dto: OverrideFeesDto, @CurrentUser() user: AuthUser) {
    return this.orders.overrideFees(id, dto, user);
  }

  /** Where this order's stock would be collected from (other warehouses → its dispatch warehouse). */
  @Get(':id/gather-plan')
  @Roles(...OVERSIGHT_ROLES)
  gatherPlan(@Param('id') id: string) {
    return this.gather.plan(id);
  }

  /** Sends the planned transfers into the dispatch warehouse, linked to this order. */
  @Post(':id/gather')
  @Roles(...OVERSIGHT_ROLES)
  gatherStock(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.gather.gather(id, user);
  }

  /** Only for orders with no recorded payment; paid orders need a refund process that is not defined yet. */
  @Post(':id/cancel')
  @Roles(...POS_ROLES)
  cancel(@Param('id') id: string, @Body() dto: CancelOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.cancel(id, user, dto?.reason);
  }

  @Post(':id/return')
  @Roles(...RETURN_ROLES)
  createReturn(@Param('id') id: string, @Body() dto: CreateReturnDto, @CurrentUser() user: AuthUser) {
    return this.returns.create(id, dto, user);
  }

  @Post(':id/ebarimt')
  @Roles(Role.BORLUULAGCH, Role.ADMIN, Role.MANAGER)
  issueEbarimt(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.issueEbarimt(id, user);
  }

  /** The waiting part of an order (QPay never paid, transfer came as cash…) was paid another way. */
  @Post(':id/pay-remaining')
  @Roles(...POS_ROLES)
  payRemaining(@Param('id') id: string, @Body() dto: PayRemainingDto, @CurrentUser() user: AuthUser) {
    return this.orders.payRemaining(id, dto.method, user);
  }

  /** Ask QPay now whether the customer has paid (after the automatic checks, or when in doubt). */
  @Post(':id/check-qpay')
  @Roles(...POS_ROLES)
  checkQpay(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.checkQpay(id, user);
  }

  /** The invoiced bank transfer arrived: release the order. */
  @Post(':id/confirm-transfer')
  @Roles(...POS_ROLES)
  confirmTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.confirmTransfer(id, user);
  }

  /** Record a payment against what is owed on an order released on account. */
  @Post(':id/settle-credit')
  @Roles(...POS_ROLES)
  settleCredit(@Param('id') id: string, @Body() dto: SettleCreditDto, @CurrentUser() user: AuthUser) {
    return this.orders.settleCredit(id, dto.method, dto.amountMnt, user);
  }

  /** "Би бэлдье": move the order to "being prepared" and start the preparation clock. */
  @Patch(':id/start-picking')
  @Roles(...FULFILLMENT_ROLES)
  startPicking(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.startPicking(id, user);
  }

  /** Picking checklist: tick/untick one line as prepared. */
  @Patch(':id/items/:itemId/pick')
  @Roles(...FULFILLMENT_ROLES)
  pick(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: PickItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.pickItem(id, itemId, dto.picked, user);
  }

  @Patch(':id/complete')
  @Roles(...FULFILLMENT_ROLES)
  complete(@Param('id') id: string, @Body() dto: CompleteFulfillmentDto, @CurrentUser() user: AuthUser) {
    return this.orders.complete(id, user, dto ?? {});
  }

  @Patch(':id/assign-driver')
  @Roles(...TRANSPORT_ROLES)
  assignDriver(@Param('id') id: string, @Body() dto: AssignDriverDto, @CurrentUser() user: AuthUser) {
    return this.orders.assignDriver(id, dto, user);
  }

  @Patch(':id/assign-transport')
  @Roles(...TRANSPORT_ROLES)
  assignTransport(@Param('id') id: string, @Body() dto: AssignDriverDto, @CurrentUser() user: AuthUser) {
    return this.orders.assignDriver(id, dto, user);
  }

  @Patch(':id/items/:itemId/assign-supplier')
  @Roles(...OVERSIGHT_ROLES)
  assignSupplier(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: AssignSupplierDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.assignSupplier(id, itemId, dto, user);
  }
}
