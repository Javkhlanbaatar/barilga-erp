import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PriceListsController } from './price-lists.controller';
import { PriceListsService } from './price-lists.service';

@Module({
  imports: [PaymentModule],
  controllers: [CustomersController, PriceListsController, AccountsController],
  providers: [CustomersService, PriceListsService, AccountsService],
  exports: [CustomersService],
})
export class CustomersModule {}
