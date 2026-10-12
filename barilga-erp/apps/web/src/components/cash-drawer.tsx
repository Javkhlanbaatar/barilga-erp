'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';

export type CashSummary = {
  openingFloatMnt: number;
  cashSalesMnt: number;
  cashRefundsMnt: number;
  cashInMnt: number;
  cashOutMnt: number;
  expectedCashMnt: number;
  cardMnt: number;
  qpayMnt: number;
  transferMnt: number;
  otherRefundsMnt: number;
};

export type CashSession = {
  id: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openingFloatMnt: number;
  expectedCashMnt: number | null;
  countedCashMnt: number | null;
  differenceMnt: number | null;
  closingNote: string | null;
  user: { id: string; fullName: string };
  movements: Array<{ id: string; kind: 'IN' | 'OUT'; amountMnt: number; reason: string; createdAt: string }>;
  summary: CashSummary;
};

type Current = { session: CashSession | null; lastClosed: { countedCashMnt: number | null; closedAt: string; user: { fullName: string } } | null };
type Modal = null | 'open' | 'move' | 'close';

const time = (iso: string) => new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** The cashier's drawer on the POS: open it with a counted float, record cash in/out, and close it with a count. */
export function CashDrawerBar({ refreshKey }: { refreshKey?: unknown }) {
  const [cur, setCur] = useState<Current | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'IN' | 'OUT'>('OUT');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<CashSession | null>(null);

  const load = useCallback(async () => {
    try {
      setCur(await api<Current>('/cash/current'));
    } catch {
      setCur(null); // module off or no access: no bar
    }
  }, []);

  useEffect(() => {
    void load();
    const h = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(h);
  }, [load, refreshKey]);

  function openModal(m: Modal) {
    setError('');
    setReason('');
    setAmount(m === 'open' ? String(cur?.lastClosed?.countedCashMnt ?? '') : '');
    setModal(m);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Math.round(Number(amount));
    if (!(n >= 0) || amount.trim() === '') return setError('Дүнгээ оруулна уу');
    setBusy(true);
    setError('');
    try {
      if (modal === 'open') await api('/cash/open', { method: 'POST', body: JSON.stringify({ openingFloatMnt: n }) });
      if (modal === 'move') {
        if (n <= 0 || reason.trim().length < 3) throw new Error('Дүн болон шалтгаанаа бичнэ үү');
        await api('/cash/movements', { method: 'POST', body: JSON.stringify({ kind, amountMnt: n, reason }) });
      }
      if (modal === 'close') {
        setClosed(await api<CashSession>('/cash/close', { method: 'POST', body: JSON.stringify({ countedCashMnt: n, note: reason || undefined }) }));
      }
      setModal(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusy(false);
    }
  }

  if (!cur) return null;
  const s = cur.session;
  const sum = s?.summary;

  return (
    <>
      {s ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm">
          <span>
            Касс нээлттэй ({time(s.openedAt)}-с) · кассанд байх ёстой <b className="text-emerald-300">{tugrik(sum!.expectedCashMnt)}</b>
          </span>
          <span className="flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => openModal('move')}>
              Мөнгө гаргах / нэмэх
            </button>
            <button className="btn-primary text-xs" onClick={() => openModal('close')}>
              Касс хаах
            </button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <span>Касс нээгээгүй байна — бэлэн мөнгөөр зарахын өмнө нээнэ үү.</span>
          <button className="btn-primary text-xs" onClick={() => openModal('open')}>
            Касс нээх
          </button>
        </div>
      )}

      {closed && (
        <div className="rounded-xl border border-slate-700 p-3 text-sm">
          <p className="font-semibold">Касс хаагдлаа</p>
          <p>
            Байх ёстой {tugrik(closed.expectedCashMnt ?? 0)} · тоолсон {tugrik(closed.countedCashMnt ?? 0)} ·{' '}
            <b className={(closed.differenceMnt ?? 0) === 0 ? 'text-emerald-300' : 'text-red-300'}>
              {(closed.differenceMnt ?? 0) === 0 ? 'зөрүүгүй' : `${(closed.differenceMnt ?? 0) > 0 ? 'илүү' : 'дутуу'} ${tugrik(Math.abs(closed.differenceMnt ?? 0))}`}
            </b>
          </p>
          <button className="mt-1 text-xs text-slate-400 hover:underline" onClick={() => setClosed(null)}>
            хаах
          </button>
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submit} className="card w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold">{modal === 'open' ? 'Касс нээх' : modal === 'move' ? 'Мөнгө гаргах / нэмэх' : 'Касс хаах'}</h3>
            {modal === 'open' && (
              <p className="text-xs text-slate-400">
                Кассанд байгаа задгай мөнгөө тоолж оруулна.
                {cur.lastClosed?.countedCashMnt != null && ` Өмнөх ээлж (${cur.lastClosed.user.fullName}) ${tugrik(cur.lastClosed.countedCashMnt)} үлдээсэн.`}
              </p>
            )}
            {modal === 'move' && (
              <div className="grid grid-cols-2 gap-2">
                {(['OUT', 'IN'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={kind === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
                    onClick={() => setKind(k)}
                  >
                    {k === 'OUT' ? 'Гаргах (банк, зардал)' : 'Нэмэх (задгай)'}
                  </button>
                ))}
              </div>
            )}
            {modal === 'close' && sum && (
              <table className="w-full text-sm">
                <tbody>
                  {(
                    [
                      ['Эхний үлдэгдэл', sum.openingFloatMnt],
                      ['+ Бэлэн борлуулалт', sum.cashSalesMnt],
                      ['− Бэлнээр буцаасан', -sum.cashRefundsMnt],
                      ['+ Нэмсэн', sum.cashInMnt],
                      ['− Гаргасан', -sum.cashOutMnt],
                    ] as Array<[string, number]>
                  ).map(([l, v]) => (
                    <tr key={l}>
                      <td className="py-0.5 text-slate-400">{l}</td>
                      <td className="text-right">{tugrik(v)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-700 font-semibold">
                    <td className="py-1">Кассанд байх ёстой</td>
                    <td className="text-right">{tugrik(sum.expectedCashMnt)}</td>
                  </tr>
                  <tr>
                    <td className="pt-2 text-xs text-slate-500" colSpan={2}>
                      Бэлэн бус: карт {tugrik(sum.cardMnt)} · QPay {tugrik(sum.qpayMnt)} · шилжүүлэг {tugrik(sum.transferMnt)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
            <label className="block text-xs text-slate-400">
              {modal === 'close' ? 'Тоолсон бэлэн мөнгө ₮' : 'Дүн ₮'}
              <input className="mt-1 block w-full" type="number" min={0} autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            {modal !== 'open' && (
              <label className="block text-xs text-slate-400">
                {modal === 'move' ? 'Шалтгаан' : 'Тайлбар (заавал биш)'}
                <input className="mt-1 block w-full" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
              </label>
            )}
            {modal === 'close' && amount.trim() !== '' && sum && (
              <p className="text-sm">
                Зөрүү:{' '}
                <b className={Math.round(Number(amount)) - sum.expectedCashMnt === 0 ? 'text-emerald-300' : 'text-red-300'}>
                  {tugrik(Math.round(Number(amount)) - sum.expectedCashMnt)}
                </b>
              </p>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={busy}>
                {modal === 'open' ? 'Нээх' : modal === 'move' ? 'Бүртгэх' : 'Хаах'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
