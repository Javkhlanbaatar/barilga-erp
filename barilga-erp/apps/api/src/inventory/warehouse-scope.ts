import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

type ScopedUser = { role: Role; warehouseId?: string | null };

/** ADMIN and MANAGER oversee every warehouse; everyone else works inside one when they are assigned to it. */
export function seesAllWarehouses(role: Role): boolean {
  return role === Role.ADMIN || role === Role.MANAGER;
}

/**
 * The warehouse a user is locked to, or null when they are not locked (admin/manager, or staff who have not
 * been assigned a warehouse yet — those keep the behaviour they had before warehouses existed).
 */
export function lockedWarehouseId(user: ScopedUser): string | null {
  if (seesAllWarehouses(user.role)) return null;
  return user.warehouseId ?? null;
}

/** Throws when a locked user touches something that belongs to another warehouse. */
export function assertWarehouseAccess(user: ScopedUser, warehouseId: string | null | undefined, defaultWarehouseId?: string) {
  const locked = lockedWarehouseId(user);
  if (!locked) return;
  const actual = warehouseId ?? defaultWarehouseId ?? null;
  if (actual !== locked) {
    throw new ForbiddenException('This belongs to another warehouse');
  }
}
