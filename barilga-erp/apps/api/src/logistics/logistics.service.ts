import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DeliveryMethod, TimeCondition } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CartSpecs,
  matchVehicle,
  quoteFees,
  VehicleLimitExceededError,
} from './logistics.engine';

@Injectable()
export class LogisticsService {
  private readonly log = new Logger(LogisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async loadActiveVehicles() {
    const rows = await this.prisma.vehicleType.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!rows.length) {
      throw new BadRequestException('No active vehicle types configured in log_vehicles');
    }
    return rows.map((v) => ({
      code: v.code,
      maxWeightKg: v.maxWeightKg,
      maxLengthM: Number(v.maxLengthM),
      maxVolumeM3: Number(v.maxVolumeM3),
      sortOrder: v.sortOrder,
    }));
  }

  async quote(params: {
    zoneId: string;
    method: DeliveryMethod;
    time: TimeCondition;
    unloadingRequested: boolean;
    specs: CartSpecs;
  }) {
    const zone = await this.prisma.zone.findUnique({ where: { id: params.zoneId } });
    if (!zone || !zone.active) {
      throw new BadRequestException('Invalid or inactive delivery zone');
    }
    const vehicles = await this.loadActiveVehicles();
    try {
      const breakdown = quoteFees({
        specs: params.specs,
        zone: {
          code: zone.code,
          baseDeliveryFeeMnt: zone.baseDeliveryFeeMnt,
          nightDiscountApplies: zone.nightDiscountApplies,
        },
        method: params.method,
        time: params.time,
        unloadingRequested: params.unloadingRequested,
        vehicles,
      });
      this.log.log(
        `Quote zone=${zone.code} method=${params.method} time=${params.time} ` +
          `vehicle=${breakdown.assignedVehicle} delivery=${breakdown.deliveryFeeMnt} ` +
          `unload=${breakdown.unloadingFeeMnt} adj=${breakdown.timeAdjustmentMnt} total=${breakdown.totalMnt}`,
      );
      return { zone, vehicles, breakdown };
    } catch (err) {
      if (err instanceof VehicleLimitExceededError) {
        this.log.warn(`Vehicle matcher rejected cart: ${err.message}`);
        throw new BadRequestException({
          code: err.code,
          message: err.message,
          specs: err.specs,
          manipulator: err.manipulator,
        });
      }
      throw err;
    }
  }

  async matchOrThrow(specs: CartSpecs) {
    const vehicles = await this.loadActiveVehicles();
    try {
      const vehicle = matchVehicle(specs, vehicles);
      this.log.log(`Matched ${vehicle.code} for ${specs.weightKg}kg / ${specs.maxLengthM}m / ${specs.volumeM3}m3`);
      return vehicle;
    } catch (err) {
      if (err instanceof VehicleLimitExceededError) {
        throw new BadRequestException({
          code: err.code,
          message: err.message,
          specs: err.specs,
          manipulator: err.manipulator,
        });
      }
      throw err;
    }
  }
}
