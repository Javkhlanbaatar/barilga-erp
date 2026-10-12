import type { Role } from '@/lib/types';

export const POS_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH'];
export const OVERSIGHT_ROLES: Role[] = ['ADMIN', 'MANAGER'];
export const TRANSPORT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'];
export const FULFILLMENT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];

export function homeForRole(role: Role | null | undefined): string {
  if (!role) return '/login';
  if (role === 'ACHIGCH_BELTGEGCH') return '/warehouse/tickets';
  if (role === 'ADMIN' || role === 'MANAGER') return '/admin';
  return '/pos';
}

export function hasRole(role: Role | null | undefined, allowed: Role[]): role is Role {
  return Boolean(role && allowed.includes(role));
}

/** Send/receive warehouse transfers (staff are limited to their own warehouse by the API). */
export const TRANSFER_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];
