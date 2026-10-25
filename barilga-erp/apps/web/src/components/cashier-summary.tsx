'use client';

import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, tugrik } from '@/lib/api';
import { DailyReport } from '@/lib/types';

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
}

export function CashierSummary() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const day = todayYmd();
      setReport(await api<DailyReport>(`/reports/daily?startDate=${day}&endDate=${day}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хураангуй ачаалж чадсангүй');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function openDrawer() {
    setOpen(true);
    await load();
  }

  const refunds = report?.refunds?.totalMnt ?? report?.totals.refundsMnt ?? 0;

  return (
    <>
      <button type="button" className="btn-ghost w-full text-xs py-1.5" onClick={() => void openDrawer()}>
        Өнөөдрийн борлуулалт
      </button>
      {/* Drawn at the page root: inside the phone menu it would sit under the top bar. */}
      {open &&
        createPortal(
        <div className="fixed inset-0 z-[70] flex justify-end bg-black/55" onClick={() => setOpen(false)}>
          <aside
            className="h-full w-full max-w-sm border-l border-slate-700 bg-steel-900 p-5 shadow-2xl overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <p className="text-amber-brand text-[10px] tracking-[0.2em] uppercase">Кассын хураангуй</p>
                <h3 className="text-lg font-bold">Өнөөдрийн борлуулалт</h3>
                <p className="text-xs text-slate-400 mt-1">{todayYmd()} · Улаанбаатарын цагаар</p>
              </div>
              <button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => setOpen(false)}>
                Хаах
              </button>
            </div>
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            {loading && <p className="text-slate-500 text-sm">Уншиж байна…</p>}
            {report && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <article className="rounded-lg border border-slate-700 bg-steel-800/60 p-3">
                    <p className="text-[10px] uppercase text-slate-400">Цэвэр орлого</p>
                    <p className="text-lg font-bold text-amber-brand">
                      {tugrik(report.totals.netRevenueMnt ?? report.totals.revenueMnt - refunds)}
                    </p>
                  </article>
                  <article className="rounded-lg border border-slate-700 bg-steel-800/60 p-3">
                    <p className="text-[10px] uppercase text-slate-400">Захиалга</p>
                    <p className="text-lg font-bold">{report.totals.orderCount}</p>
                  </article>
                </div>
                <div className="rounded-lg border border-slate-700 divide-y divide-slate-800">
                  <Row label="Бэлэн" value={report.totals.cashMnt} tone="text-emerald-300" />
                  <Row label="Карт" value={report.totals.cardMnt} tone="text-violet-300" />
                  <Row label="QPay" value={report.totals.qpayMnt} tone="text-sky-300" />
                  <Row label="Шилжүүлэг" value={report.totals.transferMnt ?? 0} tone="text-indigo-300" />
                  <Row label="Буцаалт" value={refunds} tone="text-rose-300" />
                </div>
                {(report.refunds?.count ?? 0) > 0 && (
                  <p className="text-xs text-slate-500">Өнөөдөр {report.refunds!.count} буцаалт</p>
                )}
                <a href="/reports/daily" className="btn-ghost w-full text-xs">
                  Өдрийн тайлан бүтнээр нээх
                </a>
              </div>
            )}
          </aside>
        </div>,
          document.body,
        )}
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className={`font-semibold ${tone}`}>{tugrik(value)}</span>
    </div>
  );
}
