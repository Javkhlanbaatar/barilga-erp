import { Module } from '@nestjs/common';
import { EbarimtModule } from '../ebarimt/ebarimt.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LogisticsModule } from '../logistics/logistics.module';
import { PaymentModule } from '../payment/payment.module';
import { ReturnsModule } from '../returns/returns.module';
import { WarehouseController } from '../warehouse/warehouse.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [LogisticsModule, PaymentModule, InventoryModule, EbarimtModule, ReturnsModule],
  controllers: [OrdersController, WarehouseController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
