import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsController } from './products.controller';
import { VehiclesController } from './vehicles.controller';
import { ZonesController } from './zones.controller';

@Module({
  imports: [InventoryModule],
  controllers: [ZonesController, VehiclesController, ProductsController],
})
export class CatalogModule {}
