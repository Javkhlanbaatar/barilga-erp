import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  controllers: [InventoryController, WarehousesController, TransfersController, ReceiptsController],
  providers: [InventoryService, WarehousesService, TransfersService, ReceiptsService],
  exports: [InventoryService, TransfersService],
})
export class InventoryModule {}
