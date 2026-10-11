import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  controllers: [InventoryController, WarehousesController, TransfersController],
  providers: [InventoryService, WarehousesService, TransfersService],
  exports: [InventoryService],
})
export class InventoryModule {}
