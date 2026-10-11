import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  controllers: [InventoryController, WarehousesController],
  providers: [InventoryService, WarehousesService],
  exports: [InventoryService],
})
export class InventoryModule {}
