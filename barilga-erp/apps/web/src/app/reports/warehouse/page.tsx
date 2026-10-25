'use client';

import { matchesSearch } from '@/lib/translit';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser, Role, Warehouse, WarehouseReport } from '@/lib/types';

const REPORT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
const n = (v: number) => (v === 0 ? '·' : v.toLocaleString('mn-MN', { maximumFractionDigits: 3 }));

export default function WarehouseReportPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [onlyLow, setOnlyLow] = useState(false);
  const [q, setQ] = useState('');
  const [report, setReport] = useState<WarehouseReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isOversight = hasRole(me?.role, OVERSIGHT_ROLES);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ startDate, endDate });
      if (warehouseId) params.set('warehouseId', warehouseId);
      setReport(await api<WarehouseReport>(`/reports/warehouse?${params}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, warehouseId]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const user = JSON.parse(raw) as AuthUser;
    if (!hasRole(user.role, REPORT_ROLES)) {
      router.replace(homeForRole(user.role));
      return;
    }
    setMe(user);
    void api<Warehouse[]>('/inventory/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, [router]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  const lines = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (report?.lines ?? []).filter(
      (l) => (!onlyLow || l.lowStock) && (!term || matchesSearch(`${l.sku} ${l.nameMn}`, term)),
    );
  }, [report, onlyLow, q]);

  return (
    <Shell>
      <ReportsNav />
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4 print:mb-2">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase print:hidden">Тайлан</p>
          <h2 className="text-xl font-bold">Агуулахын тайлан</h2>
          <p className="text-slate-400 text-sm mt-1 print:text-black">
            {report?.warehouse?.name ?? 'Бүх агуулах'} · {startDate}
            {endDate !== startDate ? ` — ${endDate}` : ''}
          </p>
        </div>
        <button className="btn-ghost print:hidden" onClick={() => window.print()}>
          🖨 Хэвлэх
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        {isOversight && (
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
        )}
        <label className="text-xs text-slate-400">
          Эхлэх
          <input type="date" className="mt-1 block" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Дуусах
          <input type="date" className="mt-1 block" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <input className="w-full sm:w-56" placeholder="Бараа шүүх…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="text-sm text-slate-300 flex items-center gap-2">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Зөвхөн дуусч буй
        </label>
      </div>

      {error && <p className="text-red-400 mb-3">{error}</p>}

      {report && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 mb-4">
            {[
              ['Орлого', report.totals.receipts],
              ['Шилжиж ирсэн', report.totals.transfersIn],
              ['Шилжүүлсэн', report.totals.transfersOut],
              ['Борлуулсан', report.totals.sales],
              ['Буцаалт', report.totals.returns],
              ['Дуусч буй бараа', report.totals.lowStock],
            ].map(([label, value]) => (
              <article key={label as string} className="card py-3">
                <p className="text-[10px] uppercase text-slate-400">{label}</p>
                <p className="text-lg font-bold">{n(value as number)}</p>
              </article>
            ))}
          </section>

          <div className="card overflow-auto p-0 mb-4">
            <table className="w-full text-sm min-w-[1000px]">
              <thead className="text-left text-slate-400 border-b border-slate-700 text-xs">
                <tr>
                  <th className="p-2">Код</th>
                  <th>Бараа</th>
                  <th className="text-right">Эхний үлд.</th>
                  <th className="text-right">Орлого</th>
                  <th className="text-right">Шилжиж ирсэн</th>
                  <th className="text-right">Шилжүүлсэн</th>
                  <th className="text-right">Борлуулсан</th>
                  <th className="text-right">Буцаалт</th>
                  <th className="text-right">Тохируулга</th>
                  <th className="text-right">Эцсийн үлд.</th>
                  <th className="text-right pr-2">Үнийн дүн</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.productId} className={`border-t border-slate-800 ${l.lowStock ? 'bg-rose-950/30' : ''}`}>
                    <td className="p-2 font-mono text-[11px] text-slate-400">{l.sku}</td>
                    <td>
                      {l.nameMn} <span className="text-xs text-slate-500">{l.unit}</span>
                    </td>
                    <td className="text-right">{n(l.opening)}</td>
                    <td className="text-right text-emerald-300">{n(l.receipts)}</td>
                    <td className="text-right">{n(l.transfersIn)}</td>
                    <td className="text-right">{n(l.transfersOut)}</td>
                    <td className="text-right">{n(l.sales)}</td>
                    <td className="text-right">{n(l.returns)}</td>
                    <td className="text-right text-amber-300">{n(l.adjustments)}</td>
                    <td className={`text-right font-semibold ${l.lowStock ? 'text-rose-300' : ''}`}>{n(l.closing)}</td>
                    <td className="text-right pr-2">{tugrik(l.valueAtPriceMnt)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-600 font-semibold">
                  <td className="p-2" colSpan={10}>
                    Нийт ({lines.length} бараа, борлуулах үнээр)
                  </td>
                  <td className="text-right pr-2">{tugrik(lines.reduce((s, l) => s + l.valueAtPriceMnt, 0))}</td>
                </tr>
              </tfoot>
            </table>
            {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
            {!loading && lines.length === 0 && <p className="p-3 text-slate-500">Хөдөлгөөн алга.</p>}
          </div>

          {report.inTransit.length > 0 && (
            <div className="card">
              <h3 className="font-semibold mb-2">Замд яваа шилжүүлэг</h3>
              <ul className="text-sm space-y-1">
                {report.inTransit.map((t) => (
                  <li key={t.id}>
                    <span className="font-mono text-xs">{t.transferNumber}</span> · {t.from} → {t.to}:{' '}
                    {t.items.map((i) => `${i.nameMn} ${n(i.quantity)} ${i.unit}`).join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
