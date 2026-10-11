import { Global, Module } from '@nestjs/common';
import { EbarimtClient } from './ebarimt.client';
import { EbarimtRetryService } from './ebarimt-retry.service';
import { EbarimtService } from './ebarimt.service';

@Global()
@Module({
  providers: [EbarimtClient, EbarimtService, EbarimtRetryService],
  exports: [EbarimtService],
})
export class EbarimtModule {}
