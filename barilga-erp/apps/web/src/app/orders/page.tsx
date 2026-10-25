'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { useFeatures } from '@/lib/features';
import { ORDER_STATUS_LABEL, Order, VEHICLE_LABEL } from '@/lib/types';

const PAY_LABEL: Record<string, string> = { QPAY: 'QPay', CASH: 'Бэлэн', CARD: 'Карт', TRANSFER: 'Шилжүүлэг', CREDIT: 'Зээл', OFFSET: 'Тооцоогоор' };
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));

/** How an order was paid, in one line: "Бэлэн 50,000₮ · Зээл 20,000₮"; unpaid parts are marked. */
function payments(o: Order) {
  const rows = (o.payments ?? []).filter((p) => p.amountMnt > 0 && p.status !== 'EXPIRED' && p.status !== 'FAILED');
  const owed = rows.filter((p) => p.method === 'CREDIT' && p.status === 'UNPAID').reduce((s, p) => s + p.amountMnt, 0);
  const waiting = rows.filter((p) => p.method !== 'CREDIT' && p.status !== 'PAID').reduce((s, p) => s + p.amountMnt, 0);
  const text = rows.map((p) => `${PAY_LABEL[p.method ?? p.provider ?? 'QPAY'] ?? p.method} ${tugrik(p.amountMnt)}`).join(' · ');
  return { text, owed, waiting };
}

const PAGE = 50;
const STATUS_TABS: Array<[string, string]> = [
  ['', 'Бүгд'],
  ['PENDING_PAYMENT', ORDER_STATUS_LABEL.PENDING_PAYMENT],
  ['READY_FOR_LOADING', ORDER_STATUS_LABEL.READY_FOR_LOADING],
  ['COMPLETED', ORDER_STATUS_LABEL.COMPLETED],
  ['CANCELLED', ORDER_STATUS_LABEL.CANCELLED],
];

/** Orders, newest first, 50 at a time; search by number, phone or name, filter by status and dates. */
export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const delivery = useFeatures().enabled('DELIVERY');
  const shops = new Set(orders.map((o) => o.warehouse?.id).filter(Boolean)).size > 1;
  const counted = orders.filter((o) => o.status !== 'CANCELLED');
  const total = counted.reduce((s, o) => s + o.totalMnt, 0);
  const owedTotal = counted.reduce((s, o) => s + payments(o).owed, 0);
  const quick: Array<[string, string, string]> = [
    ['Өнөөдөр', daysAgo(0), daysAgo(0)],
    ['Өчигдөр', daysAgo(1), daysAgo(1)],
    ['7 хоног', daysAgo(6), daysAgo(0)],
    ['Энэ сар', `${daysAgo(0).slice(0, 8)}01`, daysAgo(0)],
    ['Бүгд', '', ''],
  ];

  function exportCsv() {
    downloadCsv(
      `zahialguud-${from || 'ehnees'}-${to || 'odoo'}`,
      ['Дугаар', 'Огноо', 'Салбар', 'Харилцагч', 'Утас', 'Төлөв', 'Дүн', 'Төлбөр', 'Өр', 'Кассчин', 'Ачигч'],
      orders.map((o) => {
        const p = payments(o);
        return [
          o.orderNumber,
          o.createdAt ? new Date(o.createdAt).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }) : '',
          o.warehouse?.name ?? '',
          o.customerName,
          o.customerPhone,
          ORDER_STATUS_LABEL[o.status] ?? o.status,
          o.totalMnt,
          p.text,
          p.owed || '',
          o.createdBy?.fullName ?? '',
          o.preparedBy?.fullName ?? o.completedBy?.fullName ?? '',
        ];
      }),
    );
  }

  const fetchPage = useCallback(
    async (skip: number) => {
      const params = new URLSearchParams({ skip: String(skip), take: String(PAGE) });
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      setLoading(true);
      setError('');
      try {
        const page = await api<Order[]>(`/orders?${params.toString()}`);
        setOrders((prev) => (skip === 0 ? page : [...prev, ...page]));
        setMore(page.length === PAGE);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
      } finally {
        setLoading(false);
      }
    },
    [q, status, from, to],
  );

  useEffect(() => {
    const t = window.setTimeout(() => void fetchPage(0), 250);
    return () => window.clearTimeout(t);
  }, [fetchPage]);

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-bold">Захиалгууд</h2>
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
          <input className="w-full sm:w-64" placeholder="Дугаар, утас, нэрээр хайх…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="min-w-0 flex-1 text-xs text-slate-400 sm:flex-none">
            Эхлэх
            <input type="date" className="mt-1 block w-full" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="min-w-0 flex-1 text-xs text-slate-400 sm:flex-none">
            Дуусах
            <input type="date" className="mt-1 block w-full" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>
      {/* Phones: one row that scrolls sideways instead of wrapping into several lines. */}
      <div className="mb-2 flex items-center gap-1 overflow-x-auto pb-1 text-xs md:flex-wrap md:overflow-visible md:pb-0">
        {quick.map(([label, f, t]) => (
          <button
            key={label}
            className={`shrink-0 whitespace-nowrap ${from === f && to === t ? 'btn-primary text-xs' : 'btn-ghost text-xs'}`}
            onClick={() => {
              setFrom(f);
              setTo(t);
            }}
          >
            {label}
          </button>
        ))}
        <button className="btn-ghost ml-auto shrink-0 text-xs" onClick={exportCsv} disabled={!orders.length}>
          Excel
        </button>
      </div>
      <div className="mb-3 flex gap-1 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0">
        {STATUS_TABS.map(([key, label]) => (
          <button
            key={key || 'all'}
            className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${status === key ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
            onClick={() => setStatus(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {/* Phones: one card per order; the whole card opens the order. */}
      <div className="space-y-2 md:hidden">
        {orders.map((o) => {
          const p = payments(o);
          return (
            <Link key={o.id} href={`/orders/${o.id}`} className="card block space-y-1 active:bg-steel-800">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-amber-brand">{o.orderNumber}</span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                    o.status === 'CANCELLED'
                      ? 'border-slate-600 text-slate-400'
                      : o.status === 'COMPLETED'
                        ? 'border-emerald-700 text-emerald-200'
                        : 'border-amber-600 text-amber-200'
                  }`}
                >
                  {ORDER_STATUS_LABEL[o.status] ?? o.status}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-slate-200">{o.customerName}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {o.createdAt
                    ? new Date(o.createdAt).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-white">{tugrik(o.totalMnt)}</b>
                <span className="flex flex-wrap gap-1">
                  {p.owed > 0 && o.status !== 'CANCELLED' && (
                    <span className="rounded-full border border-amber-600 px-1.5 text-[11px] text-amber-200">өртэй {tugrik(p.owed)}</span>
                  )}
                  {p.waiting > 0 && o.status === 'PENDING_PAYMENT' && (
                    <span className="rounded-full border border-slate-600 px-1.5 text-[11px] text-slate-300">хүлээгдэж буй</span>
                  )}
                </span>
              </div>
              {shops && o.warehouse?.name && <p className="text-xs text-slate-500">{o.warehouse.name}</p>}
            </Link>
          );
        })}
        {!loading && orders.length === 0 && <p className="card text-sm text-slate-500">Захиалга олдсонгүй.</p>}
        {orders.length > 0 && (
          <p className="px-1 text-xs text-slate-400">
            {counted.length} захиалга (цуцлагдсаныг тооцохгүй): <b className="text-slate-200">{tugrik(total)}</b>
            {owedTotal > 0 && <span className="text-amber-300"> · төлөгдөөгүй өр {tugrik(owedTotal)}</span>}
          </p>
        )}
        {loading && <p className="p-2 text-sm text-slate-500">Уншиж байна…</p>}
      </div>
      <div className="card hidden overflow-auto p-0 md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Харилцагч</th>
              <th>Огноо</th>
              {shops && <th>Салбар</th>}
              {delivery && <th>Бүс</th>}
              <th>Төлөв</th>
              {delivery && <th>Машин</th>}
              {delivery && <th>Хөлсний машины дугаар</th>}
              <th>Бэлтгэсэн ажилтан</th>
              <th className="text-right">Дүн</th>
              <th className="pr-3">Төлбөр</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-slate-800 hover:bg-steel-800">
                <td className="p-3">
                  <Link className="text-amber-brand" href={`/orders/${o.id}`}>
                    {o.orderNumber}
                  </Link>
                </td>
                <td>
                  {o.customerName}
                  {o.createdBy?.fullName && <span className="block text-[11px] text-slate-500">кассчин: {o.createdBy.fullName}</span>}
                </td>
                <td className="whitespace-nowrap text-xs text-slate-400">{o.createdAt ? new Date(o.createdAt).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }) : ''}</td>
                {shops && <td className="text-xs text-slate-300">{o.warehouse?.name ?? '—'}</td>}
                {delivery && <td>{o.zone?.nameMn}</td>}
                <td>
                  {ORDER_STATUS_LABEL[o.status] ?? o.status}
                  {o.items?.some(
                    (item) =>
                      item.sourceType !== 'EXTERNAL_SUPPLIER' && Number(item.product?.stockQty) < 0,
                  ) ? (
                    <span className="ml-2 inline-flex rounded-full border border-rose-600 bg-rose-950/70 px-2 py-0.5 text-[10px] font-semibold text-rose-100">
                      Илүү зарагдсан
                    </span>
                  ) : null}
                </td>
                {delivery && <td>{o.assignedVehicle ? VEHICLE_LABEL[o.assignedVehicle] ?? o.assignedVehicle : '—'}</td>}
                {delivery && (
                  <td>
                    {o.deliveryMethod === 'SELF_PICKUP' || o.deliveryMethod === 'CUSTOMER_DRIVER'
                      ? '—'
                      : o.vehicleNumber
                        ? `${o.vehicleNumber}${o.driverPhone ? ` · ${o.driverPhone}` : ''}`
                        : '—'}
                  </td>
                )}
                <td>{o.preparedBy?.fullName ?? o.completedBy?.fullName ?? '—'}</td>
                <td className="text-right whitespace-nowrap">{tugrik(o.totalMnt)}</td>
                <td className="pr-3 text-xs">
                  {(() => {
                    const p = payments(o);
                    return (
                      <>
                        <span className="text-slate-300">{p.text || '—'}</span>
                        {p.owed > 0 && o.status !== 'CANCELLED' && (
                          <span className="ml-1 rounded-full border border-amber-600 px-1.5 text-[10px] text-amber-200">өртэй {tugrik(p.owed)}</span>
                        )}
                        {p.waiting > 0 && o.status === 'PENDING_PAYMENT' && (
                          <span className="ml-1 rounded-full border border-slate-600 px-1.5 text-[10px] text-slate-300">хүлээгдэж буй</span>
                        )}
                      </>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && orders.length === 0 && <p className="p-4 text-sm text-slate-500">Захиалга олдсонгүй.</p>}
        {orders.length > 0 && (
          <p className="border-t border-slate-800 p-3 text-xs text-slate-400">
            Харагдаж буй {orders.length} захиалга (цуцлагдсаныг тооцохгүй {counted.length}): <b className="text-slate-200">{tugrik(total)}</b>
            {owedTotal > 0 && <span className="text-amber-300"> · төлөгдөөгүй өр {tugrik(owedTotal)}</span>}
            {more && ' · «Цааш үзэх»-ээр бусдыг нэмнэ'}
          </p>
        )}
        {loading && <p className="p-4 text-sm text-slate-500">Уншиж байна…</p>}
      </div>
      {more && !loading && (
        <div className="mt-3 text-center">
          <button className="btn-ghost text-sm" onClick={() => void fetchPage(orders.length)}>
            Цааш үзэх
          </button>
        </div>
      )}
    </Shell>
  );
}
