import { PayMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class ReturnLineDto {
  @IsString()
  orderItemId!: string;

  @IsNumber()
  @Min(0.001)
  quantity!: number;
}

export class CreateReturnDto {
  @IsString()
  @MinLength(3)
  reason!: string;

  @IsEnum(PayMethod)
  refundMethod!: PayMethod;

  /** Bank transfer refunds: bank, account number and holder the money goes to. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refundAccount?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items!: ReturnLineDto[];
}
