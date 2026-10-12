'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CashierSummary } from '@/components/cashier-summary';
import { useFeatures } from '@/lib/features';
import { AuthUser, FeatureKey, ROLE_LABEL } from '@/lib/types';

const NAV: Array<{ href: string; label: string; roles: AuthUser['role'][]; feature?: FeatureKey }> = [
  { href: '/pos', label: 'ПОС / Захиалга', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'] },
  { href: '/orders', label: 'Захиалгууд', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'] },
  { href: '/warehouse/tickets', label: 'Агуулах / тасалбар', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'] },
  { href: '/admin/attendance', label: 'Ирц', roles: ['ADMIN', 'MANAGER'] },
  { href: '/admin/payroll', label: 'Цалин', roles: ['ADMIN', 'MANAGER'] },
  { href: '/reports/daily', label: 'Өдрийн тайлан', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'] },
  { href: '/inventory', label: 'Агуулахын үлдэгдэл', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'] },
  { href: '/inventory/transfers', label: 'Шилжүүлэг', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'], feature: 'STOCK_TRANSFERS' },
  { href: '/customers', label: 'Харилцагчид', roles: ['ADMIN', 'MANAGER', 'BORLUULAGCH'], feature: 'CUSTOMERS' },
  { href: '/admin/warehouses', label: 'Дэлгүүр / агуулах', roles: ['ADMIN'] },
  { href: '/admin/users', label: 'Хэрэглэгчид', roles: ['ADMIN'] },
  { href: '/admin/features', label: 'Модулиуд', roles: ['ADMIN'] },
  { href: '/admin', label: 'Хяналт самбар', roles: ['ADMIN', 'MANAGER'] },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const features = useFeatures();

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const token = localStorage.getItem('barilga_token');
    if (!raw || !token) {
      router.replace('/login');
      return;
    }
    setUser(JSON.parse(raw));
  }, [router]);

  if (!user) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  const visible = NAV.filter((n) => n.roles.includes(user.role) && (!n.feature || features.enabled(n.feature)));
  // The most specific matching link is active (so /inventory/transfers does not also light up /inventory).
  const activeHref = visible
    .filter((n) => pathname === n.href || (n.href !== '/admin' && pathname.startsWith(`${n.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr] print:grid-cols-1">
      <aside className="bg-steel-900 border-r border-slate-800 p-4 flex flex-col print:hidden">
        <div className="mb-8">
          <p className="text-amber-brand text-[10px] tracking-[0.25em] uppercase">Barilga ERP</p>
          <h1 className="font-bold text-lg">Барилга Хангамж</h1>
        </div>
        <nav className="space-y-1 flex-1">
          {visible.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`block rounded-md px-3 py-2 text-sm ${
                n.href === activeHref
                  ? 'bg-amber-brand text-steel-950 font-semibold'
                  : 'hover:bg-steel-800'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-800 pt-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-white leading-snug truncate">
              {user.fullName || user.name}
            </p>
            <span className="mt-1.5 inline-flex rounded-full border border-amber-700/70 bg-amber-950/50 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
              {ROLE_LABEL[user.role]}
            </span>
          </div>
          {user.role === 'BORLUULAGCH' && <CashierSummary />}
          <button
            className="btn-ghost w-full text-xs"
            onClick={() => {
              localStorage.clear();
              router.replace('/login');
            }}
          >
            Гарах
          </button>
        </div>
      </aside>
      <main className="p-6 overflow-auto print:p-0 print:overflow-visible">{children}</main>
    </div>
  );
}
