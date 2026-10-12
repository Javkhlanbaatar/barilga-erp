import { Module } from '@nestjs/common';
import { EbarimtModule } from '../ebarimt/ebarimt.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LogisticsModule } from '../logistics/logistics.module';
import { PaymentModule } from '../payment/payment.module';
import { ReturnsModule } from '../returns/returns.module';
import { SettingsModule } from '../settings/settings.module';
import { WarehouseController } from '../warehouse/warehouse.controller';
import { GatherService } from './gather.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [LogisticsModule, PaymentModule, InventoryModule, EbarimtModule, ReturnsModule, SettingsModule],
  controllers: [OrdersController, WarehouseController, InvoicesController],
  providers: [OrdersService, GatherService, InvoicesService],
  exports: [OrdersService, InvoicesService],
})
export class OrdersModule {}
