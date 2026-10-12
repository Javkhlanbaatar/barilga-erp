'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STATE_CLASS } from '@/components/invoice-panel';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, POS_ROLES } from '@/lib/rbac';
import { AuthUser, INVOICE_STATE_LABEL, Invoice, InvoiceState } from '@/lib/types';

type ListResponse = { invoices: Invoice[]; totals: { totalMnt: number; owedMnt: number; overdueMnt: number } };

const TABS: Array<[string, string]> = [
  ['OPEN', 'Төлөгдөөгүй'],
  ['OVERDUE', 'Хугацаа хэтэрсэн'],
  ['PAID', 'Төлөгдсөн'],
  ['', 'Бүгд'],
];

const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(iso)) : '—');

/** Every invoice sent: to whom, how, whether the buyer opened it, and what is still unpaid. */
export default function InvoicesPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('OPEN');
  const [q, setQ] = useState('');
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (!hasRole(me.role, POS_ROLES)) {
      router.replace(homeForRole(me.role));
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      setError('');
      const params = new URLSearchParams();
      if (tab) params.set('state', tab);
      if (q.trim()) params.set('q', q.trim());
      setData(await api<ListResponse>(`/invoices?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [tab, q]);

  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(t);
  }, [ready, load]);

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Нэхэмжлэх</h2>
          <p className="text-sm text-slate-400">
            Шинэ нэхэмжлэхийг ПОС дээр «Нэхэмжлэхээр» гэж, эсвэл захиалгын хуудаснаас үүсгэнэ.
          </p>
        </div>
        <input className="w-64" placeholder="Дугаар, харилцагч, имэйл…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map(([key, label]) => (
          <button key={key || 'all'} className={tab === key ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <article className="card">
            <p className="text-xs text-slate-400">Нийт дүн</p>
            <p className="text-xl font-bold">{tugrik(data.totals.totalMnt)}</p>
          </article>
          <article className="card">
            <p className="text-xs text-slate-400">Төлөгдөөгүй үлдэгдэл</p>
            <p className="text-xl font-bold text-amber-300">{tugrik(data.totals.owedMnt)}</p>
          </article>
          <article className="card">
            <p className="text-xs text-slate-400">Үүнээс хугацаа хэтэрсэн</p>
            <p className="text-xl font-bold text-red-300">{tugrik(data.totals.overdueMnt)}</p>
          </article>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Огноо</th>
              <th>Харилцагч</th>
              <th>Хаана илгээсэн</th>
              <th>Төлөх хугацаа</th>
              <th className="text-right">Дүн</th>
              <th className="text-right">Үлдэгдэл</th>
              <th className="pr-3">Төлөв</th>
            </tr>
          </thead>
          <tbody>
            {data?.invoices.map((i) => (
              <tr key={i.id} className="border-t border-slate-800 hover:bg-steel-800">
                <td className="p-3">
                  <Link href={`/orders/${i.orderId}`} className="font-mono text-amber-brand hover:underline">
                    {i.invoiceNumber}
                  </Link>
                  <p className="text-[11px] text-slate-500">{i.order.orderNumber}</p>
                </td>
                <td className="whitespace-nowrap text-xs text-slate-400">{day(i.createdAt)}</td>
                <td>
                  {i.customer ? (
                    <Link href={`/customers?focus=${i.customer.id}`} className="hover:underline">
                      {i.order.customerName}
                    </Link>
                  ) : (
                    i.order.customerName
                  )}
                </td>
                <td className="text-xs text-slate-400">
                  {i.recipientEmail ?? i.recipientPhone ?? '—'}
                  {i.viewedAt && <span className="ml-1 text-sky-300">· нээсэн</span>}
                </td>
                <td className="whitespace-nowrap text-xs">{day(i.dueDate)}</td>
                <td className="text-right whitespace-nowrap">{tugrik(i.order.totalMnt)}</td>
                <td className="text-right whitespace-nowrap">{i.owedMnt > 0 ? tugrik(i.owedMnt) : '—'}</td>
                <td className="pr-3">
                  <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLASS[i.state]}`}>
                    {INVOICE_STATE_LABEL[i.state as InvoiceState]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.invoices.length === 0 && <p className="p-4 text-sm text-slate-500">Нэхэмжлэх алга.</p>}
      </div>
    </Shell>
  );
}
