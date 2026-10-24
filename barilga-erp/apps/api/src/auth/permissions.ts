import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { roleAllowed } from './rbac';

const { ADMIN, SUPER_MANAGER, MANAGER, BORLUULAGCH, ACHIGCH_BELTGEGCH } = Role;
const TOP = [ADMIN, SUPER_MANAGER];
const OVERSIGHT = [ADMIN, MANAGER];
const POS = [ADMIN, MANAGER, BORLUULAGCH];

/**
 * Rights the admin can add to or take from one person, on top of what their role allows.
 *
 * - `roles`: who has it by default — exactly the roles the endpoint allowed before, so nothing changes until
 *   the admin changes someone.
 * - `grantable`: may be given to someone whose role does not have it. Rights that move money out, set pay or
 *   cannot be checked safely for other roles are only ever taken away, never given.
 *
 * The admin always keeps every right (so the admin can never lock the system).
 */
export const PERMISSIONS = {
  PRODUCT_WRITE: { group: 'Бараа, үнэ', label: 'Бараа нэмэх, засах, идэвхгүй болгох (үнэ, ангилал, хэмжээ, жин)', roles: TOP, grantable: true },
  PRICE_LIST_WRITE: { group: 'Бараа, үнэ', label: 'Үнийн жагсаалт үүсгэх, үнэ засах, илгээх', roles: TOP, grantable: true },
  PRICE_OVERRIDE: {
    group: 'Бараа, үнэ',
    label: 'Касс дээр барааны үнэ өөрчлөх (өртгөөс доош биш; харилцагч сонгосон бол түүний хувийн үнэ болно)',
    roles: OVERSIGHT,
    grantable: true,
  },
  ORDER_CANCEL: { group: 'Борлуулалт', label: 'Захиалга цуцлах', roles: POS, grantable: false },
  RETURN_CREATE: { group: 'Борлуулалт', label: 'Буцаалт хийх', roles: POS, grantable: false },
  FEE_OVERRIDE: { group: 'Борлуулалт', label: 'Хүргэлт, буулгалтын төлбөрийг гараар өөрчлөх', roles: [BORLUULAGCH], grantable: false },
  INVOICE_CANCEL: { group: 'Борлуулалт', label: 'Нэхэмжлэх цуцлах', roles: OVERSIGHT, grantable: false },
  PAY_DEBT: { group: 'Мөнгө', label: 'Зээлээр авсан барааны төлбөр авах (өр төлүүлэх)', roles: POS, grantable: false },
  CASH_MOVEMENT: { group: 'Мөнгө', label: 'Кассаас мөнгө гаргах, касс руу мөнгө оруулах', roles: POS, grantable: false },
  PARTNER_LEDGER: { group: 'Мөнгө', label: 'Харилцагчийн тооцоо бичих (төлбөр, авлага, хасалт, залруулга)', roles: OVERSIGHT, grantable: false },
  RECEIPT_CREATE: { group: 'Агуулах', label: 'Бараа орлого авах', roles: [ADMIN, MANAGER, ACHIGCH_BELTGEGCH], grantable: true },
  RECEIPT_COST_EDIT: { group: 'Агуулах', label: 'Орлогын өртөг (худалдан авсан үнэ) оруулах, засах', roles: OVERSIGHT, grantable: true },
  STOCK_ADJUST: { group: 'Агуулах', label: 'Барааны үлдэгдэл тохируулах (тооллого)', roles: OVERSIGHT, grantable: false },
  ATTENDANCE_MANAGE: { group: 'Ажилтан', label: 'Ирц бүртгэх, засах', roles: OVERSIGHT, grantable: true },
  PAYROLL_ADJUST: { group: 'Ажилтан', label: 'Цалингийн урамшуулал, суутгал бичих', roles: OVERSIGHT, grantable: false },
  SALARY_SET: { group: 'Ажилтан', label: 'Үндсэн цалин тогтоох, цалин олгосон гэж бүртгэх', roles: TOP, grantable: false },
  DOC_TEMPLATE_EDIT: { group: 'Тохиргоо', label: 'Баримтын загвар засах', roles: TOP, grantable: false },
  REPORT_SALES: { group: 'Тайлан', label: 'Борлуулалтын тайлан харах', roles: POS, grantable: false },
} as const satisfies Record<string, { group: string; label: string; roles: readonly Role[]; grantable: boolean }>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** What the admin set for one person (sys_users.permissions). */
export type PermissionOverrides = { grant?: string[]; revoke?: string[] } | null | undefined;

type Subject = { role: Role; permissions?: PermissionOverrides };

export function isPermissionKey(key: string): key is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

/** The role's own answer, before anything set for the person. */
export function roleHas(role: Role, key: PermissionKey) {
  return roleAllowed(role, PERMISSIONS[key].roles);
}

/** May this person do it: taken away → no; given (and givable) → yes; otherwise as their role. */
export function can(user: Subject, key: PermissionKey): boolean {
  if (user.role === ADMIN) return true;
  const o = user.permissions ?? {};
  if (o.revoke?.includes(key)) return false;
  if (PERMISSIONS[key].grantable && o.grant?.includes(key)) return true;
  return roleHas(user.role, key);
}

export function assertCan(user: Subject, key: PermissionKey) {
  if (!can(user, key)) throw new ForbiddenException(`Танд «${PERMISSIONS[key].label}» эрх байхгүй / Permission ${key} is required`);
}

/** Every right this person has now (sent to the web so it shows only what works). */
export function effectivePermissions(user: Subject): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => can(user, k));
}

/** Cleans what the admin sends: known keys only, nothing both given and taken, and only givable rights given. */
export function normalizeOverrides(input: { grant?: string[]; revoke?: string[] }) {
  const revoke = [...new Set((input.revoke ?? []).filter(isPermissionKey))];
  const grant = [...new Set((input.grant ?? []).filter(isPermissionKey))].filter((k) => PERMISSIONS[k].grantable && !revoke.includes(k));
  return { grant, revoke };
}

export const PERMISSION_KEY_META = 'permission';
export type PermissionRule = { key: PermissionKey; alsoRoles: Role[] };
/**
 * Gate an endpoint by a right instead of a fixed list of roles (RolesGuard checks it; it takes the place of
 * @Roles on the same handler or class). `alsoRoles` keep reading open to roles that could read before
 * (e.g. branch managers see price lists they cannot change).
 */
export const Permission = (key: PermissionKey, ...alsoRoles: Role[]) => SetMetadata(PERMISSION_KEY_META, { key, alsoRoles } satisfies PermissionRule);
