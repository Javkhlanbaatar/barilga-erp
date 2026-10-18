'use client';

import { hasRole } from '@/lib/rbac';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useFeatures } from '@/lib/features';
import { useCan, type PermissionKey } from '@/lib/permissions';
import type { FeatureKey, Role } from '@/lib/types';

/**
 * Every report, who may open it, and the module it belongs to. The single «Тайлан» menu item leads here.
 * `permission`: a right the admin can take from one person (on top of the role check).
 */
export const REPORTS: Array<{ href: string; label: string; hint: string; roles: Role[]; feature?: FeatureKey; permission?: PermissionKey }> = [
  {
    href: '/reports/daily',
    label: 'Борлуулалт',
    hint: 'Орлого төлбөрийн хэлбэрээр, буцаалт, шилдэг бараа',
    roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
    permission: 'REPORT_SALES',
  },
  {
    href: '/reports/returns',
    label: 'Буцаалт',
    hint: 'Буцаасан бараа, шалтгаан, буцаасан мөнгө, хэн хийсэн',
    roles: ['ADMIN', 'MANAGER'],
  },
  {
    href: '/reports/refunds',
    label: 'Буцаах мөнгө',
    hint: 'Буцаалтын мөнгийг харилцагчийн данс руу шилжүүлэх жагсаалт',
    roles: ['ADMIN', 'MANAGER'],
  },
  {
    href: '/reports/cash',
    label: 'Касс',
    hint: 'Ээлж бүрийн касс: байх ёстой, тоолсон, илүү/дутуу',
    roles: ['ADMIN', 'MANAGER'],
    feature: 'CASH_SESSIONS',
  },
  {
    href: '/reports/warehouse',
    label: 'Агуулах',
    hint: 'Эхний/эцсийн үлдэгдэл, орлого, зарлага, шилжүүлэг',
    roles: ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'],
    feature: 'WAREHOUSE_REPORT',
  },
  {
    href: '/reports/fulfillment',
    label: 'Бэлтгэл',
    hint: 'Захиалга бэлтгэсэн хугацаа, ажилтан бүрээр',
    roles: ['ADMIN', 'MANAGER'],
    feature: 'PICKING',
  },
  {
    href: '/reports/accounts',
    label: 'Харилцагчийн тооцоо',
    hint: 'Авлага, өглөг, бартер — хэн хэнд хэдэн төгрөг өртэй',
    roles: ['ADMIN', 'MANAGER'],
    feature: 'PARTNER_ACCOUNTS',
  },
  {
    href: '/reports/partners',
    label: 'Харилцагчийн тайлан',
    hint: 'Авлагын насжилт, борлуулалт харилцагчаар, худалдан авалт нийлүүлэгчээр',
    roles: ['ADMIN', 'MANAGER'],
  },
  {
    href: '/reports/edits',
    label: 'Засварын түүх',
    hint: 'Үнэ, тооцоо, цалин, эрх, тохиргоо, баримтын загварыг хэн, хэзээ өөрчилсөн',
    roles: ['ADMIN', 'SUPER_MANAGER'],
  },
];

/** The reports this user may open (role + right in force + switched-on module). */
export function useAvailableReports() {
  const features = useFeatures();
  const can = useCan();
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (raw) setRole((JSON.parse(raw) as { role: Role }).role);
  }, []);
  return REPORTS.filter(
    (r) => role && hasRole(role, r.roles) && (!r.permission || can(r.permission)) && (!r.feature || features.enabled(r.feature)),
  );
}

/** Tabs across the top of every report page. */
export function ReportsNav() {
  const pathname = usePathname();
  const reports = useAvailableReports();
  if (reports.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-4 print:hidden">
      {reports.map((r) => (
        <Link
          key={r.href}
          href={r.href}
          className={`rounded-md px-3 py-1.5 text-sm ${
            pathname === r.href ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'
          }`}
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}
