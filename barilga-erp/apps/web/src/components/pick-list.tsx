'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { Order } from '@/lib/types';

type Item = Order['items'][number];

const qty = (v: number | string) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
const time = (iso?: string | null) =>
  iso ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';

/** Unticked lines of an order (the warning shown before completing). */
export function unpickedCount(order: Order) {
  return order.items.filter((i) => !i.pickedAt).length;
}

/**
 * Per-line picking checklist. Each tick is saved at once and shows who picked the line, so two or three
 * people can prepare one big order together (the page refreshes to show the others' ticks).
 */
export function PickList({ order, onChange }: { order: Order; onChange?: (items: Item[]) => void }) {
  const [items, setItems] = useState<Item[]>(order.items);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Keep in step with refreshed data from the parent (other people's ticks).
  const [seen, setSeen] = useState(order.items);
  if (seen !== order.items) {
    setSeen(order.items);
    setItems(order.items);
  }

  const done = items.filter((i) => i.pickedAt).length;

  async function toggle(item: Item) {
    const picked = !item.pickedAt;
    setBusy(item.id);
    setError('');
    try {
      const res = await api<{ id: string; pickedAt: string | null; pickedBy: Item['pickedBy'] }>(
        `/orders/${order.id}/items/${item.id}/pick`,
        { method: 'PATCH', body: JSON.stringify({ picked }) },
      );
      const next = items.map((i) => (i.id === item.id ? { ...i, pickedAt: res.pickedAt, pickedBy: res.pickedBy } : i));
      setItems(next);
      onChange?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 rounded bg-steel-800 overflow-hidden">
          <div
            className={`h-full ${done === items.length ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }}
          />
        </div>
        <span className="text-xs text-slate-300 whitespace-nowrap">
          {done}/{items.length} бэлдсэн
        </span>
      </div>
      <ul className="divide-y divide-slate-800 rounded-lg border border-slate-700">
        {items.map((i) => (
          <li key={i.id}>
            <label className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${i.pickedAt ? 'bg-emerald-950/30' : ''}`}>
              <input
                type="checkbox"
                className="h-5 w-5 accent-emerald-500"
                checked={Boolean(i.pickedAt)}
                disabled={busy === i.id}
                onChange={() => void toggle(i)}
              />
              <span className={`flex-1 text-sm ${i.pickedAt ? 'text-slate-400 line-through' : 'text-white'}`}>
                <span className="font-mono text-[11px] text-slate-500">{i.product.sku}</span> {i.product.nameMn}
                {i.sourceType === 'EXTERNAL_SUPPLIER' && <span className="ml-1 text-[11px] text-amber-300">(нийлүүлэгчээс)</span>}
              </span>
              <span className="text-sm font-semibold whitespace-nowrap">
                {qty(i.quantity)} {i.product.unit}
              </span>
              <span className="w-28 text-right text-[11px] text-emerald-300">
                {i.pickedAt ? `${i.pickedBy?.fullName ?? ''} ${time(i.pickedAt)}` : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
