import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentService } from './payment.service';

@Injectable()
export class QpayPollingService {
  private readonly log = new Logger(QpayPollingService.name);

  constructor(private readonly payments: PaymentService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick() {
    try {
      const { checked } = await this.payments.pollDuePayments();
      if (checked > 0) {
        this.log.log(`Fail-safe poll processed ${checked} unpaid QPay invoice(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Fail-safe poll tick failed: ${message}`);
    }
  }

  /** Cancels orders whose payment window ran out. No-op unless ORDER_PAYMENT_TTL_MINUTES is set. */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireTick() {
    try {
      const { enabled, expired } = await this.payments.expireStaleOrders();
      if (enabled && expired > 0) {
        this.log.log(`Expired ${expired} unpaid order(s) past the payment window`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Order expiry tick failed: ${message}`);
    }
  }
}
