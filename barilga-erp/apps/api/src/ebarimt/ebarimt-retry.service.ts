import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EbarimtService } from './ebarimt.service';

@Injectable()
export class EbarimtRetryService {
  private readonly log = new Logger(EbarimtRetryService.name);

  constructor(private readonly ebarimt: EbarimtService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    try {
      const { checked } = await this.ebarimt.retryDue();
      if (checked > 0) {
        this.log.log(`E-Barimt retry processed ${checked} queued receipt(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`E-Barimt retry tick failed: ${message}`);
    }
  }
}
