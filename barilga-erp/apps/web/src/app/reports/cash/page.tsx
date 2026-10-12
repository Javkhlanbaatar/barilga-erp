'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CashSession } from '@/components/cash-drawer';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

/** Every cash drawer shift: what should have been in it, what was counted, and the difference. */
export default function CashReportPage() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => ymd(new Date()));
  const [rows, setRows] = useState<CashSession[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const me = raw ? (JSON.parse(raw) as AuthUser) : null;
    if (!hasRole(me?.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(me?.role));
      return;
    }
    setOk(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      setError('');
      setRows(await api<CashSession[]>(`/cash/sessions?from=${from}&to=${to}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [from, to]);

  useEffect(() => {
    if (ok) void load();
  }, [ok, load]);

  async function closeFor(s: CashSession) {
    const raw = window.prompt(`${s.user.fullName}-ийн кассанд тоолсон бэлэн мөнгө (₮). Байх ёстой: ${tugrik(s.summary.expectedCashMnt)}`);
    if (raw === null) return;
    const n = Math.round(Number(raw));
    if (!(n >= 0)) return setError('Дүн буруу');
    try {
      await api(`/cash/sessions/${s.id}/close`, { method: 'POST', body: JSON.stringify({ countedCashMnt: n, note: 'Менежер хаасан' }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хааж чадсангүй');
    }
  }

  const closed = rows.filter((r) => r.status === 'CLOSED');
  const short = closed.reduce((t, r) => t + Math.min(0, r.differenceMnt ?? 0), 0);
  const over = closed.reduce((t, r) => t + Math.max(0, r.differenceMnt ?? 0), 0);

  return (
    <Shell>
      <ReportsNav />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Касс</h2>
          <p className="text-sm text-slate-400">Ээлж бүрийн бэлэн мөнгө: эхний үлдэгдэл + бэлэн борлуулалт − буцаалт ± гаргасан/нэмсэн = байх ёстой.</p>
        </div>
        <div className="flex items-end gap-2">
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
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <article className="card">
          <p className="text-xs text-slate-400">Хаагдсан ээлж</p>
          <p className="text-xl font-bold">{closed.length}</p>
        </article>
        <article className="card">
          <p className="text-xs text-slate-400">Дутуу нийт</p>
          <p className="text-xl font-bold text-red-300">{tugrik(short)}</p>
        </article>
        <article className="card">
          <p className="text-xs text-slate-400">Илүү нийт</p>
          <p className="text-xl font-bold text-emerald-300">{tugrik(over)}</p>
        </article>
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="card overflow-auto p-0">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
            <tr>
              <th className="p-3">Кассчин</th>
              <th>Нээсэн</th>
              <th>Хаасан</th>
              <th className="text-right">Эхний</th>
              <th className="text-right">Бэлэн борл.</th>
              <th className="text-right">Гарсан/нэмсэн</th>
              <th className="text-right">Байх ёстой</th>
              <th className="text-right">Тоолсон</th>
              <th className="pr-3 text-right">Зөрүү</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const expected = s.status === 'CLOSED' ? (s.expectedCashMnt ?? 0) : s.summary.expectedCashMnt;
              const diff = s.differenceMnt ?? 0;
              return (
                <tr key={s.id} className="border-t border-slate-800 align-top">
                  <td className="p-3">
                    {s.user.fullName}
                    {s.closingNote && <p className="text-[11px] text-slate-500">{s.closingNote}</p>}
                  </td>
                  <td className="text-xs">{when(s.openedAt)}</td>
                  <td className="text-xs">
                    {s.status === 'OPEN' ? (
                      <button className="text-amber-300 hover:underline" onClick={() => void closeFor(s)}>
                        нээлттэй — хаах
                      </button>
                    ) : (
                      when(s.closedAt)
                    )}
                  </td>
                  <td className="text-right">{tugrik(s.openingFloatMnt)}</td>
                  <td className="text-right">{tugrik(s.summary.cashSalesMnt - s.summary.cashRefundsMnt)}</td>
                  <td className="text-right text-xs">
                    {s.movements.map((m) => (
                      <p key={m.id} title={m.reason}>
                        {m.kind === 'OUT' ? '−' : '+'}
                        {tugrik(m.amountMnt)} {m.reason}
                      </p>
                    ))}
                    {s.movements.length === 0 && '—'}
                  </td>
                  <td className="text-right">{tugrik(expected)}</td>
                  <td className="text-right">{s.countedCashMnt == null ? '—' : tugrik(s.countedCashMnt)}</td>
                  <td className={`pr-3 text-right font-semibold ${s.status === 'OPEN' ? 'text-slate-500' : diff < 0 ? 'text-red-300' : diff > 0 ? 'text-emerald-300' : ''}`}>
                    {s.status === 'OPEN' ? '—' : tugrik(diff)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд касс нээгдээгүй.</p>}
      </div>
    </Shell>
  );
}
