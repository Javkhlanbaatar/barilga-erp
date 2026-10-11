import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { AssignDriverDto, CreateOrderDto, QuoteOrderDto } from '../orders/dto/order.dto';
import { PublicService } from './public.service';

const MINUTE = 60_000;

/**
 * Unauthenticated endpoints. Every route is rate limited per client IP (in-memory, per process).
 * Creating orders is the expensive/abusable one, so it has the tightest budget.
 */
@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicController {
  constructor(private readonly publicOrders: PublicService) {}

  @Get('catalog')
  @RateLimit({ name: 'public-catalog', limit: 60, windowMs: MINUTE })
  catalog() {
    return this.publicOrders.catalog();
  }

  @Post('quote')
  @RateLimit({ name: 'public-quote', limit: 30, windowMs: MINUTE })
  quote(@Body() dto: QuoteOrderDto) {
    return this.publicOrders.quote(dto);
  }

  @Post('orders')
  @RateLimit({ name: 'public-order-create', limit: 5, windowMs: 10 * MINUTE })
  create(@Body() dto: CreateOrderDto) {
    return this.publicOrders.create(dto);
  }

  @Get('orders/:token')
  @RateLimit({ name: 'public-order-read', limit: 60, windowMs: MINUTE })
  find(@Param('token') token: string) {
    return this.publicOrders.findByToken(token);
  }

  @Patch('orders/:token/transport')
  @RateLimit({ name: 'public-order-transport', limit: 10, windowMs: 10 * MINUTE })
  updateTransport(@Param('token') token: string, @Body() dto: AssignDriverDto) {
    return this.publicOrders.updateTransport(token, dto);
  }
}
