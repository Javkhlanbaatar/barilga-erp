import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { SettingsModule } from '../settings/settings.module';
import { PriceListsController, PublicPriceListsController } from './price-lists.controller';
import { PriceListsService } from './price-lists.service';

@Module({
  imports: [PaymentModule, SettingsModule],
  controllers: [CustomersController, PriceListsController, PublicPriceListsController, AccountsController],
  providers: [CustomersService, PriceListsService, AccountsService],
  exports: [CustomersService],
})
export class CustomersModule {}
