'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES, TRANSFER_ROLES } from '@/lib/rbac';
import { AuthUser, StockTransfer, TransferStatus, Warehouse } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };
type StockRow = { id: string; sku: string; nameMn: string; unit: string; stockQty: number };
type Line = { productId: string; sku: string; nameMn: string; unit: string; available: number; quantity: string };

const STATUS_LABEL: Record<TransferStatus, string> = {
  IN_TRANSIT: 'Замд',
  RECEIVED: 'Хүлээн авсан',
  CANCELLED: 'Цуцалсан',
};
const STATUS_STYLE: Record<TransferStatus, string> = {
  IN_TRANSIT: 'border-amber-600 bg-amber-950/60 text-amber-200',
  RECEIVED: 'border-emerald-700 bg-emerald-950/50 text-emerald-200',
  CANCELLED: 'border-slate-600 text-slate-400',
};
const FILTERS: Array<{ key: TransferStatus | 'ALL'; label: string }> = [
  { key: 'IN_TRANSIT', label: 'Замд' },
  { key: 'RECEIVED', label: 'Хүлээн авсан' },
  { key: 'CANCELLED', label: 'Цуцалсан' },
  { key: 'ALL', label: 'Бүгд' },
];

const qty = (v: string | number) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('mn-MN') : '—');

export default function TransfersPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [rows, setRows] = useState<StockTransfer[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filter, setFilter] = useState<TransferStatus | 'ALL'>('IN_TRANSIT');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // create modal
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<StockRow[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const isOversight = hasRole(me?.role, OVERSIGHT_ROLES);
  const lockedTo = isOversight ? null : (me?.warehouseId ?? null);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === 'ALL' ? '' : `?status=${filter}`;
      setRows(await api<StockTransfer[]>(`/inventory/transfers${qs}`));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, [filter, flash]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const user = JSON.parse(raw) as AuthUser;
    if (!hasRole(user.role, TRANSFER_ROLES)) {
      router.replace(homeForRole(user.role));
      return;
    }
    setMe(user);
    void api<Warehouse[]>('/inventory/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, [router]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  // Product search in the source warehouse (shows what it actually holds).
  useEffect(() => {
    if (!open || !fromId) return;
    const term = search.trim();
    const handle = window.setTimeout(async () => {
      try {
        const res = await api<{ items: StockRow[] }>(
          `/inventory/stock?warehouseId=${encodeURIComponent(fromId)}${term ? `&q=${encodeURIComponent(term)}` : ''}`,
        );
        setResults(res.items.filter((i) => i.stockQty > 0).slice(0, 30));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [open, fromId, search]);

  const destinations = useMemo(() => warehouses.filter((w) => w.isActive && w.id !== fromId), [warehouses, fromId]);

  function openCreate() {
    const from = lockedTo ?? warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? '';
    setFromId(from);
    setToId(warehouses.find((w) => w.isActive && w.id !== from)?.id ?? '');
    setLines([]);
    setSearch('');
    setNotes('');
    setFormError('');
    setOpen(true);
  }

  function addLine(row: StockRow) {
    if (lines.some((l) => l.productId === row.id)) return;
    setLines([...lines, { productId: row.id, sku: row.sku, nameMn: row.nameMn, unit: row.unit, available: row.stockQty, quantity: '' }]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    const items = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    if (!toId) return setFormError('Хүлээн авах агуулахаа сонгоно уу');
    if (items.length === 0) return setFormError('Дор хаяж нэг бараа нэмнэ үү');
    const bad = lines.find((l) => !(Number(l.quantity) > 0) || Number(l.quantity) > l.available);
    if (bad) return setFormError(`${bad.sku}: тоо 0-ээс их, үлдэгдэл (${qty(bad.available)})-ээс ихгүй байх ёстой`);
    setSaving(true);
    try {
      const created = await api<StockTransfer>('/inventory/transfers', {
        method: 'POST',
        body: JSON.stringify({ fromWarehouseId: fromId, toWarehouseId: toId, items, notes: notes.trim() || undefined }),
      });
      setOpen(false);
      flash('ok', `${created.transferNumber} илгээгдлээ — бараа замд байна`);
      setFilter('IN_TRANSIT');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Илгээж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  async function receive(t: StockTransfer) {
    if (!window.confirm(`${t.transferNumber}: ${t.toWarehouse.name}-д бүх барааг хүлээн авсан уу?`)) return;
    setBusyId(t.id);
    try {
      await api(`/inventory/transfers/${t.id}/receive`, { method: 'POST' });
      flash('ok', `${t.transferNumber} хүлээн авлаа`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(t: StockTransfer) {
    const reason = window.prompt(`${t.transferNumber}-г цуцлах шалтгаан (бараа ${t.fromWarehouse.name}-д буцна):`);
    if (!reason || reason.trim().length < 3) return;
    setBusyId(t.id);
    try {
      await api(`/inventory/transfers/${t.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      flash('ok', `${t.transferNumber} цуцлагдлаа`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusyId(null);
    }
  }

  const canReceive = (t: StockTransfer) => t.status === 'IN_TRANSIT' && (isOversight || lockedTo === t.toWarehouse.id);
  const canSend = isOversight || !!lockedTo;

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Агуулах</p>
          <h2 className="text-xl font-bold">Агуулах хоорондын шилжүүлэг</h2>
          <p className="text-slate-400 text-sm mt-1">
            Илгээхэд бараа эх агуулахаас шууд хасагдана. Хүлээн авах агуулах «Хүлээн авах» дарахад нэмэгдэнэ.
          </p>
        </div>
        <div className="flex gap-2">
          {canSend ? (
            <button className="btn-primary" onClick={openCreate} disabled={warehouses.length < 2}>
              Шинэ шилжүүлэг
            </button>
          ) : (
            <p className="text-xs text-slate-400 max-w-[220px]">Шилжүүлэг илгээхийн тулд танд агуулах оноогдсон байх ёстой.</p>
          )}
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`rounded-md px-3 py-1.5 text-sm ${filter === f.key ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Хаанаас → Хаашаа</th>
              <th>Бараа</th>
              <th>Илгээсэн</th>
              <th>Хүлээн авсан / цуцалсан</th>
              <th>Төлөв</th>
              <th className="pr-3 text-right">Үйлдэл</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-slate-800 align-top">
                <td className="p-3">
                  <p className="font-mono text-xs">{t.transferNumber}</p>
                  {t.order && (
                    <Link href={`/orders/${t.order.id}`} className="text-[11px] text-amber-300 hover:underline">
                      Захиалга {t.order.orderNumber}
                    </Link>
                  )}
                </td>
                <td className="py-3">
                  {t.fromWarehouse.name} <span className="text-slate-500">→</span> {t.toWarehouse.name}
                </td>
                <td className="py-3">
                  <ul className="space-y-0.5">
                    {t.items.map((i) => (
                      <li key={i.id}>
                        <span className="font-mono text-[11px] text-slate-400">{i.product.sku}</span> {i.product.nameMn} ·{' '}
                        <span className="font-semibold">{qty(i.quantity)}</span> {i.product.unit}
                      </li>
                    ))}
                  </ul>
                  {t.notes && <p className="text-xs text-slate-500 mt-1">{t.notes}</p>}
                </td>
                <td className="py-3 text-xs text-slate-300">
                  {t.sentBy?.fullName ?? '—'}
                  <br />
                  {when(t.sentAt)}
                </td>
                <td className="py-3 text-xs text-slate-300">
                  {t.status === 'RECEIVED' && (
                    <>
                      {t.receivedBy?.fullName ?? '—'}
                      <br />
                      {when(t.receivedAt)}
                    </>
                  )}
                  {t.status === 'CANCELLED' && (
                    <>
                      {t.cancelledBy?.fullName ?? '—'} · {when(t.cancelledAt)}
                      <br />
                      <span className="text-slate-500">{t.cancelReason}</span>
                    </>
                  )}
                  {t.status === 'IN_TRANSIT' && '—'}
                </td>
                <td className="py-3">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[t.status]}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                </td>
                <td className="py-3 pr-3">
                  <div className="flex justify-end gap-1">
                    {canReceive(t) && (
                      <button className="btn-primary text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void receive(t)}>
                        Хүлээн авах
                      </button>
                    )}
                    {t.status === 'IN_TRANSIT' && isOversight && (
                      <button className="btn-danger text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void cancel(t)}>
                        Цуцлах
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
        {!loading && rows.length === 0 && <p className="p-3 text-slate-500">Шилжүүлэг алга.</p>}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submit} className="card w-full max-w-2xl space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">Шинэ шилжүүлэг</h3>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-slate-400">
                Хаанаас
                <select
                  className="mt-1 w-full"
                  value={fromId}
                  disabled={!!lockedTo}
                  onChange={(e) => {
                    setFromId(e.target.value);
                    setLines([]);
                    if (toId === e.target.value) setToId('');
                  }}
                >
                  {warehouses.filter((w) => w.isActive).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-400">
                Хаашаа
                <select className="mt-1 w-full" value={toId} required onChange={(e) => setToId(e.target.value)}>
                  <option value="">— сонгох —</option>
                  {destinations.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block text-xs text-slate-400">
              Бараа хайх (зөвхөн эх агуулахад байгаа)
              <input className="mt-1 w-full" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Код эсвэл нэр…" />
            </label>
            {results.length > 0 && (
              <ul className="max-h-40 overflow-auto rounded border border-slate-700 divide-y divide-slate-800">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-steel-800 disabled:opacity-40"
                      disabled={lines.some((l) => l.productId === r.id)}
                      onClick={() => addLine(r)}
                    >
                      <span className="font-mono text-[11px] text-slate-400">{r.sku}</span> {r.nameMn}
                      <span className="float-right text-slate-400">
                        {qty(r.stockQty)} {r.unit}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400 text-xs">
                  <tr>
                    <th className="py-1">Бараа</th>
                    <th>Үлдэгдэл</th>
                    <th>Илгээх тоо</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.productId} className="border-t border-slate-800">
                      <td className="py-1.5">
                        <span className="font-mono text-[11px] text-slate-400">{l.sku}</span> {l.nameMn}
                      </td>
                      <td className="text-slate-400">
                        {qty(l.available)} {l.unit}
                      </td>
                      <td>
                        <input
                          className="w-28"
                          type="number"
                          min="0.001"
                          step="any"
                          max={l.available}
                          required
                          value={l.quantity}
                          onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                        />
                      </td>
                      <td className="text-right">
                        <button type="button" className="btn-ghost text-xs px-2 py-0.5" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <label className="block text-xs text-slate-400">
              Тэмдэглэл (машин, жолооч г.м.)
              <input className="mt-1 w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Илгээж байна…' : 'Илгээх'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg ${
            toast.kind === 'error' ? 'border-red-700 bg-red-950 text-red-100' : 'border-emerald-700 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}
