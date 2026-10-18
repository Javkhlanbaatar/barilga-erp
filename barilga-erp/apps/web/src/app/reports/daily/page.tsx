'use client';

import { isManager } from '@/lib/rbac';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { AuthUser, DailyReport, ORDER_STATUS_LABEL } from '@/lib/types';

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
}

const METHOD_LABEL: Record<DailyReport['payments'][number]['method'], string> = {
  CASH: 'Бэлэн',
  QPAY: 'QPay',
  CARD: 'Карт',
  TRANSFER: 'Шилжүүлэг',
};

const BAR_COLOR: Record<DailyReport['payments'][number]['method'], string> = {
  CASH: 'bg-emerald-500',
  QPAY: 'bg-sky-500',
  CARD: 'bg-violet-500',
  TRANSFER: 'bg-amber-500',
};

export default function DailyReportPage() {
  const router = useRouter();
  const features = useFeatures();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [startDate, setStartDate] = useState(todayYmd);
  const [endDate, setEndDate] = useState(todayYmd);
  const [cashierId, setCashierId] = useState('');
  const [cashiers, setCashiers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const canPickCashier = isManager(user?.role);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const token = localStorage.getItem('barilga_token');
    if (!raw || !token) {
      router.replace('/login');
      return;
    }
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed.role === 'ACHIGCH_BELTGEGCH') {
      router.replace('/warehouse/tickets');
      return;
    }
    setUser(parsed);
  }, [router]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ startDate, endDate });
      if (canPickCashier && cashierId) params.set('cashierId', cashierId);
      const data = await api<DailyReport>(`/reports/daily?${params.toString()}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Тайлан ачаалж чадсангүй');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [user, startDate, endDate, cashierId, canPickCashier]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  useEffect(() => {
    if (!canPickCashier) return;
    api<Array<{ id: string; name: string; email: string }>>('/reports/cashiers')
      .then(setCashiers)
      .catch(() => setCashiers([]));
  }, [canPickCashier]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void load();
  }

  const maxPaid = useMemo(() => {
    if (!report) return 1;
    return Math.max(1, ...report.payments.map((p) => p.paidMnt));
  }, [report]);

  if (!user) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <ReportsNav />
      <div className="print:hidden flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Тайлан</p>
          <h2 className="text-xl font-bold">Борлуулалтын тайлан</h2>
          <p className="text-slate-400 text-sm mt-1">
            Төлбөрийг төлсөн өдрөөр нь тооцно (Улаанбаатарын цаг)
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => window.print()}>
            Z тайлан хэвлэх
          </button>
        </div>
      </div>

      <form onSubmit={onSubmit} className="print:hidden card mb-5 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] items-end">
        <label className="text-sm block">
          Эхлэх огноо
          <input type="date" className="mt-1 w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="text-sm block">
          Дуусах огноо
          <input type="date" className="mt-1 w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        {canPickCashier ? (
          <label className="text-sm block">
            Кассчин
            <select className="mt-1 w-full" value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
              <option value="">Бүх кассчин</option>
              {cashiers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.email ? ` (${c.email})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="text-sm text-slate-400">
            Кассчин
            <p className="mt-2 text-white">{user.name} — зөвхөн өөрийн ээлж</p>
          </div>
        )}
        <button className="btn-primary" disabled={loading}>
          {loading ? 'Уншиж байна…' : 'Харуулах'}
        </button>
      </form>

      {error && <p className="text-red-400 mb-4 print:hidden">{error}</p>}

      {report && (
        <>
          <header className="hidden print:block mb-6 border-b border-black pb-3">
            <p className="text-xs tracking-[0.3em] uppercase">Barilga ERP · Z тайлан</p>
            <h1 className="text-2xl font-bold text-black">Борлуулалтын тайлан</h1>
            <p className="text-sm">
              {report.range.startDate} → {report.range.endDate} ({report.range.timeZone})
            </p>
            <p className="text-sm">
              Кассчин: {report.cashier ? `${report.cashier.name} · ${report.cashier.email}` : 'Бүх кассчин'}
            </p>
            <p className="text-xs">Хэвлэсэн {new Date().toLocaleString('mn-MN')}</p>
          </header>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-5">
            <StatCard label="Нийт орлого" value={tugrik(report.totals.revenueMnt)} hint="Энэ хугацаанд орсон, буцаалт хассан" />
            <StatCard label="Кассанд бэлэн" value={tugrik(report.totals.cashMnt)} hint={`${report.payments[0]?.paidCount ?? 0} бэлэн төлбөр`} />
            <StatCard label="QPay нийт" value={tugrik(report.totals.qpayMnt)} hint="Зөвхөн төлөгдсөн QPay нэхэмжлэх" />
            <StatCard label="Карт нийт" value={tugrik(report.totals.cardMnt)} hint="POS терминал" />
            <StatCard
              label="Буцаалт нийт"
              value={tugrik(report.refunds?.totalMnt ?? report.totals.refundsMnt ?? 0)}
              hint={`${report.refunds?.count ?? 0} буцаалт төлбөрөөс хасагдсан`}
            />
          </section>

          <section className="grid gap-4 lg:grid-cols-2 mb-5">
            <article className="card">
              <h3 className="font-semibold mb-3">Төлбөрийн хэлбэрээр</h3>
              <div className="space-y-3">
                {report.payments.map((p) => (
                  <div key={p.method}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{METHOD_LABEL[p.method] ?? p.method}</span>
                      <span className="font-medium">{tugrik(p.paidMnt)}</span>
                    </div>
                    <div className="h-2 rounded bg-steel-800 overflow-hidden print:bg-slate-200">
                      <div
                        className={`h-full ${BAR_COLOR[p.method]} print:bg-black`}
                        style={{ width: `${Math.max(0, p.paidMnt / maxPaid) * 100}%` }}
                      />
                    </div>
                    {p.pendingMnt > 0 && (
                      <p className="text-xs text-amber-300 mt-1 print:text-black">
                        Төлөгдөөгүй {tugrik(p.pendingMnt)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {report.totals.pendingMnt > 0 && (
                <p className="text-xs text-slate-400 mt-3 print:text-black">
                  Төлөгдөөгүй хэсэг (орлогод ороогүй): {tugrik(report.totals.pendingMnt)}
                </p>
              )}
            </article>

            <article className="card">
              <h3 className="font-semibold mb-3">{features.enabled('DELIVERY') ? 'Тээврийн хураамж' : 'Буцаалт'}</h3>
              <table className="w-full text-sm">
                <tbody>
                  {features.enabled('DELIVERY') && (
                  <>
                  <tr className="border-b border-slate-800 print:border-slate-300">
                    <td className="py-2 text-slate-400">Хүргэлт</td>
                    <td className="py-2 text-right font-medium">{tugrik(report.logistics.deliveryFeesMnt)}</td>
                  </tr>
                  <tr className="border-b border-slate-800 print:border-slate-300">
                    <td className="py-2 text-slate-400">Буулгалт</td>
                    <td className="py-2 text-right font-medium">{tugrik(report.logistics.unloadingFeesMnt)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-400">Шөнө / яаралтай нэмэгдэл</td>
                    <td className="py-2 text-right font-medium">{tugrik(report.logistics.timeAdjustmentMnt)}</td>
                  </tr>
                  </>
                  )}
                  <tr className="border-t border-slate-800 print:border-slate-300">
                    <td className="py-2 text-slate-400">Буцаалт нийт</td>
                    <td className="py-2 text-right font-medium text-red-300 print:text-black">
                      −{tugrik(report.refunds?.totalMnt ?? report.totals.refundsMnt ?? 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <h3 className="font-semibold mt-4 mb-2">Захиалга төлөвөөр</h3>
              <ul className="text-sm grid grid-cols-2 gap-2">
                <li>{ORDER_STATUS_LABEL.COMPLETED} · {report.ordersByStatus.COMPLETED}</li>
                <li>{ORDER_STATUS_LABEL.PENDING_PAYMENT} · {report.ordersByStatus.PENDING_PAYMENT}</li>
                <li>{ORDER_STATUS_LABEL.READY_FOR_LOADING} · {report.ordersByStatus.READY_FOR_LOADING}</li>
                <li>{ORDER_STATUS_LABEL.CANCELLED} · {report.ordersByStatus.CANCELLED}</li>
              </ul>
              <p className="text-xs text-slate-500 mt-2 print:text-black">
                Төлөгдсөн захиалга: {report.totals.orderCount}
              </p>
            </article>
          </section>

          {features.enabled('EBARIMT') && report.ebarimt && (
            <article className="card overflow-auto mb-5">
              <h3 className="font-semibold mb-3">И-Баримт</h3>
              <p className="text-sm text-slate-400 mb-3">
                Амжилттай {report.ebarimt.issued} · Амжилтгүй {report.ebarimt.failed} · Хүлээгдэж {report.ebarimt.pending}
              </p>
              {report.ebarimt.receipts.length === 0 ? (
                <p className="text-slate-500 text-sm">Энэ хугацаанд олгосон баримт алга.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-400 border-b border-slate-700">
                    <tr>
                      <th className="py-2 pr-3">Захиалга</th>
                      {canPickCashier && <th className="py-2 pr-3">Сугалаа</th>}
                      <th className="py-2 pr-3">Баримтын дугаар</th>
                      <th className="py-2 pr-3">Төрөл</th>
                      <th className="py-2 text-right">Дүн</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.ebarimt.receipts.map((r) => (
                      <tr key={r.orderNumber} className="border-t border-slate-800 print:border-slate-300">
                        <td className="py-2 pr-3">{r.orderNumber}</td>
                        {canPickCashier && (
                          <td className="py-2 pr-3 font-mono tracking-wide">{r.lottery ?? '—'}</td>
                        )}
                        <td className="py-2 pr-3 text-xs text-slate-300">{r.receiptId ?? '—'}</td>
                        <td className="py-2 pr-3">{r.billType === 'COMPANY' ? 'Байгууллага' : 'Хувь хүн'}</td>
                        <td className="py-2 text-right">{tugrik(r.totalMnt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          )}

          <article className="card overflow-auto">
            <h3 className="font-semibold mb-3">Их зарагдсан бараа</h3>
            {report.topProducts.length === 0 ? (
              <p className="text-slate-500 text-sm">Энэ хугацаанд борлуулалт алга.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400 border-b border-slate-700">
                  <tr>
                    <th className="py-2 pr-3">Бараа</th>
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3 text-right">Тоо</th>
                    <th className="py-2 text-right">Дүн</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topProducts.map((p) => (
                    <tr key={p.productId} className="border-t border-slate-800 print:border-slate-300">
                      <td className="py-2 pr-3">{p.nameMn}</td>
                      <td className="py-2 pr-3 text-slate-400">{p.sku}</td>
                      <td className="py-2 pr-3 text-right">{p.quantity}</td>
                      <td className="py-2 text-right">{tugrik(p.amountMnt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </>
      )}
    </Shell>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="card">
      <p className="text-xs uppercase tracking-wide text-slate-400 print:text-black">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      <p className="text-xs text-slate-500 mt-1 print:text-black">{hint}</p>
    </article>
  );
}
