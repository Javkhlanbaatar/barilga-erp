import { BillType, DeliveryMethod, SourceType, TimeCondition } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class OrderLineDto {
  @IsString()
  @MaxLength(64)
  productId!: string;

  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  quantity!: number;

  @IsOptional()
  @IsEnum(SourceType)
  sourceType?: SourceType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplierName?: string;
}

function toDeliveryMethod(value: unknown, obj: Record<string, unknown>): DeliveryMethod {
  const raw = (value ?? obj.deliveryType ?? obj.deliveryMethod) as string | undefined;
  if (raw === 'DELIVERY') return DeliveryMethod.OUR_DELIVERY;
  if (raw === 'OUR_DELIVERY' || raw === 'SELF_PICKUP' || raw === 'CUSTOMER_DRIVER') {
    return raw as DeliveryMethod;
  }
  return DeliveryMethod.OUR_DELIVERY;
}

export class QuoteOrderDto {
  @IsOptional()
  @IsString()
  zoneId?: string;

  @IsOptional()
  @IsString()
  deliveryType?: string;

  @IsOptional()
  @IsBoolean()
  isUnloading?: boolean;

  @Transform(({ value, obj }) => toDeliveryMethod(value, obj))
  @IsEnum(DeliveryMethod)
  deliveryMethod!: DeliveryMethod;

  @IsOptional()
  @IsEnum(TimeCondition)
  timeCondition?: TimeCondition;

  @Transform(({ value, obj }) => Boolean(value ?? obj.isUnloading ?? false))
  @IsBoolean()
  unloadingRequested!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items!: OrderLineDto[];
}

export enum CheckoutPaymentMethod {
  QPAY = 'QPAY',
  CASH = 'CASH',
  CARD = 'CARD',
}

export class PaymentSplitDto {
  @IsEnum(CheckoutPaymentMethod)
  method!: CheckoutPaymentMethod;

  @Transform(({ value, obj }) => Number(value ?? obj.amountMnt ?? 0))
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  status?: string;
}

export class CreateOrderDto extends QuoteOrderDto {
  /** Warehouse/shop the stock comes from. Defaults to the user's own warehouse, then the default warehouse. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  warehouseId?: string;

  @IsString()
  @MaxLength(120)
  customerName!: string;

  @IsString()
  @MaxLength(32)
  customerPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  deliveryAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsEnum(CheckoutPaymentMethod)
  paymentMethod?: CheckoutPaymentMethod;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentSplitDto)
  payments?: PaymentSplitDto[];

  @IsOptional()
  @IsEnum(BillType)
  billType?: BillType;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  customerRegNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  vehicleNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9+\-\s]{8,15}$/, { message: 'driverPhone must be 8–15 digits' })
  driverPhone?: string;
}

export class AssignDriverDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  driverName?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(20)
  vehicleNumber!: string;

  @IsString()
  @MinLength(8)
  @Matches(/^[0-9+\-\s]{8,15}$/, { message: 'driverPhone must be 8–15 digits' })
  driverPhone!: string;
}

/** Optional hired-truck fields applied in the same complete transaction. */
export class CompleteFulfillmentDto {
  @IsOptional()
  @IsString()
  driverName?: string;

  @IsOptional()
  @IsString()
  vehicleNumber?: string;

  @IsOptional()
  @IsString()
  driverPhone?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class AssignSupplierDto {
  @IsString()
  @MinLength(2)
  supplierName!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class OverrideFeesDto {
  @IsInt()
  @Min(0)
  deliveryFeeMnt!: number;

  @IsInt()
  @Min(0)
  unloadingFeeMnt!: number;

  @IsInt()
  timeAdjustmentMnt!: number;

  @IsString()
  reason!: string;
}
