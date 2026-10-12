'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { ORDER_STATUS_LABEL, Order, VEHICLE_LABEL } from '@/lib/types';

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
        <div className="flex flex-wrap items-end gap-2">
          <input className="w-64" placeholder="Дугаар, утас, нэрээр хайх…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="text-xs text-slate-400">
            Эхлэх
            <input type="date" className="mt-1 block" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">
            Дуусах
            <input type="date" className="mt-1 block" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {STATUS_TABS.map(([key, label]) => (
          <button
            key={key || 'all'}
            className={`rounded-md px-3 py-1.5 text-sm ${status === key ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
            onClick={() => setStatus(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="overflow-auto card p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Харилцагч</th>
              <th>Огноо</th>
              {delivery && <th>Бүс</th>}
              <th>Төлөв</th>
              {delivery && <th>Хэмжээ / ангилал</th>}
              {delivery && <th>Гадна тээвэр (дугаар)</th>}
              <th>Ачигч</th>
              <th>Дүн</th>
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
                <td>{o.customerName}</td>
                <td className="whitespace-nowrap text-xs text-slate-400">{o.createdAt ? new Date(o.createdAt).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }) : ''}</td>
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
                <td>{tugrik(o.totalMnt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && orders.length === 0 && <p className="p-4 text-sm text-slate-500">Захиалга олдсонгүй.</p>}
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
