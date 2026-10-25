'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { Customer, CustomerDetail, ORDER_STATUS_LABEL, Order, Product, productMatchesQuery } from '@/lib/types';

type Tab = 'product' | 'customer' | 'order';
type Availability = {
  product: { id: string; sku: string; nameMn: string; unit: string; priceMnt: number };
  warehouses: Array<{ id: string; code: string; name: string; quantity: number; inTransit: number }>;
};

const qty = (n: number) => n.toLocaleString('mn-MN', { maximumFractionDigits: 3 });

/**
 * Лавлах: look things up at the till without selling — a product's price and where it is in stock, a
 * customer's debt and recent orders, an order's state. Opened with F2 or the button on the POS.
 */
export function PosLookup({ products, onClose, onAdd }: { products: Product[]; onClose: () => void; onAdd?: (p: Product) => void }) {
  const [tab, setTab] = useState<Tab>('product');
  const [q, setQ] = useState('');
  const [avail, setAvail] = useState<Availability | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setError('');
    const term = q.trim();
    if (tab === 'product' || term.length < 2) {
      setCustomers([]);
      setOrders([]);
      return;
    }
    const h = window.setTimeout(async () => {
      try {
        if (tab === 'customer') setCustomers(await api<Customer[]>(`/customers?q=${encodeURIComponent(term)}`));
        if (tab === 'order') setOrders(await api<Order[]>(`/orders?q=${encodeURIComponent(term)}&take=15`));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Алдаа');
      }
    }, 250);
    return () => window.clearTimeout(h);
  }, [q, tab]);

  const productHits = tab === 'product' && q.trim() ? products.filter((p) => productMatchesQuery(p, q)).slice(0, 12) : [];

  async function showProduct(p: Product) {
    setError('');
    try {
      setAvail(await api<Availability>(`/inventory/availability/${p.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа');
    }
  }

  async function showCustomer(c: Customer) {
    try {
      setDetail(await api<CustomerDetail>(`/customers/${c.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа');
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-auto space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Лавлах</h3>
          <button className="btn-ghost text-xs" onClick={onClose}>
            Хаах (Esc)
          </button>
        </div>
        <div className="flex gap-1">
          {(
            [
              ['product', 'Бараа'],
              ['customer', 'Харилцагч'],
              ['order', 'Захиалга'],
            ] as Array<[Tab, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
              onClick={() => {
                setTab(k);
                setAvail(null);
                setDetail(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="w-full"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tab === 'product' ? 'Барааны нэр, код (кирилл эсвэл латин)…' : tab === 'customer' ? 'Нэр, утас, РД…' : 'Захиалгын дугаар, утас, нэр…'}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}

        {tab === 'product' && (
          <div className="grid gap-3 md:grid-cols-2">
            <ul className="max-h-80 divide-y divide-slate-800 overflow-auto rounded border border-slate-800">
              {productHits.map((p) => (
                <li key={p.id}>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-steel-800" onClick={() => void showProduct(p)}>
                    <span className="font-mono text-[11px] text-slate-400">{p.sku}</span> {p.nameMn}
                    <span className="float-right text-amber-brand">{tugrik(p.priceMnt)}</span>
                  </button>
                </li>
              ))}
              {q.trim() && productHits.length === 0 && <li className="p-3 text-sm text-slate-500">Олдсонгүй</li>}
            </ul>
            {avail && (
              <div className="space-y-2 rounded border border-slate-700 p-3 text-sm">
                <p className="font-semibold">
                  {avail.product.nameMn} <span className="font-mono text-xs text-slate-400">{avail.product.sku}</span>
                </p>
                <p>
                  Үнэ: <b className="text-amber-brand">{tugrik(avail.product.priceMnt)}</b> / {avail.product.unit}
                </p>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400">
                    <tr>
                      <th>Агуулах</th>
                      <th className="text-right">Үлдэгдэл</th>
                      <th className="text-right">Замд</th>
                    </tr>
                  </thead>
                  <tbody>
                    {avail.warehouses.map((w) => (
                      <tr key={w.id} className="border-t border-slate-800">
                        <td className="py-1">{w.name}</td>
                        <td className={`text-right ${w.quantity > 0 ? 'text-emerald-300' : 'text-slate-500'}`}>
                          {qty(w.quantity)} {avail.product.unit}
                        </td>
                        <td className="text-right text-slate-400">{w.inTransit ? qty(w.inTransit) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {onAdd && (
                  <button
                    className="btn-primary w-full text-sm"
                    onClick={() => {
                      const p = products.find((x) => x.id === avail.product.id);
                      if (p) onAdd(p);
                      onClose();
                    }}
                  >
                    Сагсанд нэмэх
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'customer' && (
          <div className="grid gap-3 md:grid-cols-2">
            <ul className="max-h-80 divide-y divide-slate-800 overflow-auto rounded border border-slate-800">
              {customers.map((c) => (
                <li key={c.id}>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-steel-800" onClick={() => void showCustomer(c)}>
                    {c.name} <span className="text-xs text-slate-400">· {c.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
            {detail && (
              <div className="space-y-1 rounded border border-slate-700 p-3 text-sm">
                <p className="font-semibold">{detail.name}</p>
                <p className="text-xs text-slate-400">
                  {detail.phone}
                  {detail.regNumber ? ` · РД ${detail.regNumber}` : ''}
                </p>
                <p>
                  Өр:{' '}
                  <b className={(detail.credit?.owedMnt ?? 0) > 0 ? 'text-amber-300' : 'text-emerald-300'}>{tugrik(detail.credit?.owedMnt ?? 0)}</b>
                </p>
                <p className="text-xs">
                  {detail.creditAllowed ? 'Дараа төлөх эрхтэй' : 'Дараа төлөх эрхгүй'}
                  {detail.priceList ? ` · үнийн жагсаалт: ${detail.priceList.name}` : ''}
                </p>
                <p className="pt-1 text-xs text-slate-400">Сүүлийн захиалгууд</p>
                <ul className="text-xs">
                  {detail.recentOrders.slice(0, 6).map((o) => (
                    <li key={o.id}>
                      <Link className="text-amber-brand hover:underline" href={`/orders/${o.id}`}>
                        {o.orderNumber}
                      </Link>{' '}
                      · {ORDER_STATUS_LABEL[o.status] ?? o.status} · {tugrik(o.totalMnt)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {tab === 'order' && (
          <ul className="divide-y divide-slate-800 rounded border border-slate-800 text-sm">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <Link className="font-mono text-amber-brand hover:underline" href={`/orders/${o.id}`}>
                    {o.orderNumber}
                  </Link>{' '}
                  · {o.customerName} · {o.customerPhone}
                </span>
                <span className="text-xs">
                  {ORDER_STATUS_LABEL[o.status] ?? o.status} · <b>{tugrik(o.totalMnt)}</b>
                </span>
              </li>
            ))}
            {q.trim().length >= 2 && orders.length === 0 && <li className="p-3 text-slate-500">Олдсонгүй</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
