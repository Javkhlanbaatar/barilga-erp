import { Module } from '@nestjs/common';
import { EbarimtModule } from '../ebarimt/ebarimt.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { QpayClient } from './qpay.client';
import { QpayPollingService } from './qpay-polling.service';

@Module({
  imports: [EbarimtModule],
  controllers: [PaymentController],
  providers: [QpayClient, PaymentService, QpayPollingService],
  exports: [PaymentService],
})
export class PaymentModule {}
