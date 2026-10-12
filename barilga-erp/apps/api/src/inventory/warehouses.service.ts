import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';

@Injectable()
export class WarehousesService {
  private readonly log = new Logger(WarehousesService.name);

  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive: boolean) {
    return this.prisma.warehouse.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    });
  }

  async create(dto: CreateWarehouseDto) {
    try {
      const created = await this.prisma.warehouse.create({
        data: {
          code: dto.code,
          name: dto.name,
          address: dto.address || null,
          phone: dto.phone || null,
        },
      });
      this.log.log(`Warehouse ${created.code} created`);
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Warehouse code ${dto.code} already exists`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateWarehouseDto) {
    const existing = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Warehouse not found');

    if (dto.isDefault === false) {
      throw new BadRequestException('Choose another warehouse as the default instead');
    }
    if (dto.isActive === false && existing.isActive) {
      if (existing.isDefault) {
        throw new ConflictException('The default warehouse cannot be deactivated; make another one the default first');
      }
      const stocked = await this.prisma.stockBalance.count({ where: { warehouseId: id, quantity: { not: 0 } } });
      if (stocked > 0) {
        throw new ConflictException('This warehouse still holds stock; move or adjust it to zero first');
      }
      const inTransit = await this.prisma.stockTransfer.count({
        where: { status: 'IN_TRANSIT', OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] },
      });
      if (inTransit > 0) {
        throw new ConflictException('Transfers into or out of this warehouse are still in transit; receive or cancel them first');
      }
      const people = await this.prisma.user.count({ where: { warehouseId: id, isActive: true } });
      if (people > 0) {
        throw new ConflictException('Active users are still assigned to this warehouse; reassign them first');
      }
    }
    if (dto.isDefault === true && (dto.isActive === false || !existing.isActive)) {
      throw new BadRequestException('An inactive warehouse cannot be the default');
    }

    const data: Prisma.WarehouseUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.address !== undefined ? { address: dto.address || null } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    if (dto.isDefault === true && !existing.isDefault) {
      return this.prisma.$transaction(async (tx) => {
        await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        return tx.warehouse.update({ where: { id }, data: { ...data, isDefault: true } });
      });
    }
    return this.prisma.warehouse.update({ where: { id }, data });
  }
}
