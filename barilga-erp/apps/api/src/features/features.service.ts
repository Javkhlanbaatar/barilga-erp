import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { audit } from '../common/audit';
import { PrismaService } from '../prisma/prisma.service';
import { FEATURES, FeatureKey, isDormant, isFeatureKey } from './feature-flags';

@Injectable()
export class FeaturesService {
  private readonly log = new Logger(FeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(key: FeatureKey): Promise<boolean> {
    if (isDormant(key)) return false;
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    return row ? row.enabled : FEATURES[key].default;
  }

  async assertEnabled(key: FeatureKey) {
    if (!(await this.isEnabled(key))) {
      throw new ForbiddenException(`Module ${key} is switched off`);
    }
  }

  /** Every module with its state. Dormant ones are included (always off) so the UI can hide their screens. */
  async list() {
    const rows = await this.prisma.featureFlag.findMany({});
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return (Object.keys(FEATURES) as FeatureKey[]).map((key) => {
      const row = byKey.get(key);
      const dormant = isDormant(key);
      return {
        key,
        nameMn: FEATURES[key].nameMn,
        enabled: dormant ? false : row ? row.enabled : FEATURES[key].default,
        isDefault: !row,
        dormant,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async set(key: string, enabled: boolean, actorId: string) {
    if (!isFeatureKey(key)) throw new NotFoundException(`Unknown module ${key}`);
    if (isDormant(key)) throw new BadRequestException(`Module ${key} is not used and cannot be switched on`);
    await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, enabled, updatedById: actorId },
      update: { enabled, updatedById: actorId },
    });
    this.log.log(`Module ${key} switched ${enabled ? 'on' : 'off'} by ${actorId}`);
    await audit(this.prisma, {
      entityType: 'MODULE',
      entityId: key,
      summary: `Модуль «${FEATURES[key].nameMn}» ${enabled ? 'асаалаа' : 'унтраалаа'}`,
      after: { enabled },
      actorId,
    });
    return (await this.list()).find((f) => f.key === key);
  }
}
