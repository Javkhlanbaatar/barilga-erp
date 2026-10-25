'use client';

import { FormEvent, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import type { Order } from '@/lib/types';

/** What is still owed on an order released on account (зарлагаар), 0 when nothing. */
export function owedOnOrder(order: Order) {
  return (order.payments ?? [])
    .filter((p) => (p.method ?? p.provider) === 'CREDIT' && p.status === 'UNPAID')
    .reduce((s, p) => s + p.amountMnt, 0);
}

/**
 * Taking a payment against what the customer owes. Partial payments are fine; when the debt reaches 0 the
 * server issues the E-Barimt.
 */
export function CreditPanel({ order, onPaid }: { order: Order; onPaid: (o: Order) => void }) {
  const owed = owedOnOrder(order);
  const features = useFeatures();
  const [amount, setAmount] = useState(owed);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (owed <= 0) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!window.confirm(`${tugrik(amount)} ${method === 'CASH' ? 'бэлнээр' : method === 'CARD' ? 'картаар' : 'шилжүүлгээр'} төлбөр авсан уу?`)) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<Order>(`/orders/${order.id}/settle-credit`, {
        method: 'POST',
        body: JSON.stringify({ method, amountMnt: amount }),
      });
      onPaid(updated);
      setAmount(owedOnOrder(updated));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Төлбөр бүртгэж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mb-6 border-amber-700/60 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Дараа төлөх — өр</h3>
          <p className="text-sm text-slate-400">
            Үлдэгдэл өр: <span className="text-lg font-bold text-amber-300">{tugrik(owed)}</span>.
            {features.enabled('EBARIMT') && ' И-баримт өр бүрэн төлөгдөхөд гарна.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-full text-xs text-slate-400 sm:w-auto">
          Төлж буй дүн
          <input
            className="mt-1 block w-full sm:w-40"
            type="number"
            inputMode="numeric"
            min={1}
            max={owed}
            required
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {(['CASH', 'CARD', 'TRANSFER'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`min-h-[40px] rounded-md px-3 py-2 text-sm ${method === m ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
              onClick={() => setMethod(m)}
            >
              {m === 'CASH' ? 'Бэлэн' : m === 'CARD' ? 'Карт' : 'Шилжүүлэг'}
            </button>
          ))}
        </div>
        <button className="btn-primary" disabled={busy || amount <= 0 || amount > owed}>
          {busy ? '…' : 'Төлбөр бүртгэх'}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
