import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseDayBound, UB_TZ, ymdInUlaanbaatar } from './report-dates';

/** Later changes to money figures (purchase prices, partner account lines): who, when, before → after, why. */
@Injectable()
export class EditsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: { startDate?: string; endDate?: string }) {
    const endDate = query.endDate ?? ymdInUlaanbaatar();
    const startDate = query.startDate ?? endDate;
    const startAt = parseDayBound(startDate, false);
    const endAt = parseDayBound(endDate, true);
    if (endAt < startAt) throw new BadRequestException('endDate must be on or after startDate');
    const rows = await this.prisma.editAudit.findMany({
      where: { createdAt: { gte: startAt, lte: endAt } },
      include: { actor: { select: { fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return {
      range: { startDate, endDate, timeZone: UB_TZ },
      edits: rows.map((r) => ({
        id: r.id,
        at: r.createdAt,
        entityType: r.entityType,
        entityId: r.entityId,
        summary: r.summary,
        before: r.before,
        after: r.after,
        reason: r.reason,
        actor: r.actor.fullName,
        actorRole: r.actor.role,
      })),
    };
  }
}
