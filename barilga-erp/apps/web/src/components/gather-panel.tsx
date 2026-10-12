'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { GatherPlan, StockTransfer } from '@/lib/types';

const n = (v: number) => v.toLocaleString('mn-MN', { maximumFractionDigits: 3 });

/**
 * For managers on a paid order: what the dispatch warehouse is missing and from which shops it will be
 * collected. "Gather" sends the transfers; the order can be completed once they are received.
 */
export function GatherPanel({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const [plan, setPlan] = useState<GatherPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<StockTransfer[]>([]);

  const load = useCallback(async () => {
    try {
      setError('');
      setPlan(await api<GatherPlan>(`/orders/${orderId}/gather-plan`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Төлөвлөгөө ачаалж чадсангүй');
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function gather() {
    if (!plan) return;
    const summary = plan.transfers.map((t) => `${t.from?.name}: ${t.items.length} бараа`).join(', ');
    if (!window.confirm(`${plan.dispatchWarehouse.name} руу шилжүүлэг илгээх үү?\n${summary}`)) return;
    setBusy(true);
    try {
      const res = await api<{ transfers: StockTransfer[]; plan: GatherPlan }>(`/orders/${orderId}/gather`, { method: 'POST' });
      setSent(res.transfers);
      setPlan(res.plan);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !plan) return <div className="card mb-6 text-sm text-red-400">{error}</div>;
  if (!plan) return null;

  const needsGather = plan.transfers.length > 0;
  const inTransit = plan.lines.some((l) => l.inTransit > 0);
  const missing = plan.lines.filter((l) => l.unavailable > 0);
  if (!needsGather && !inTransit && missing.length === 0) {
    return (
      <div className="card mb-6 text-sm text-emerald-300">
        {plan.dispatchWarehouse.name}-д бүх бараа бэлэн байна — ачиж болно.
      </div>
    );
  }

  return (
    <div className="card mb-6 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Бусад агуулахаас цуглуулах</h3>
          <p className="text-xs text-slate-400">
            Ачих агуулах: <span className="text-slate-200">{plan.dispatchWarehouse.name}</span>. Хамгийн их үлдэгдэлтэй
            агуулахаас эхэлж авна.
          </p>
        </div>
        {needsGather && (
          <button className="btn-primary text-sm" disabled={busy} onClick={() => void gather()}>
            {busy ? 'Илгээж байна…' : 'Цуглуулах шилжүүлэг илгээх'}
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr>
            <th className="py-1">Бараа</th>
            <th>Хэрэгтэй</th>
            <th>Ачих агуулахад</th>
            <th>Замд</th>
            <th>Цуглуулах</th>
            <th>Байхгүй</th>
          </tr>
        </thead>
        <tbody>
          {plan.lines.map((l) => (
            <tr key={l.product.id} className="border-t border-slate-800">
              <td className="py-1.5">
                <span className="font-mono text-[11px] text-slate-400">{l.product.sku}</span> {l.product.nameMn}
              </td>
              <td>{n(l.needed)}</td>
              <td>{n(l.atDispatch)}</td>
              <td className={l.inTransit > 0 ? 'text-amber-300' : ''}>{n(l.inTransit)}</td>
              <td className={l.toGather > 0 ? 'font-semibold' : ''}>{n(l.toGather)}</td>
              <td className={l.unavailable > 0 ? 'text-rose-300 font-semibold' : 'text-slate-500'}>{n(l.unavailable)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {needsGather && (
        <ul className="text-xs text-slate-300 space-y-0.5">
          {plan.transfers.map((t) => (
            <li key={t.from?.id}>
              <span className="text-slate-400">{t.from?.name} →</span>{' '}
              {t.items.map((i) => `${i.product.nameMn ?? i.product.sku} ${n(i.quantity)}`).join(', ')}
            </li>
          ))}
        </ul>
      )}
      {inTransit && (
        <p className="text-xs text-amber-300">
          Цуглуулж буй бараа замд байна. {plan.dispatchWarehouse.name} хүлээн авсны дараа захиалгыг дуусгах боломжтой.{' '}
          <Link href="/inventory/transfers" className="underline">
            Шилжүүлэг харах
          </Link>
        </p>
      )}
      {sent.length > 0 && (
        <p className="text-xs text-emerald-300">Илгээгдлээ: {sent.map((t) => t.transferNumber).join(', ')}</p>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-rose-300">
          Аль ч агуулахад байхгүй: {missing.map((l) => `${l.product.nameMn ?? l.product.sku} ${n(l.unavailable)}`).join(', ')} —
          нийлүүлэгчээс авах шаардлагатай.
        </p>
      )}
    </div>
  );
}
