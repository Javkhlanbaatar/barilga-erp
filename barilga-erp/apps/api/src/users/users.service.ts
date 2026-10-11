import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto/upsert-user.dto';

const publicUser = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  phone: true,
  role: true,
  isActive: true,
  warehouseId: true,
  warehouse: { select: { id: true, code: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const;

function toStaff(row: {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  warehouseId: string | null;
  warehouse: { id: string; code: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    name: row.fullName,
    active: row.isActive,
  };
}

function isUnique(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.user.findMany({
      where: { username: { not: WEBSHOP_USERNAME } },
      select: publicUser,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toStaff);
  }

  async create(dto: CreateUserDto) {
    const username = dto.username.trim().toLowerCase();
    const email = dto.email?.trim().toLowerCase() || null;
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const warehouseId = await this.checkWarehouse(dto.warehouseId);
    try {
      const row = await this.prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          fullName: dto.fullName.trim(),
          phone: dto.phone,
          role: dto.role,
          isActive: true,
          warehouseId,
        },
        select: publicUser,
      });
      return toStaff(row);
    } catch (err) {
      if (isUnique(err)) throw new ConflictException('Username or email already in use');
      throw err;
    }
  }

  async update(id: string, dto: UpdateUserDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.isActive === false || dto.role) {
      await this.guardLastAdmin(user, dto);
    }
    if (id === actorId && dto.isActive === false) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }

    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 12) : undefined;
    const warehouseId = dto.warehouseId === undefined ? undefined : await this.checkWarehouse(dto.warehouseId);
    try {
      const row = await this.prisma.user.update({
        where: { id },
        data: {
          ...(warehouseId !== undefined ? { warehouseId } : {}),
          ...(dto.username ? { username: dto.username.trim().toLowerCase() } : {}),
          ...(dto.email !== undefined ? { email: dto.email?.trim().toLowerCase() || null } : {}),
          ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.role ? { role: dto.role } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(passwordHash ? { passwordHash } : {}),
        },
        select: publicUser,
      });
      return toStaff(row);
    } catch (err) {
      if (isUnique(err)) throw new ConflictException('Username or email already in use');
      throw err;
    }
  }

  /** null/undefined = no assignment; otherwise the warehouse must exist and be active. */
  private async checkWarehouse(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const w = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!w || !w.isActive) throw new BadRequestException('Warehouse not found or not active');
    return w.id;
  }

  async setActive(id: string, isActive: boolean, actorId: string) {
    return this.update(id, { isActive }, actorId);
  }

  async deactivate(id: string, actorId: string) {
    return this.setActive(id, false, actorId);
  }

  private async guardLastAdmin(
    user: { id: string; role: Role; isActive: boolean },
    dto: UpdateUserDto,
  ) {
    const removingAdmin =
      user.role === Role.ADMIN &&
      user.isActive &&
      (dto.isActive === false || (dto.role !== undefined && dto.role !== Role.ADMIN));
    if (!removingAdmin) return;
    const others = await this.prisma.user.count({
      where: { role: Role.ADMIN, isActive: true, id: { not: user.id } },
    });
    if (others === 0) {
      throw new BadRequestException('Cannot deactivate or demote the last active admin');
    }
  }
}
