import { Body, Controller, Get, Headers, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { OVERSIGHT_ROLES, POS_ROLES } from '../auth/rbac';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { PaymentService } from './payment.service';

@Controller(['payment', 'payments'])
export class PaymentController {
  private readonly log = new Logger(PaymentController.name);

  constructor(private readonly payments: PaymentService) {}

  /**
   * QPay server callback. Must remain unauthenticated, so it is treated as an untrusted hint: the
   * service re-checks the invoice with QPay before anything becomes PAID. Rate limited because each
   * callback can trigger a provider lookup.
   */
  @Post('qpay/webhook')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'qpay-webhook', limit: 60, windowMs: 60_000 })
  webhook(@Body() body: Record<string, unknown>, @Headers('user-agent') ua?: string) {
    this.log.log(`Incoming QPay webhook ua=${ua ?? 'n/a'}`);
    return this.payments.handleWebhook(body ?? {});
  }

  /** Lets the UI decide whether to offer the development-only simulate button. */
  @Get('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...POS_ROLES)
  config() {
    return { simulateEnabled: this.payments.simulationEnabled() };
  }

  /** Development only: the service refuses unless NODE_ENV != production and QPay is in mock mode. */
  @Post(':orderId/simulate-paid')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...OVERSIGHT_ROLES)
  simulate(@Param('orderId') orderId: string) {
    return this.payments.simulatePaid(orderId);
  }
}
