import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { normalizeOverrides, PERMISSIONS, roleHas } from '../auth/permissions';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { audit } from '../common/audit';
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
  managedWarehouses: { select: { warehouse: { select: { id: true, code: true, name: true } } } },
  permissions: true,
  googleEmail: true,
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
  managedWarehouses: Array<{ warehouse: { id: string; code: string; name: string } }>;
  permissions: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const p = (row.permissions ?? {}) as { grant?: string[]; revoke?: string[] };
  return {
    ...row,
    permissions: { grant: p.grant ?? [], revoke: p.revoke ?? [] },
    managedWarehouses: row.managedWarehouses.map((m) => m.warehouse),
    name: row.fullName,
    active: row.isActive,
  };
}

/** Role names in Mongolian, for the edits report. */
const ROLE_MN: Record<Role, string> = {
  ADMIN: 'Админ',
  SUPER_MANAGER: 'Ерөнхий менежер',
  MANAGER: 'Салбарын менежер',
  BORLUULAGCH: 'Кассчин',
  ACHIGCH_BELTGEGCH: 'Агуулахын ажилтан',
};

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

  /** One person per «Google Gmail»: the same address on two users would be ambiguous at sign-in. */
  private async checkGoogleEmail(googleEmail: string | null | undefined, exceptId?: string) {
    if (!googleEmail) return;
    const taken = await this.prisma.user.findFirst({
      where: { id: exceptId ? { not: exceptId } : undefined, googleEmail: { equals: googleEmail, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw new ConflictException('Энэ Google Gmail өөр хэрэглэгчид бүртгэлтэй / This Google address is already set for another user');
  }

  async create(dto: CreateUserDto, actorId?: string) {
    const username = dto.username.trim().toLowerCase();
    const email = dto.email?.trim().toLowerCase() || null;
    await this.checkGoogleEmail(dto.googleEmail);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const warehouseId = await this.checkWarehouse(dto.warehouseId);
    const managed = await this.checkManaged(dto.role, warehouseId, dto.managedWarehouseIds ?? []);
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
          googleEmail: dto.googleEmail || null,
          managedWarehouses: { create: managed.map((warehouseId) => ({ warehouseId })) },
        },
        select: publicUser,
      });
      if (actorId) {
        await audit(this.prisma, {
          entityType: 'USER',
          entityId: row.id,
          summary: `Шинэ хэрэглэгч ${row.fullName} (${row.username}): ${ROLE_MN[row.role]}${row.warehouse ? `, ${row.warehouse.name}` : ''}`,
          after: { role: row.role, warehouseId: row.warehouseId },
          actorId,
        });
      }
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
    // One's own password and Google sign-in are changed on «Миний бүртгэл», where the current password is asked.
    if (id === actorId && dto.password) {
      throw new BadRequestException('Өөрийн нууц үгийг «Миний бүртгэл»-ээс солино / Change your own password under «Миний бүртгэл»');
    }
    if (id === actorId && (dto.unlinkGoogle || (dto.googleEmail !== undefined && (dto.googleEmail || null) !== (user.googleEmail ?? null)))) {
      throw new BadRequestException('Өөрийн Google нэвтрэлтийг «Миний бүртгэл»-ээс тохируулна / Set up your own Google sign-in under «Миний бүртгэл»');
    }
    // A new «Google Gmail» replaces the link (the old Google account no longer signs in); clearing it unlinks.
    const googleChange =
      dto.unlinkGoogle ||
      // A password reset is a reset of every way in: a Google account added by whoever knew the old password goes.
      (Boolean(dto.password) && Boolean(user.googleSub || user.googleEmail) && dto.googleEmail === undefined) ||
      (dto.googleEmail !== undefined && (dto.googleEmail || null) !== (user.googleEmail ?? null));
    if (googleChange && dto.googleEmail) await this.checkGoogleEmail(dto.googleEmail, id);

    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 12) : undefined;
    const warehouseId = dto.warehouseId === undefined ? undefined : await this.checkWarehouse(dto.warehouseId);
    const role = dto.role ?? user.role;
    const current = await this.prisma.userWarehouseAccess.findMany({ where: { userId: id }, select: { warehouseId: true } });
    const managed = await this.checkManaged(
      role,
      warehouseId === undefined ? user.warehouseId : warehouseId,
      dto.managedWarehouseIds ?? current.map((c) => c.warehouseId),
    );
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
          // A password set by the admin, or a Google change, signs the person out everywhere.
          ...(passwordHash || googleChange ? { sessionsValidFrom: new Date(Math.floor(Date.now() / 1000) * 1000) } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          ...(googleChange ? { googleSub: null, googleEmail: dto.unlinkGoogle || dto.googleEmail === undefined ? null : dto.googleEmail || null } : {}),
          // Replaced as a whole; anyone who is not a branch manager keeps none.
          managedWarehouses: { deleteMany: {}, create: managed.map((warehouseId) => ({ warehouseId })) },
        },
        select: publicUser,
      });
      // Who may do what: role, active, warehouses and password resets are kept in the edits report.
      const changes: string[] = [];
      if (row.role !== user.role) changes.push(`эрх ${ROLE_MN[user.role]} → ${ROLE_MN[row.role]}`);
      if (row.isActive !== user.isActive) changes.push(row.isActive ? 'идэвхжүүлсэн' : 'идэвхгүй болгосон');
      if (row.warehouseId !== user.warehouseId) changes.push(`агуулах → ${row.warehouse?.name ?? 'томилоогүй'}`);
      const managedNow = row.managedWarehouses.map((m) => m.warehouse.id).sort().join();
      if (managedNow !== current.map((c) => c.warehouseId).sort().join()) {
        changes.push(`хянах агуулах → ${row.managedWarehouses.map((m) => m.warehouse.name).join(', ') || 'байхгүй'}`);
      }
      if (passwordHash) changes.push('нууц үг солив');
      if (googleChange) {
        changes.push(row.googleEmail ? `Google Gmail → ${row.googleEmail}` : `Google бүртгэл ${user.googleEmail ?? ''} салгав`);
      }
      if (changes.length) {
        await audit(this.prisma, {
          entityType: 'USER',
          entityId: id,
          summary: `${row.fullName} (${row.username}): ${changes.join('; ')}`,
          before: { role: user.role, isActive: user.isActive, warehouseId: user.warehouseId },
          after: { role: row.role, isActive: row.isActive, warehouseId: row.warehouseId },
          actorId,
        });
      }
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

  /**
   * A branch manager must look after at least one warehouse (home or assigned), or they would see nothing.
   * Other roles keep no extra warehouses: staff work in their home one, admin and general manager see all.
   */
  private async checkManaged(role: Role, home: string | null, ids: string[]): Promise<string[]> {
    if (role !== Role.MANAGER) return [];
    const unique = [...new Set(ids.filter((x) => x && x !== home))];
    for (const id of unique) await this.checkWarehouse(id);
    if (!home && !unique.length) {
      throw new BadRequestException('Салбарын менежерт дор хаяж нэг дэлгүүр/агуулах онооно уу / Assign a branch manager at least one warehouse');
    }
    return unique;
  }

  /**
   * Rights given to or taken from one person on top of their role. Only known rights; only givable rights
   * are given; the admin's own rights never change (the admin always keeps everything). A change of role
   * keeps these, and they are shown against the new role's defaults.
   */
  async setPermissions(id: string, input: { grant?: string[]; revoke?: string[] }, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === Role.ADMIN) throw new BadRequestException('Админы эрхийг өөрчлөхгүй — админ бүх эрхтэй / An admin always has every right');
    const next = normalizeOverrides(input);
    // Nothing to keep when it changes nothing: giving what the role has, or taking what it does not.
    next.grant = next.grant.filter((k) => !roleHas(user.role, k));
    next.revoke = next.revoke.filter((k) => roleHas(user.role, k));
    const before = (user.permissions ?? {}) as { grant?: string[]; revoke?: string[] };
    const row = await this.prisma.user.update({
      where: { id },
      data: { permissions: next.grant.length || next.revoke.length ? next : Prisma.DbNull },
      select: publicUser,
    });
    const label = (keys: string[]) => keys.map((k) => PERMISSIONS[k as keyof typeof PERMISSIONS]?.label ?? k).join(', ');
    const added = next.grant.filter((k) => !before.grant?.includes(k));
    const taken = next.revoke.filter((k) => !before.revoke?.includes(k));
    const restored = [...(before.grant ?? []), ...(before.revoke ?? [])].filter((k) => !next.grant.includes(k as never) && !next.revoke.includes(k as never));
    const parts = [
      added.length ? `нэмсэн: ${label(added)}` : '',
      taken.length ? `хассан: ${label(taken)}` : '',
      restored.length ? `албан тушаалын анхдагч руу буцаасан: ${label(restored)}` : '',
    ].filter(Boolean);
    if (parts.length) {
      await audit(this.prisma, {
        entityType: 'USER_PERMISSIONS',
        entityId: id,
        summary: `${user.fullName} (${user.username}): ${parts.join('; ')}`,
        before: { grant: before.grant ?? [], revoke: before.revoke ?? [] },
        after: next,
        actorId,
      });
    }
    return toStaff(row);
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
