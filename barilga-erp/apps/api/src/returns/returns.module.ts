import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ReturnsService } from './returns.service';

@Module({
  imports: [InventoryModule],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
