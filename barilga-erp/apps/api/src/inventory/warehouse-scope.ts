import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

/**
 * `warehouseIds` is filled in at login time (JwtStrategy): the warehouses this person may see and act for.
 * When it is absent (older callers, tests) the home `warehouseId` alone is used.
 */
export type ScopedUser = { role: Role; warehouseId?: string | null; warehouseIds?: string[] | null };

/** Admin and the general manager (Ерөнхий менежер) oversee every warehouse. */
export function isTopRole(role: Role): boolean {
  return role === Role.ADMIN || role === Role.SUPER_MANAGER;
}

/** Manager-level authority (costs, cancelling transfers, customer terms…): admin, general and branch managers. */
export function isManagerRole(role: Role): boolean {
  return isTopRole(role) || role === Role.MANAGER;
}

/**
 * The warehouses a user may see and act for, or null for every warehouse (admin and general manager).
 * A branch manager sees the warehouses assigned to them; other staff see their own warehouse. Staff not yet
 * assigned to any warehouse fall back to the default one at login (see JwtStrategy).
 */
export function allowedWarehouseIds(user: ScopedUser): string[] | null {
  if (isTopRole(user.role)) return null;
  if (user.warehouseIds) return user.warehouseIds;
  return user.warehouseId ? [user.warehouseId] : null;
}

/**
 * Strict variant for moving stock (receipts, transfers, the warehouse report): null only for admin and the
 * general manager; anyone else not assigned to a warehouse gets [] and is refused.
 */
export function assignedWarehouseIds(user: ScopedUser): string[] | null {
  if (isTopRole(user.role)) return null;
  return user.warehouseIds ?? (user.warehouseId ? [user.warehouseId] : []);
}

/** True when the user is not limited to particular warehouses. */
export function seesAllWarehouses(user: ScopedUser): boolean {
  return allowedWarehouseIds(user) === null;
}

/**
 * May the user touch something that belongs to `warehouseId`? Rows from before warehouses existed
 * (warehouseId null) belong to the default warehouse.
 */
export function canAccessWarehouse(user: ScopedUser, warehouseId: string | null | undefined, defaultWarehouseId?: string | null) {
  const allowed = allowedWarehouseIds(user);
  if (!allowed) return true;
  const actual = warehouseId ?? defaultWarehouseId ?? null;
  return actual !== null && allowed.includes(actual);
}

/** Throws when a scoped user touches something that belongs to another warehouse. */
export function assertWarehouseAccess(user: ScopedUser, warehouseId: string | null | undefined, defaultWarehouseId?: string | null) {
  if (!canAccessWarehouse(user, warehouseId, defaultWarehouseId)) {
    throw new ForbiddenException('This belongs to another warehouse');
  }
}

/**
 * Prisma filter on a `warehouseId` column for the user's warehouses ({} = no limit). Rows with no warehouse
 * belong to the default warehouse, so they are included when the default is one of the user's.
 */
export function warehouseWhere(user: ScopedUser, defaultWarehouseId?: string | null): { warehouseId?: unknown; OR?: unknown[] } {
  const allowed = allowedWarehouseIds(user);
  if (!allowed) return {};
  const inList = { warehouseId: { in: allowed } };
  return defaultWarehouseId && allowed.includes(defaultWarehouseId) ? { OR: [inList, { warehouseId: null }] } : inList;
}

/** Same as warehouseWhere, typed for orders. */
export function orderWarehouseWhere(user: ScopedUser, defaultWarehouseId?: string | null): Prisma.OrderWhereInput {
  return warehouseWhere(user, defaultWarehouseId) as Prisma.OrderWhereInput;
}

/** The warehouse a user acts for when they do not name one: their home, else their first assigned one. */
export function homeWarehouseId(user: ScopedUser): string | null {
  return user.warehouseId ?? allowedWarehouseIds(user)?.[0] ?? null;
}
