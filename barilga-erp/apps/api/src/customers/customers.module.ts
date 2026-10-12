import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PriceListsController } from './price-lists.controller';
import { PriceListsService } from './price-lists.service';

@Module({
  controllers: [CustomersController, PriceListsController],
  providers: [CustomersService, PriceListsService],
  exports: [CustomersService],
})
export class CustomersModule {}
