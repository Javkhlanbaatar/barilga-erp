import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureKey } from './feature-flags';
import { FeaturesService } from './features.service';

export const FEATURE_KEY = 'feature';

/** Refuses the request (403) while the given module is switched off. Use together with {@link FeatureGuard}. */
export const RequireFeature = (key: FeatureKey) => SetMetadata(FEATURE_KEY, key);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeaturesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (key) await this.features.assertEnabled(key);
    return true;
  }
}
