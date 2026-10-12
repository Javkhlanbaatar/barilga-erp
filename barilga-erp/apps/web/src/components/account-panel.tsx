'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import type { AccountStatement } from '@/lib/types';

const KIND_MN: Record<AccountStatement['lines'][number]['kind'], string> = {
  ON_ACCOUNT: 'Дараа төлөхөөр авсан',
  PAID_BY_THEM: 'Тэд төлсөн',
  RETURNED: 'Буцаалт',
  PURCHASE: 'Бид бараа авсан',
  PAYMENT_TO_PARTNER: 'Бид төлсөн',
  OFFSET: 'Хасалт',
  ADJUSTMENT: 'Залруулга',
};

/** «Тэр бидэнд өртэй» / «Бид түүнд өртэй» wording for a net balance. */
function netLabel(net: number) {
  if (net > 0) return { text: `Бидэнд ${tugrik(net)} өртэй`, cls: 'text-amber-300' };
  if (net < 0) return { text: `Бид түүнд ${tugrik(-net)} өртэй`, cls: 'text-sky-300' };
  return { text: 'Тооцоо дууссан', cls: 'text-emerald-300' };
}

/**
 * The two-way account with a partner. Everyone sees it; managers/admin record purchases from the partner,
 * payments we made, corrections, edit them later (with a reason) and offset the two sides.
 */
export function AccountPanel({ customerId, canManage }: { customerId: string; canManage: boolean }) {
  const [st, setSt] = useState<AccountStatement | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'PURCHASE' | 'PAYMENT_TO_PARTNER' | 'ADJUSTMENT'>('PURCHASE');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setSt(await api<AccountStatement>(`/accounts/${customerId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/accounts/${customerId}/entries`, {
        method: 'POST',
        body: JSON.stringify({ kind, amountMnt: Math.round(Number(amount)), description: description.trim() }),
      });
      setAmount('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  async function edit(entryId: string, current: number, kindOf: string) {
    const shown = kindOf === 'ADJUSTMENT' ? -current : Math.abs(current);
    const raw = window.prompt('Шинэ дүн (₮):', String(shown));
    if (raw === null) return;
    const reason = window.prompt('Засах шалтгаан (админ харна):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/accounts/entries/${entryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ amountMnt: Math.round(Number(raw)), reason: reason.trim() }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Засаж чадсангүй');
    }
  }

  async function offset() {
    if (!st) return;
    const max = Math.min(st.receivableMnt, st.payableMnt);
    if (!window.confirm(`${tugrik(max)} хасалт хийх үү? Тэдний дараа төлөхөөр авсан захиалгууд бидний өглөгөөр төлөгдөнө.`)) return;
    setBusy(true);
    try {
      await api(`/accounts/${customerId}/offset`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хасалт хийж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  if (!st) return error ? <p className="text-sm text-red-400">{error}</p> : null;
  const net = netLabel(st.netMnt);
  const canOffset = canManage && st.receivableMnt > 0 && st.payableMnt > 0;

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Тооцоо {st.customer.barterContract && <span className="text-xs text-amber-300">· бартер {st.customer.barterContract}</span>}</h3>
          <p className={`text-lg font-bold ${net.cls}`}>{net.text}</p>
          <p className="text-xs text-slate-400">
            Авлага (тэд бидэнд): {tugrik(st.receivableMnt)} · Өглөг (бид тэдэнд): {tugrik(st.payableMnt)}
          </p>
        </div>
        {canOffset && (
          <button className="btn-primary text-sm" disabled={busy} onClick={() => void offset()}>
            Хасалт хийх ({tugrik(Math.min(st.receivableMnt, st.payableMnt))})
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="max-h-80 overflow-auto rounded border border-slate-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-steel-900 text-left text-xs text-slate-400">
            <tr>
              <th className="p-2">Огноо</th>
              <th>Төрөл</th>
              <th>Тайлбар</th>
              <th className="text-right">Дүн</th>
              <th className="text-right pr-2">Үлдэгдэл</th>
            </tr>
          </thead>
          <tbody>
            {st.lines.map((l, i) => (
              <tr key={`${l.entryId ?? l.orderId}-${i}`} className="border-t border-slate-800">
                <td className="p-2 text-xs text-slate-400 whitespace-nowrap">{new Date(l.at).toLocaleDateString('mn-MN')}</td>
                <td className="text-xs whitespace-nowrap">{KIND_MN[l.kind]}</td>
                <td className="text-xs">
                  {l.orderId ? (
                    <Link href={`/orders/${l.orderId}`} className="hover:underline">
                      {l.description}
                    </Link>
                  ) : (
                    l.description
                  )}
                  {canManage && l.editable && l.entryId && (
                    <button className="ml-2 text-[11px] text-amber-300 hover:underline" onClick={() => void edit(l.entryId!, l.effectMnt, l.kind)}>
                      засах
                    </button>
                  )}
                </td>
                <td className={`text-right whitespace-nowrap ${l.effectMnt > 0 ? 'text-amber-300' : 'text-sky-300'}`}>
                  {l.effectMnt > 0 ? '+' : l.effectMnt < 0 ? '−' : '±'}
                  {tugrik(Math.abs(l.effectMnt))}
                </td>
                <td className="text-right pr-2 whitespace-nowrap">{tugrik(l.balanceMnt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {st.lines.length === 0 && <p className="p-3 text-sm text-slate-500">Гүйлгээ алга.</p>}
      </div>

      {canManage && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-400">
            Гүйлгээ
            <select className="mt-1 block" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="PURCHASE">Бид түүнээс бараа/үйлчилгээ авсан</option>
              <option value="PAYMENT_TO_PARTNER">Бид түүнд мөнгө төлсөн</option>
              <option value="ADJUSTMENT">Залруулга (+ бид өртэй / − тэд өртэй)</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Дүн ₮
            <input className="mt-1 block w-32" type="number" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400 flex-1 min-w-[180px]">
            Тайлбар
            <input className="mt-1 block w-full" required minLength={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ж: 2000ш тоосго, гэрээ Г-12" />
          </label>
          <button className="btn-primary text-sm" disabled={busy}>
            Нэмэх
          </button>
        </form>
      )}
      <p className="text-[11px] text-slate-500">
        Бараа орлогод нийлүүлэгчээр энэ харилцагчийг сонгож үнэ оруулбал «Бид бараа авсан» мөр автоматаар нэмэгдэнэ.
      </p>
    </div>
  );
}
