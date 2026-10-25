'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isUnknownBuyer } from '@/components/invoice-doc';
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
  // Only invoices with no buyer attached yet (printed with blank lines; the buyer is added on the order).
  const [noBuyer, setNoBuyer] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

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

  const rows = useMemo(() => (data?.invoices ?? []).filter((i) => !noBuyer || !i.customerId), [data, noBuyer]);
  const noBuyerCount = useMemo(() => (data?.invoices ?? []).filter((i) => !i.customerId && i.state !== 'CANCELLED').length, [data]);
  // Same sums as the server's, over the rows shown (so the «Төлөгчгүй» filter is reflected too).
  const totals = useMemo(() => {
    const t = { totalMnt: 0, owedMnt: 0, overdueMnt: 0 };
    for (const r of rows) {
      if (r.state === 'CANCELLED') continue;
      t.totalMnt += r.order.totalMnt;
      t.owedMnt += r.owedMnt;
      if (r.state === 'OVERDUE') t.overdueMnt += r.owedMnt;
    }
    return t;
  }, [rows]);

  async function recordSent(i: Invoice, via: 'LINK' | 'PRINT') {
    try {
      await api(`/invoices/${i.id}/sent`, { method: 'POST', body: JSON.stringify({ via }) });
      void load();
    } catch {
      // the link was still copied / the page still opened
    }
  }

  async function copyLink(i: Invoice) {
    const link = `${window.location.origin}${i.publicPath}`;
    const text = `Нэхэмжлэх ${i.invoiceNumber} — ${tugrik(i.owedMnt > 0 ? i.owedMnt : i.order.totalMnt)}. Гүйлгээний утга: ${i.invoiceNumber}. ${link}`;
    try {
      await navigator.clipboard.writeText(text);
      setMsg(`${i.invoiceNumber}: холбоос хуулагдлаа — Viber, Messenger, SMS-д буулгаж илгээнэ үү.`);
      window.setTimeout(() => setMsg(''), 4000);
    } catch {
      window.prompt('Холбоосыг хуулж илгээнэ үү:', text);
    }
    await recordSent(i, 'LINK');
  }

  function printIt(i: Invoice) {
    window.open(`/print/orders/${i.orderId}?doc=invoice`, '_blank', 'noopener');
    void recordSent(i, 'PRINT');
  }

  const stateBadge = (i: Invoice) => (
    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLASS[i.state]}`}>{INVOICE_STATE_LABEL[i.state as InvoiceState]}</span>
  );

  const buyerCell = (i: Invoice) =>
    i.customer ? (
      <Link href={`/customers?focus=${i.customer.id}`} className="hover:underline">
        {i.order.customerName}
      </Link>
    ) : (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="rounded border border-amber-700 px-1.5 py-0.5 text-[11px] text-amber-300">Төлөгчгүй</span>
        {!isUnknownBuyer(i.order.customerName) && <span className="text-slate-400">{i.order.customerName}</span>}
      </span>
    );

  /** Copy link · print · open the order (to add the buyer or press «Мөнгө орсон» when the money arrives). */
  const actions = (i: Invoice, size: 'sm' | 'xs') => {
    const cls = size === 'xs' ? 'text-xs px-2.5' : 'text-sm';
    const live = i.state !== 'CANCELLED';
    return (
      <>
        {live && (
          <button type="button" className={`btn-ghost ${cls}`} onClick={() => void copyLink(i)}>
            Холбоос хуулах
          </button>
        )}
        {live && (
          <button type="button" className={`btn-ghost ${cls}`} onClick={() => printIt(i)}>
            Хэвлэх / PDF
          </button>
        )}
        <Link href={`/orders/${i.orderId}`} className={`btn-primary ${cls}`}>
          {live && !i.customerId ? 'Төлөгч нэмэх →' : live && i.owedMnt > 0 ? 'Төлбөр батлах →' : 'Захиалга →'}
        </Link>
      </>
    );
  };

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">Нэхэмжлэх</h2>
          <p className="text-sm text-slate-400">
            Шинэ нэхэмжлэх: «+ Шинэ нэхэмжлэх» дарж бараагаа сонгоно (касс дээр «Нэхэмжлэх» төлбөр). Төлөгчийг дараа нь нэмж болно.
          </p>
        </div>
        <Link href="/pos?pay=INVOICE" className="btn-primary w-full text-sm sm:w-auto">
          + Шинэ нэхэмжлэх
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map(([key, label]) => (
          <button key={key || 'all'} type="button" className={tab === key ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <button
          type="button"
          className={noBuyer ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
          aria-pressed={noBuyer}
          onClick={() => setNoBuyer((v) => !v)}
        >
          {noBuyer ? '✓ ' : ''}Төлөгчгүй{data ? ` (${noBuyerCount})` : ''}
        </button>
        <input
          className="w-full sm:ml-auto sm:w-64"
          type="search"
          placeholder="Дугаар, харилцагч, имэйл…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <p className="-mt-2 mb-3 text-xs text-slate-400">
        {noBuyer
          ? 'Төлөгч нэмээгүй нэхэмжлэх — хэвлэхэд төлөгчийн мөр хоосон гарсан. «Төлөгч нэмэх» дарж захиалга дээр ононо.'
          : '«Төлбөр батлах» — захиалгыг нээгээд, мөнгө дансанд орсон бол «Мөнгө орсон» дарна. Тэгэхэд бараа олгогдоно.'}
      </p>

      {/* Phones: one compact box with three lines; wider screens: three boxes. */}
      {data && (
        <div className="mb-4 grid grid-cols-1 divide-y divide-slate-800 rounded-xl border border-slate-700/80 bg-steel-900 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {(
            [
              ['Нийт дүн', totals.totalMnt, ''],
              ['Төлөгдөөгүй үлдэгдэл', totals.owedMnt, 'text-amber-300'],
              ['Үүнээс хугацаа хэтэрсэн', totals.overdueMnt, 'text-red-300'],
            ] as const
          ).map(([label, value, cls]) => (
            <div key={label} className="flex items-baseline justify-between gap-2 px-3 py-2 sm:block sm:p-4">
              <p className="text-xs text-slate-400">{label}</p>
              <p className={`font-bold sm:text-xl ${cls}`}>{tugrik(value)}</p>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {msg && <p className="mb-3 text-sm text-emerald-300">{msg}</p>}

      {/* Phones: one card per invoice. */}
      <div className="space-y-2 md:hidden">
        {rows.map((i) => (
          <article key={i.id} className="card space-y-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/orders/${i.orderId}`} className="font-mono text-amber-brand hover:underline">
                  {i.invoiceNumber}
                </Link>
                <p className="text-[11px] text-slate-500">
                  {i.order.orderNumber} · {day(i.createdAt)}
                </p>
              </div>
              {stateBadge(i)}
            </div>
            <div className="text-sm">{buyerCell(i)}</div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span>
                Дүн <b>{tugrik(i.order.totalMnt)}</b>
              </span>
              {i.owedMnt > 0 && (
                <span className="text-amber-300">
                  Үлдэгдэл <b>{tugrik(i.owedMnt)}</b>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Төлөх хугацаа: <span className={i.state === 'OVERDUE' ? 'text-red-300' : 'text-slate-200'}>{day(i.dueDate)}</span>
              {(i.recipientEmail || i.recipientPhone) && ` · ${i.recipientEmail ?? i.recipientPhone}`}
              {i.viewedAt && <span className="text-sky-300"> · төлөгч нээсэн</span>}
            </p>
            <div className="grid grid-cols-2 gap-2 [&>*:last-child]:col-span-2">{actions(i, 'sm')}</div>
          </article>
        ))}
        {data && rows.length === 0 && <p className="card text-sm text-slate-500">Нэхэмжлэх алга.</p>}
      </div>

      <div className="card hidden p-0 md:block">
        <div className="table-scroll">
          <table className="w-full text-sm [&_td]:px-2 [&_th]:whitespace-nowrap [&_th]:px-2">
            <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
              <tr>
                <th className="p-3">Дугаар</th>
                <th>Огноо</th>
                <th>Төлөгч</th>
                <th>Хаашаа илгээсэн</th>
                <th>Төлөх хугацаа</th>
                <th className="text-right">Дүн</th>
                <th className="text-right">Үлдэгдэл</th>
                <th className="px-3">Төлөв</th>
                <th className="pr-3 text-right">Үйлдэл</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="border-t border-slate-800 hover:bg-steel-800">
                  <td className="p-3">
                    <Link href={`/orders/${i.orderId}`} className="font-mono text-amber-brand hover:underline">
                      {i.invoiceNumber}
                    </Link>
                    <p className="text-[11px] text-slate-500">{i.order.orderNumber}</p>
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-400">{day(i.createdAt)}</td>
                  <td>{buyerCell(i)}</td>
                  <td className="text-xs text-slate-400">
                    {i.recipientEmail ?? i.recipientPhone ?? '—'}
                    {i.viewedAt && <span className="ml-1 text-sky-300">· нээсэн</span>}
                  </td>
                  <td className={`whitespace-nowrap text-xs ${i.state === 'OVERDUE' ? 'text-red-300' : ''}`}>{day(i.dueDate)}</td>
                  <td className="whitespace-nowrap text-right">{tugrik(i.order.totalMnt)}</td>
                  <td className="whitespace-nowrap text-right">{i.owedMnt > 0 ? tugrik(i.owedMnt) : '—'}</td>
                  <td className="px-3">{stateBadge(i)}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap justify-end gap-1.5">{actions(i, 'xs')}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && rows.length === 0 && <p className="p-4 text-sm text-slate-500">Нэхэмжлэх алга.</p>}
      </div>
    </Shell>
  );
}
