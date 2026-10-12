'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useFeatures } from '@/lib/features';
import type { FeatureKey, Role } from '@/lib/types';

/** Every report, who may open it, and the module it belongs to. The single «Тайлан» menu item leads here. */
export const REPORTS: Array<{ href: string; label: string; hint: string; roles: Role[]; feature?: FeatureKey }> = [
  {
    href: '/reports/daily',
    label: 'Борлуулалт',
    hint: 'Орлого төлбөрийн хэлбэрээр, буцаалт, шилдэг бараа',
    roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'],
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
    href: '/reports/edits',
    label: 'Засварын түүх',
    hint: 'Худалдан авсан үнэ, тооцооны мөрийг хэн, хэзээ, яагаад өөрчилсөн',
    roles: ['ADMIN'],
  },
];

/** The reports this user may open (role + switched-on module). */
export function useAvailableReports() {
  const features = useFeatures();
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (raw) setRole((JSON.parse(raw) as { role: Role }).role);
  }, []);
  return REPORTS.filter((r) => role && r.roles.includes(role) && (!r.feature || features.enabled(r.feature)));
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
