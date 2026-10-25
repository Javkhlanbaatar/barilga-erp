import {
  DeliveryMethod,
  TimeCondition,
  VehicleCode,
  ZoneCode,
} from '@prisma/client';

export const UNLOADING_RATE_PER_TON_MNT = 15_000;
export const UNLOADING_MINIMUM_MNT = 15_000;
export const NIGHT_DISCOUNT_RATE = 0.1;

export type VehicleLimit = {
  code: VehicleCode;
  maxWeightKg: number;
  maxLengthM: number;
  maxVolumeM3: number;
  sortOrder: number;
};

export type ZoneQuoteInput = {
  code: ZoneCode;
  baseDeliveryFeeMnt: number;
  nightDiscountApplies: boolean;
};

export type CartSpecs = {
  subtotalMnt: number;
  weightKg: number;
  maxLengthM: number;
  volumeM3: number;
};

export class VehicleLimitExceededError extends Error {
  readonly code = 'VEHICLE_LIMIT_EXCEEDED' as const;
  constructor(
    readonly specs: CartSpecs,
    readonly manipulator: VehicleLimit,
  ) {
    super(
      `Сагсны үзүүлэлт Manipulator-ийн хязгаараас хэтэрсэн / Cart exceeds Manipulator limits ` +
        `(max ${manipulator.maxWeightKg / 1000}t, ${manipulator.maxLengthM}m, ${manipulator.maxVolumeM3}m³). ` +
        `Одоогийн: ${specs.weightKg}кг, ${specs.maxLengthM}м, ${specs.volumeM3}м³. Захиалгыг хуваана уу.`,
    );
    this.name = 'VehicleLimitExceededError';
  }
}

/** Porter ≤1.5t → Dump ≤5t → Manipulator ≤10t. First vehicle that fits wins. */
export function matchVehicle(specs: CartSpecs, vehicles: VehicleLimit[]): VehicleLimit {
  const sorted = [...vehicles].sort((a, b) => a.sortOrder - b.sortOrder);
  const manipulator = sorted.find((v) => v.code === VehicleCode.MANIPULATOR) ?? sorted[sorted.length - 1];

  const fit = sorted.find(
    (v) =>
      specs.weightKg <= v.maxWeightKg &&
      specs.maxLengthM <= v.maxLengthM &&
      specs.volumeM3 <= v.maxVolumeM3,
  );

  if (!fit) {
    throw new VehicleLimitExceededError(specs, manipulator);
  }
  return fit;
}

export function expressSurgeRate(weightKg: number): number {
  if (weightKg <= 1_500) return 0.3;
  if (weightKg <= 5_000) return 0.4;
  return 0.5;
}

export function isZeroFeeMethod(method: DeliveryMethod): boolean {
  return method === DeliveryMethod.SELF_PICKUP || method === DeliveryMethod.CUSTOMER_DRIVER;
}

export type FeeBreakdown = {
  subtotalMnt: number;
  deliveryFeeMnt: number;
  unloadingFeeMnt: number;
  timeAdjustmentMnt: number;
  totalMnt: number;
  assignedVehicle: VehicleCode;
  expressSurgeRate: number | null;
  nightDiscountApplied: boolean;
};

export function calculateUnloadingFee(weightKg: number, requested: boolean): number {
  if (!requested) return 0;
  const tons = weightKg / 1000;
  const raw = Math.round(tons * UNLOADING_RATE_PER_TON_MNT);
  return Math.max(UNLOADING_MINIMUM_MNT, raw);
}

export function quoteFees(input: {
  specs: CartSpecs;
  zone: ZoneQuoteInput;
  method: DeliveryMethod;
  time: TimeCondition;
  unloadingRequested: boolean;
  vehicles: VehicleLimit[];
}): FeeBreakdown {
  const vehicle = matchVehicle(input.specs, input.vehicles);
  const zeroFees = isZeroFeeMethod(input.method);

  const deliveryFeeMnt = zeroFees ? 0 : input.zone.baseDeliveryFeeMnt;
  const unloadingFeeMnt = zeroFees ? 0 : calculateUnloadingFee(input.specs.weightKg, input.unloadingRequested);

  let timeAdjustmentMnt = 0;
  let nightDiscountApplied = false;
  let surge: number | null = null;

  if (input.time === TimeCondition.NIGHT && deliveryFeeMnt > 0 && input.zone.nightDiscountApplies) {
    timeAdjustmentMnt = -Math.round(deliveryFeeMnt * NIGHT_DISCOUNT_RATE);
    nightDiscountApplied = true;
  }

  if (input.time === TimeCondition.EXPRESS && deliveryFeeMnt > 0) {
    surge = expressSurgeRate(input.specs.weightKg);
    timeAdjustmentMnt = Math.round(deliveryFeeMnt * surge);
  }

  const totalMnt =
    input.specs.subtotalMnt + deliveryFeeMnt + unloadingFeeMnt + timeAdjustmentMnt;

  return {
    subtotalMnt: input.specs.subtotalMnt,
    deliveryFeeMnt,
    unloadingFeeMnt,
    timeAdjustmentMnt,
    totalMnt,
    assignedVehicle: vehicle.code,
    expressSurgeRate: surge,
    nightDiscountApplied,
  };
}
