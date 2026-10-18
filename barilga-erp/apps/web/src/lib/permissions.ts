'use client';

import { useEffect, useState } from 'react';
import { hasRole } from '@/lib/rbac';
import type { AuthUser, Role } from '@/lib/types';

/** Rights the admin can give or take per person (same keys as the API's auth/permissions.ts). */
export type PermissionKey =
  | 'PRODUCT_WRITE'
  | 'PRICE_LIST_WRITE'
  | 'ORDER_CANCEL'
  | 'RETURN_CREATE'
  | 'FEE_OVERRIDE'
  | 'INVOICE_CANCEL'
  | 'PAY_DEBT'
  | 'CASH_MOVEMENT'
  | 'PARTNER_LEDGER'
  | 'RECEIPT_CREATE'
  | 'RECEIPT_COST_EDIT'
  | 'STOCK_ADJUST'
  | 'ATTENDANCE_MANAGE'
  | 'PAYROLL_ADJUST'
  | 'SALARY_SET'
  | 'DOC_TEMPLATE_EDIT'
  | 'REPORT_SALES';

/** One right as GET /auth/permissions lists it. */
export type PermissionInfo = { key: PermissionKey; group: string; label: string; roles: Role[]; grantable: boolean };

/** Role defaults, used only until the server has said what this person may do (older saved logins). */
const ROLE_DEFAULTS: Record<PermissionKey, Role[]> = {
  PRODUCT_WRITE: ['ADMIN', 'SUPER_MANAGER'],
  PRICE_LIST_WRITE: ['ADMIN', 'SUPER_MANAGER'],
  ORDER_CANCEL: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
  RETURN_CREATE: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
  FEE_OVERRIDE: ['BORLUULAGCH'],
  INVOICE_CANCEL: ['ADMIN', 'MANAGER'],
  PAY_DEBT: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
  CASH_MOVEMENT: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
  PARTNER_LEDGER: ['ADMIN', 'MANAGER'],
  RECEIPT_CREATE: ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'],
  RECEIPT_COST_EDIT: ['ADMIN', 'MANAGER'],
  STOCK_ADJUST: ['ADMIN', 'MANAGER'],
  ATTENDANCE_MANAGE: ['ADMIN', 'MANAGER'],
  PAYROLL_ADJUST: ['ADMIN', 'MANAGER'],
  SALARY_SET: ['ADMIN', 'SUPER_MANAGER'],
  DOC_TEMPLATE_EDIT: ['ADMIN', 'SUPER_MANAGER'],
  REPORT_SALES: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
};

/** The signed-in person as saved at login (with `can`, the rights in force, refreshed by the Shell). */
export function savedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem('barilga_user');
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

/** May this person do it? The server decides; this only hides what would be refused. */
export function can(user: Pick<AuthUser, 'role' | 'can'> | null | undefined, key: PermissionKey): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (Array.isArray(user.can)) return user.can.includes(key);
  return hasRole(user.role, ROLE_DEFAULTS[key]);
}

/** `can` for the signed-in person, updated when the Shell refreshes their rights. */
export function useCan() {
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    setUser(savedUser());
    const onChange = () => setUser(savedUser());
    window.addEventListener('barilga-user', onChange);
    return () => window.removeEventListener('barilga-user', onChange);
  }, []);
  return (key: PermissionKey) => can(user, key);
}

/** Saves fresh rights from GET /auth/me and tells open pages. */
export function storeRights(me: Partial<AuthUser> & { can?: string[] }) {
  const current = savedUser();
  if (!current) return;
  const next = { ...current, can: me.can ?? current.can, role: (me.role as Role) ?? current.role };
  if (JSON.stringify(next.can) === JSON.stringify(current.can) && next.role === current.role) return;
  localStorage.setItem('barilga_user', JSON.stringify(next));
  window.dispatchEvent(new Event('barilga-user'));
}
