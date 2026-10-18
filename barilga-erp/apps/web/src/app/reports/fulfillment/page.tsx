'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser, Warehouse } from '@/lib/types';

type FulfillmentReport = {
  summary: {
    completed: number;
    avgPrepareMinutes: number | null;
    maxPrepareMinutes: number | null;
    avgWaitMinutes: number | null;
    withoutStart: number;
    waitingNow: number;
    preparingNow: number;
  };
  people: Array<{ name: string; ordersCompleted: number; linesPicked: number; avgPrepareMinutes: number | null }>;
  inProgress: Array<{ id: string; orderNumber: string; startedBy: string | null; minutesSoFar: number | null; lines: number; linesPicked: number }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    warehouse: string | null;
    lines: number;
    startedAt: string | null;
    completedAt: string | null;
    startedBy: string | null;
    completedBy: string | null;
    pickers: string[];
    waitMinutes: number | null;
    prepareMinutes: number | null;
  }>;
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
const mins = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ц ${String(m % 60).padStart(2, '0')} мин`);
const time = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

export default function FulfillmentReportPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [report, setReport] = useState<FulfillmentReport | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ startDate, endDate });
      if (warehouseId) params.set('warehouseId', warehouseId);
      setReport(await api<FulfillmentReport>(`/reports/fulfillment?${params}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [startDate, endDate, warehouseId]);

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
    setReady(true);
    void api<Warehouse[]>('/inventory/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, [router]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const s = report?.summary;
  return (
    <Shell>
      <ReportsNav />
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-bold">Бэлтгэлийн тайлан</h2>
          <p className="text-slate-400 text-sm mt-1">
            Хүлээлт = төлснөөс «Би бэлдье» хүртэл · Бэлтгэл = «Би бэлдье»-ээс «Бэлдэж дууслаа» хүртэл
          </p>
        </div>
        <button className="btn-ghost print:hidden" onClick={() => window.print()}>
          🖨 Хэвлэх
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        <label className="text-xs text-slate-400">
          Агуулах
          <select className="mt-1 block" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Бүх агуулах</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Эхлэх
          <input type="date" className="mt-1 block" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Дуусах
          <input type="date" className="mt-1 block" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>

      {error && <p className="text-red-400 mb-3">{error}</p>}

      {report && s && (
        <>
          <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6 mb-4">
            {[
              ['Бэлдэж дууссан', String(s.completed)],
              ['Дундаж бэлтгэл', mins(s.avgPrepareMinutes)],
              ['Хамгийн удаан', mins(s.maxPrepareMinutes)],
              ['Дундаж хүлээлт', mins(s.avgWaitMinutes)],
              ['Одоо бэлдэж буй', String(s.preparingNow)],
              ['Дараалалд хүлээж буй', String(s.waitingNow)],
            ].map(([label, value]) => (
              <article key={label} className="card py-3">
                <p className="text-[10px] uppercase text-slate-400">{label}</p>
                <p className="text-lg font-bold">{value}</p>
              </article>
            ))}
          </section>

          <div className="grid gap-4 lg:grid-cols-2 mb-4">
            <div className="card p-0 overflow-auto">
              <h3 className="font-semibold p-3 pb-1">Ажилтнаар</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-400">
                  <tr>
                    <th className="p-2">Ажилтан</th>
                    <th className="text-right">Дуусгасан захиалга</th>
                    <th className="text-right">Бэлдсэн мөр</th>
                    <th className="text-right pr-3">Дундаж бэлтгэл</th>
                  </tr>
                </thead>
                <tbody>
                  {report.people.map((p) => (
                    <tr key={p.name} className="border-t border-slate-800">
                      <td className="p-2">{p.name}</td>
                      <td className="text-right">{p.ordersCompleted}</td>
                      <td className="text-right">{p.linesPicked}</td>
                      <td className="text-right pr-3">{mins(p.avgPrepareMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.people.length === 0 && <p className="p-3 text-slate-500 text-sm">Мэдээлэл алга.</p>}
            </div>
            <div className="card">
              <h3 className="font-semibold mb-2">Яг одоо бэлдэж буй</h3>
              {report.inProgress.length === 0 ? (
                <p className="text-sm text-slate-500">Алга.</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {report.inProgress.map((o) => (
                    <li key={o.id} className="flex justify-between gap-2">
                      <Link href={`/orders/${o.id}`} className="font-mono text-xs text-amber-300 hover:underline">
                        {o.orderNumber}
                      </Link>
                      <span className="text-slate-300">{o.startedBy ?? '—'}</span>
                      <span>
                        {o.linesPicked}/{o.lines} · {mins(o.minutesSoFar)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="card p-0 overflow-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="text-left text-xs text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="p-2">Захиалга</th>
                  <th>Агуулах</th>
                  <th className="text-right">Мөр</th>
                  <th>Эхэлсэн</th>
                  <th>Дууссан</th>
                  <th>Бэлдсэн хүмүүс</th>
                  <th className="text-right">Хүлээлт</th>
                  <th className="text-right pr-2">Бэлтгэл</th>
                </tr>
              </thead>
              <tbody>
                {report.orders.map((o) => (
                  <tr key={o.id} className="border-t border-slate-800">
                    <td className="p-2">
                      <Link href={`/orders/${o.id}`} className="font-mono text-xs text-amber-300 hover:underline">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="text-slate-300">{o.warehouse ?? '—'}</td>
                    <td className="text-right">{o.lines}</td>
                    <td className="text-xs text-slate-300">
                      {time(o.startedAt)}
                      {o.startedBy ? ` · ${o.startedBy}` : ''}
                    </td>
                    <td className="text-xs text-slate-300">
                      {time(o.completedAt)}
                      {o.completedBy ? ` · ${o.completedBy}` : ''}
                    </td>
                    <td className="text-xs">{o.pickers.join(', ') || '—'}</td>
                    <td className="text-right">{mins(o.waitMinutes)}</td>
                    <td className="text-right pr-2 font-semibold">{mins(o.prepareMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.orders.length === 0 && <p className="p-3 text-slate-500 text-sm">Энэ хугацаанд дууссан захиалга алга.</p>}
            {s.withoutStart > 0 && (
              <p className="p-3 text-xs text-slate-500">
                {s.withoutStart} захиалга «Би бэлдье» дарагдалгүй дууссан тул бэлтгэлийн хугацаа тооцогдоогүй.
              </p>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}
