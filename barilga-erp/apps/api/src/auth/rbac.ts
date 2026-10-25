import { Role } from '@prisma/client';

/** Cashiers create orders, pick zones, and override calculated fees. */
export const CASHIER_ROLES = [Role.BORLUULAGCH] as const;

/** POS checkout: cashiers plus managers/admin covering the till. */
export const POS_ROLES = [Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH] as const;

export function isPosActor(role: Role) {
  return role === Role.ADMIN || role === Role.MANAGER || role === Role.BORLUULAGCH;
}

/** Dedicated warehouse loaders plus admin (original picker roles). */
export const WAREHOUSE_ROLES = [Role.ACHIGCH_BELTGEGCH, Role.ADMIN] as const;

/** Warehouse absent: cashiers and managers may pack and complete tickets. */
export const FULFILLMENT_ROLES = [
  Role.ACHIGCH_BELTGEGCH,
  Role.ADMIN,
  Role.MANAGER,
  Role.BORLUULAGCH,
] as const;

export function isWarehouseActor(role: Role) {
  return (
    role === Role.ACHIGCH_BELTGEGCH ||
    role === Role.ADMIN ||
    role === Role.MANAGER ||
    role === Role.BORLUULAGCH
  );
}

export function isFallbackPicker(role: Role) {
  return role === Role.MANAGER || role === Role.BORLUULAGCH;
}

export const OVERSIGHT_ROLES = [Role.ADMIN, Role.MANAGER] as const;

/** System actor for anonymous web orders (never a real staff member). */
export const WEBSHOP_USERNAME = 'webshop';

/** Create, update, deactivate, and image-upload catalog products. */
export const CATALOG_WRITE_ROLES = [Role.ADMIN, Role.MANAGER] as const;

/**
 * Standalone hired-truck notes (PATCH assign-transport).
 * Cashiers supply plate/phone only as part of fulfillment complete, not as dispatchers.
 */
export const TRANSPORT_ROLES = [Role.ADMIN, Role.MANAGER, Role.ACHIGCH_BELTGEGCH] as const;

export function isTransportActor(role: Role) {
  return role === Role.ADMIN || role === Role.MANAGER || role === Role.ACHIGCH_BELTGEGCH;
}

export function isHiredTransport(method: string) {
  return method === 'OUR_DELIVERY' || method === 'DELIVERY';
}

export const ORDER_READ_ROLES = [Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH] as const;

/** Authenticated catalog reads (POS, inventory, quotes). */
export const CATALOG_READ_ROLES = [
  Role.ADMIN,
  Role.MANAGER,
  Role.BORLUULAGCH,
  Role.ACHIGCH_BELTGEGCH,
] as const;

export const REPORT_ROLES = [Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH] as const;

/**
 * Send and receive warehouse transfers. Staff are further limited to their own warehouse
 * (TransfersService); cancelling is OVERSIGHT_ROLES only.
 */
export const TRANSFER_ROLES = [
  Role.ADMIN,
  Role.MANAGER,
  Role.ACHIGCH_BELTGEGCH,
  Role.BORLUULAGCH,
] as const;

/** Cashiers, managers, and admin can process sales returns. */
export const RETURN_ROLES = [Role.ADMIN, Role.MANAGER, Role.BORLUULAGCH] as const;
