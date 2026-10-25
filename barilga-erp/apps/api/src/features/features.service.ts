import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FEATURES, FeatureKey, isFeatureKey } from './feature-flags';

@Injectable()
export class FeaturesService {
  private readonly log = new Logger(FeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(key: FeatureKey): Promise<boolean> {
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    return row ? row.enabled : FEATURES[key].default;
  }

  async assertEnabled(key: FeatureKey) {
    if (!(await this.isEnabled(key))) {
      throw new ForbiddenException(`Module ${key} is switched off`);
    }
  }

  async list() {
    const rows = await this.prisma.featureFlag.findMany({});
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return (Object.keys(FEATURES) as FeatureKey[]).map((key) => {
      const row = byKey.get(key);
      return {
        key,
        nameMn: FEATURES[key].nameMn,
        enabled: row ? row.enabled : FEATURES[key].default,
        isDefault: !row,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async set(key: string, enabled: boolean, actorId: string) {
    if (!isFeatureKey(key)) throw new NotFoundException(`Unknown module ${key}`);
    await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, enabled, updatedById: actorId },
      update: { enabled, updatedById: actorId },
    });
    this.log.log(`Module ${key} switched ${enabled ? 'on' : 'off'} by ${actorId}`);
    return (await this.list()).find((f) => f.key === key);
  }
}
