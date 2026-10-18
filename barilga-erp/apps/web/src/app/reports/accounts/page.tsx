'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

type Balances = {
  partners: Array<{
    id: string;
    name: string;
    phone: string;
    barterContract: string | null;
    sellsToUs: boolean;
    creditAllowed: boolean;
    receivableMnt: number;
    payableMnt: number;
    netMnt: number;
  }>;
  totals: { receivableMnt: number; payableMnt: number };
};

/** Every partner with an open position: what they owe us, what we owe them, and the net. */
export default function AccountsReportPage() {
  const router = useRouter();
  const [data, setData] = useState<Balances | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (!hasRole(me.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(me.role));
      return;
    }
    api<Balances>('/accounts')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [router]);

  return (
    <Shell>
      <ReportsNav />
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-bold">Харилцагчийн тооцоо</h2>
          <p className="text-slate-400 text-sm mt-1">
            Авлага = тэд бидэнд өртэй (дараа төлөхөөр авсан) · Өглөг = бид тэдэнд өртэй (тэднээс авсан бараа). Хуулгыг харилцагчийн хуудаснаас харна.
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <button
            className="btn-ghost"
            disabled={!data}
            onClick={() =>
              data &&
              downloadCsv(
                `hariltsagchiin-tootsoo-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date())}`,
                ['Харилцагч', 'Утас', 'Авлага', 'Өглөг', 'Цэвэр (+ тэд бидэнд)'],
                data.partners.map((p) => [p.name, p.phone, p.receivableMnt, p.payableMnt, p.netMnt]),
              )
            }
          >
            Excel
          </button>
          <button className="btn-ghost" onClick={() => window.print()}>
            🖨 Хэвлэх
          </button>
        </div>
      </div>
      {error && <p className="text-red-400 mb-3">{error}</p>}
      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-3 mb-4">
            <article className="card py-3">
              <p className="text-[10px] uppercase text-slate-400">Нийт авлага</p>
              <p className="text-lg font-bold text-amber-300">{tugrik(data.totals.receivableMnt)}</p>
            </article>
            <article className="card py-3">
              <p className="text-[10px] uppercase text-slate-400">Нийт өглөг</p>
              <p className="text-lg font-bold text-sky-300">{tugrik(data.totals.payableMnt)}</p>
            </article>
            <article className="card py-3">
              <p className="text-[10px] uppercase text-slate-400">Цэвэр</p>
              <p className="text-lg font-bold">{tugrik(data.totals.receivableMnt - data.totals.payableMnt)}</p>
            </article>
          </section>
          <div className="card p-0 overflow-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-left text-xs text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="p-2">Харилцагч</th>
                  <th>Төрөл</th>
                  <th className="text-right">Авлага</th>
                  <th className="text-right">Өглөг</th>
                  <th className="text-right pr-3">Цэвэр</th>
                </tr>
              </thead>
              <tbody>
                {data.partners.map((p) => (
                  <tr key={p.id} className="border-t border-slate-800">
                    <td className="p-2">
                      <Link href={`/customers?focus=${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                      <span className="block text-xs text-slate-500">{p.phone}</span>
                    </td>
                    <td className="text-xs text-slate-300">
                      {[p.creditAllowed && 'Дараа төлөх', p.sellsToUs && 'Нийлүүлэгч', p.barterContract && `Бартер ${p.barterContract}`]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="text-right text-amber-300">{p.receivableMnt ? tugrik(p.receivableMnt) : '—'}</td>
                    <td className="text-right text-sky-300">{p.payableMnt ? tugrik(p.payableMnt) : '—'}</td>
                    <td className={`text-right pr-3 font-semibold ${p.netMnt > 0 ? 'text-amber-300' : p.netMnt < 0 ? 'text-sky-300' : ''}`}>
                      {p.netMnt > 0 ? `${tugrik(p.netMnt)} бидэнд` : p.netMnt < 0 ? `${tugrik(-p.netMnt)} бид` : '0₮'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.partners.length === 0 && <p className="p-3 text-slate-500 text-sm">Нээлттэй тооцоо алга.</p>}
          </div>
        </>
      )}
    </Shell>
  );
}
