import { Global, Module } from '@nestjs/common';
import { FeatureGuard } from './feature.guard';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';

@Global()
@Module({
  controllers: [FeaturesController],
  providers: [FeaturesService, FeatureGuard],
  exports: [FeaturesService, FeatureGuard],
})
export class FeaturesModule {}
