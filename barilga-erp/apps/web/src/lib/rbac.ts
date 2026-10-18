import type { Role } from '@/lib/types';

export const POS_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH'];
/** Admin and the general manager: prices, price lists, salaries — things shared by every shop. */
export const TOP_ROLES: Role[] = ['ADMIN', 'SUPER_MANAGER'];
export const OVERSIGHT_ROLES: Role[] = ['ADMIN', 'MANAGER'];
export const TRANSPORT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'];
export const FULFILLMENT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];

export function homeForRole(role: Role | null | undefined): string {
  if (!role) return '/login';
  if (role === 'ACHIGCH_BELTGEGCH') return '/warehouse/tickets';
  if (role === 'ADMIN' || role === 'SUPER_MANAGER' || role === 'MANAGER') return '/admin';
  return '/pos';
}

/** The general manager passes everything a branch manager (MANAGER) may do; same rule as the API. */
export function hasRole(role: Role | null | undefined, allowed: Role[]): role is Role {
  return Boolean(role && (allowed.includes(role) || (role === 'SUPER_MANAGER' && allowed.includes('MANAGER'))));
}

/** Admin, general or branch manager. */
export function isManager(role: Role | null | undefined): boolean {
  return hasRole(role, OVERSIGHT_ROLES);
}

/** Send/receive warehouse transfers (staff are limited to their own warehouse by the API). */
export const TRANSFER_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];
