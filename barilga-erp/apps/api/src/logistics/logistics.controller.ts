import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { TimeCondition } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { POS_ROLES } from '../auth/rbac';
import { QuoteOrderDto } from '../orders/dto/order.dto';
import { LogisticsService } from './logistics.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('logistics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LogisticsController {
  constructor(
    private readonly logistics: LogisticsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Dry-run vehicle match + zone/time/unloading fees for the POS cart. */
  @Post('quote')
  @Roles(...POS_ROLES)
  async quote(@Body() dto: QuoteOrderDto) {
    const ids = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, active: true },
    });
    if (products.length !== ids.length) {
      throw new BadRequestException('One or more products are invalid or inactive');
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    let subtotalMnt = 0;
    let weightKg = 0;
    let maxLengthM = 0;
    let volumeM3 = 0;
    for (const line of dto.items) {
      const p = byId.get(line.productId)!;
      subtotalMnt += Math.round(p.priceMnt * line.quantity);
      weightKg += Number(p.weightKg) * line.quantity;
      volumeM3 += Number(p.volumeM3) * line.quantity;
      maxLengthM = Math.max(maxLengthM, Number(p.lengthM));
    }
    if (!dto.zoneId) {
      throw new BadRequestException('zoneId is required for logistics quote');
    }
    return this.logistics.quote({
      zoneId: dto.zoneId,
      method: dto.deliveryMethod,
      time: dto.timeCondition ?? TimeCondition.STANDARD,
      unloadingRequested: dto.unloadingRequested,
      specs: {
        subtotalMnt,
        weightKg: Number(weightKg.toFixed(3)),
        maxLengthM: Number(maxLengthM.toFixed(2)),
        volumeM3: Number(volumeM3.toFixed(3)),
      },
    });
  }
}
