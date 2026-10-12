'use client';

import Link from 'next/link';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES, TRANSFER_ROLES } from '@/lib/rbac';
import { AuthUser, StockTransfer, TransferStatus, Warehouse } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };
type StockRow = { id: string; sku: string; nameMn: string; unit: string; stockQty: number };
type Line = { productId: string; sku: string; nameMn: string; unit: string; available: number | null; quantity: string };
type Suggestion = { productId: string; sku: string; nameMn: string; unit: string; atShop: number; atSource: number; minStockLevel: number; suggested: number };
type Mode = 'send' | 'request';
type ActLine = { productId: string; label: string; unit: string; base: number; available?: number; value: string; reason: string };

const STATUS_LABEL: Record<TransferStatus, string> = {
  REQUESTED: 'Хүсэлт',
  IN_TRANSIT: 'Замд',
  RECEIVED: 'Хүлээн авсан',
  CANCELLED: 'Цуцалсан',
};
const STATUS_STYLE: Record<TransferStatus, string> = {
  REQUESTED: 'border-sky-600 bg-sky-950/60 text-sky-200',
  IN_TRANSIT: 'border-amber-600 bg-amber-950/60 text-amber-200',
  RECEIVED: 'border-emerald-700 bg-emerald-950/50 text-emerald-200',
  CANCELLED: 'border-slate-600 text-slate-400',
};
const FILTERS: Array<{ key: TransferStatus | 'ALL'; label: string }> = [
  { key: 'REQUESTED', label: 'Хүсэлт' },
  { key: 'IN_TRANSIT', label: 'Замд' },
  { key: 'RECEIVED', label: 'Хүлээн авсан' },
  { key: 'CANCELLED', label: 'Цуцалсан' },
  { key: 'ALL', label: 'Бүгд' },
];

const qty = (v: string | number | null | undefined) => Number(v ?? 0).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }) : '—');

/**
 * Stock between shops: a shop requests (or a warehouse sends directly), the source sends — possibly fewer than
 * asked — and the destination receives what actually arrived, recording any shortage with its reason.
 */
export default function TransfersPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [rows, setRows] = useState<StockTransfer[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filter, setFilter] = useState<TransferStatus | 'ALL'>('IN_TRANSIT');
  const [pending, setPending] = useState<{ toSend: number; toReceive: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // create modal (send directly, or request)
  const [mode, setMode] = useState<Mode | null>(null);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<StockRow[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // act modal (dispatch a request / receive / cancel)
  const [act, setAct] = useState<{ kind: 'dispatch' | 'receive' | 'cancel'; t: StockTransfer } | null>(null);
  const [actLines, setActLines] = useState<ActLine[]>([]);
  const [actText, setActText] = useState('');
  const [actError, setActError] = useState('');

  const isOversight = hasRole(me?.role, OVERSIGHT_ROLES);
  const lockedTo = isOversight ? null : (me?.warehouseId ?? null);
  const active = useMemo(() => warehouses.filter((w) => w.isActive), [warehouses]);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === 'ALL' ? '' : `?status=${filter}`;
      const [list, p] = await Promise.all([
        api<StockTransfer[]>(`/inventory/transfers${qs}`),
        api<{ toSend: number; toReceive: number }>('/inventory/transfers/pending').catch(() => null),
      ]);
      setRows(list);
      setPending(p);
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
    // Open on whatever is waiting for this user.
    void api<{ toSend: number; toReceive: number }>('/inventory/transfers/pending')
      .then((p) => {
        if (p.toSend > 0 && p.toReceive === 0) setFilter('REQUESTED');
      })
      .catch(() => undefined);
  }, [router]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  // Product search: what the source warehouse holds.
  useEffect(() => {
    if (!mode || !fromId) return;
    const term = search.trim();
    const handle = window.setTimeout(async () => {
      try {
        const res = await api<{ items: StockRow[] }>(
          `/inventory/stock?warehouseId=${encodeURIComponent(fromId)}${term ? `&q=${encodeURIComponent(term)}` : ''}`,
        );
        setResults(res.items.filter((i) => mode === 'request' || i.stockQty > 0).slice(0, 30));
      } catch {
        setResults([]);
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [mode, fromId, search]);

  function openCreate(m: Mode) {
    const def = warehouses.find((w) => w.isDefault)?.id ?? active[0]?.id ?? '';
    if (m === 'send') {
      const from = lockedTo ?? def;
      setFromId(from);
      setToId(active.find((w) => w.id !== from)?.id ?? '');
    } else {
      // A shop asks for itself, usually from the main warehouse.
      const to = lockedTo ?? active.find((w) => w.id !== def)?.id ?? '';
      setToId(to);
      setFromId(to === def ? (active.find((w) => w.id !== to)?.id ?? '') : def);
    }
    setLines([]);
    setSearch('');
    setNotes('');
    setFormError('');
    setMode(m);
  }

  function addLine(row: StockRow, quantity = '') {
    setLines((ls) =>
      ls.some((l) => l.productId === row.id)
        ? ls
        : [...ls, { productId: row.id, sku: row.sku, nameMn: row.nameMn, unit: row.unit, available: row.stockQty, quantity }],
    );
  }

  /** Enter in the search box: an exact code (barcode scanner) or the only match is added at once. */
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = search.trim().toLowerCase();
    const hit = results.find((r) => r.sku.toLowerCase() === term) ?? (results.length === 1 ? results[0] : undefined);
    if (hit) {
      addLine(hit, '1');
      setSearch('');
      return;
    }
    // A scanner is faster than the search: look the code up in the source warehouse directly.
    if (!fromId || !term) return;
    void api<{ items: StockRow[] }>(`/inventory/stock?warehouseId=${encodeURIComponent(fromId)}&q=${encodeURIComponent(search.trim())}`)
      .then((res) => {
        const exact = res.items.find((r) => r.sku.toLowerCase() === term);
        if (exact) {
          addLine(exact, '1');
          setSearch('');
        }
      })
      .catch(() => undefined);
  }

  async function loadSuggestions() {
    if (!fromId || !toId) return;
    try {
      const s = await api<Suggestion[]>(`/inventory/transfers/suggest?to=${encodeURIComponent(toId)}&from=${encodeURIComponent(fromId)}`);
      if (!s.length) return setFormError('Доод үлдэгдлээс доош орсон бараа алга (барааны «доод үлдэгдэл»-ийг тохируулсан байх ёстой).');
      setFormError('');
      setLines((ls) => {
        const next = [...ls];
        for (const r of s) {
          if (next.some((l) => l.productId === r.productId)) continue;
          next.push({ productId: r.productId, sku: r.sku, nameMn: r.nameMn, unit: r.unit, available: r.atSource, quantity: String(r.suggested) });
        }
        return next;
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Санал авч чадсангүй');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    const items = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    if (!toId || !fromId) return setFormError('Хаанаас, хаашаа гэдгийг сонгоно уу');
    if (items.length === 0) return setFormError('Дор хаяж нэг бараа нэмнэ үү');
    const bad = lines.find((l) => !(Number(l.quantity) > 0) || (mode === 'send' && l.available !== null && Number(l.quantity) > l.available));
    if (bad) return setFormError(`${bad.sku}: тоо 0-ээс их${mode === 'send' ? `, үлдэгдэл (${qty(bad.available)})-ээс ихгүй` : ''} байх ёстой`);
    setSaving(true);
    try {
      const created = await api<StockTransfer>(mode === 'request' ? '/inventory/transfers/request' : '/inventory/transfers', {
        method: 'POST',
        body: JSON.stringify({ fromWarehouseId: fromId, toWarehouseId: toId, items, notes: notes.trim() || undefined }),
      });
      setMode(null);
      flash('ok', mode === 'request' ? `${created.transferNumber} хүсэлт илгээгдлээ` : `${created.transferNumber} илгээгдлээ — бараа замд байна`);
      setFilter(mode === 'request' ? 'REQUESTED' : 'IN_TRANSIT');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  async function openAct(kind: 'dispatch' | 'receive' | 'cancel', t: StockTransfer) {
    setActError('');
    setActText('');
    if (kind === 'dispatch') {
      // Show what the source holds next to what was asked; default to what can actually be sent.
      let stock: StockRow[] = [];
      try {
        stock = (await api<{ items: StockRow[] }>(`/inventory/stock?warehouseId=${encodeURIComponent(t.fromWarehouse.id)}`)).items;
      } catch {
        stock = [];
      }
      setActLines(
        t.items.map((i) => {
          const asked = Number(i.requestedQty ?? 0);
          const have = stock.find((s) => s.id === i.product.id)?.stockQty ?? 0;
          return { productId: i.product.id, label: `${i.product.sku} ${i.product.nameMn}`, unit: i.product.unit, base: asked, available: have, value: String(Math.max(0, Math.min(asked, have))), reason: '' };
        }),
      );
    } else if (kind === 'receive') {
      setActLines(
        t.items
          .filter((i) => Number(i.quantity) > 0)
          .map((i) => ({ productId: i.product.id, label: `${i.product.sku} ${i.product.nameMn}`, unit: i.product.unit, base: Number(i.quantity), value: String(Number(i.quantity)), reason: '' })),
      );
    } else {
      setActLines([]);
    }
    setAct({ kind, t });
  }

  async function submitAct(e: FormEvent) {
    e.preventDefault();
    if (!act) return;
    const { kind, t } = act;
    setActError('');
    let path = '';
    let body: unknown = {};
    if (kind === 'dispatch') {
      const items = actLines.map((l) => ({ productId: l.productId, quantity: Number(l.value) }));
      if (items.some((i) => !(i.quantity >= 0))) return setActError('Тоо буруу байна');
      if (!items.some((i) => i.quantity > 0)) return setActError('Илгээх бараа алга — татгалзах бол «Татгалзах» дарна уу');
      const over = actLines.find((l) => l.available !== undefined && Number(l.value) > l.available);
      if (over) return setActError(`${over.label}: үлдэгдэл ${qty(over.available)} байна`);
      path = `/inventory/transfers/${t.id}/dispatch`;
      body = { items, notes: actText.trim() || undefined };
    } else if (kind === 'receive') {
      const items = actLines.map((l) => ({ productId: l.productId, receivedQty: Number(l.value), reason: l.reason.trim() || undefined }));
      const bad = actLines.find((l) => !(Number(l.value) >= 0) || Number(l.value) > l.base);
      if (bad) return setActError(`${bad.label}: 0-ээс ${qty(bad.base)} хүртэл`);
      const noReason = actLines.find((l) => Number(l.value) < l.base && l.reason.trim().length < 3);
      if (noReason) return setActError(`${noReason.label}: дутуу ирсэн шалтгааныг бичнэ үү`);
      path = `/inventory/transfers/${t.id}/receive`;
      body = { items };
    } else {
      if (actText.trim().length < 3) return setActError('Шалтгаанаа бичнэ үү (3+ тэмдэгт)');
      path = `/inventory/transfers/${t.id}/cancel`;
      body = { reason: actText.trim() };
    }
    setBusyId(t.id);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setAct(null);
      flash('ok', kind === 'dispatch' ? `${t.transferNumber} илгээгдлээ` : kind === 'receive' ? `${t.transferNumber} хүлээн авлаа` : `${t.transferNumber} хаагдлаа`);
      await load();
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusyId(null);
    }
  }

  async function receiveAll(t: StockTransfer) {
    if (!window.confirm(`${t.transferNumber}: бүх бараа бүрэн ирсэн үү?`)) return;
    setBusyId(t.id);
    try {
      await api(`/inventory/transfers/${t.id}/receive`, { method: 'POST', body: JSON.stringify({}) });
      flash('ok', `${t.transferNumber} хүлээн авлаа`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusyId(null);
    }
  }

  const mine = (warehouseId: string) => isOversight || lockedTo === warehouseId;
  const canSend = isOversight || !!lockedTo;
  const fromChoices = mode === 'send' && lockedTo ? active.filter((w) => w.id === lockedTo) : active.filter((w) => w.id !== toId);
  const toChoices = mode === 'request' && lockedTo ? active.filter((w) => w.id === lockedTo) : active.filter((w) => w.id !== fromId);

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Агуулах</p>
          <h2 className="text-xl font-bold">Агуулах хоорондын шилжүүлэг</h2>
          <p className="text-slate-400 text-sm mt-1">
            Дэлгүүр бараа <b>хүснэ</b> → эх агуулах <b>илгээнэ</b> (бараа тэндээс хасагдана) → хүлээн авагч ирсэн тоогоор <b>хүлээн авна</b>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSend ? (
            <>
              <button className="btn-primary" onClick={() => openCreate('request')} disabled={active.length < 2}>
                Бараа хүсэх
              </button>
              <button className="btn-ghost" onClick={() => openCreate('send')} disabled={active.length < 2}>
                Шууд илгээх
              </button>
            </>
          ) : (
            <p className="text-xs text-slate-400 max-w-[220px]">Шилжүүлэг хийхийн тулд танд агуулах оноогдсон байх ёстой.</p>
          )}
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      {pending && (pending.toSend > 0 || pending.toReceive > 0) && (
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          {pending.toSend > 0 && (
            <button className="rounded-lg border border-sky-700 bg-sky-950/40 px-3 py-1.5 text-sky-200" onClick={() => setFilter('REQUESTED')}>
              Илгээх хүсэлт: <b>{pending.toSend}</b>
            </button>
          )}
          {pending.toReceive > 0 && (
            <button className="rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-1.5 text-amber-200" onClick={() => setFilter('IN_TRANSIT')}>
              Хүлээн авах: <b>{pending.toReceive}</b>
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1 mb-3">
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
              <th>Хүссэн / илгээсэн</th>
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
                    {t.items.map((i) => {
                      const sent = Number(i.quantity);
                      const asked = i.requestedQty != null ? Number(i.requestedQty) : null;
                      const got = i.receivedQty != null ? Number(i.receivedQty) : null;
                      return (
                        <li key={i.id}>
                          <span className="font-mono text-[11px] text-slate-400">{i.product.sku}</span> {i.product.nameMn} ·{' '}
                          {t.status === 'REQUESTED' ? (
                            <span className="font-semibold">{qty(asked)}</span>
                          ) : (
                            <span className="font-semibold">{qty(sent)}</span>
                          )}{' '}
                          {i.product.unit}
                          {asked != null && t.status !== 'REQUESTED' && asked !== sent && <span className="text-xs text-slate-500"> (хүссэн {qty(asked)})</span>}
                          {got != null && got < sent && (
                            <span className="text-xs text-red-300">
                              {' '}
                              · ирсэн {qty(got)}, дутуу {qty(sent - got)}
                              {i.shortageReason ? ` — ${i.shortageReason}` : ''}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {t.notes && <p className="text-xs text-slate-500 mt-1">{t.notes}</p>}
                </td>
                <td className="py-3 text-xs text-slate-300">
                  {t.requestedBy && (
                    <p>
                      Хүссэн: {t.requestedBy.fullName} · {when(t.requestedAt)}
                    </p>
                  )}
                  {t.sentBy && (
                    <p>
                      Илгээсэн: {t.sentBy.fullName} · {when(t.sentAt)}
                    </p>
                  )}
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
                  {(t.status === 'IN_TRANSIT' || t.status === 'REQUESTED') && '—'}
                </td>
                <td className="py-3">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[t.status]}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                  {t.hasShortage && <span className="ml-1 inline-flex rounded-full border border-red-700 px-2 py-0.5 text-[11px] text-red-300">Дутуу ирсэн</span>}
                </td>
                <td className="py-3 pr-3">
                  <div className="flex flex-wrap justify-end gap-1">
                    {t.status === 'REQUESTED' && mine(t.fromWarehouse.id) && (
                      <button className="btn-primary text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void openAct('dispatch', t)}>
                        Илгээх
                      </button>
                    )}
                    {t.status === 'IN_TRANSIT' && mine(t.toWarehouse.id) && (
                      <>
                        <button className="btn-primary text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void receiveAll(t)}>
                          Бүгд ирсэн
                        </button>
                        <button className="btn-ghost text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void openAct('receive', t)}>
                          Дутуу ирсэн
                        </button>
                      </>
                    )}
                    {t.status !== 'REQUESTED' && t.status !== 'CANCELLED' && (
                      <a className="btn-ghost text-xs px-3 py-1" href={`/print/transfers/${t.id}`} target="_blank" rel="noreferrer">
                        Хэвлэх
                      </a>
                    )}
                    {t.status === 'REQUESTED' && (mine(t.fromWarehouse.id) || mine(t.toWarehouse.id)) && (
                      <button className="btn-ghost text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void openAct('cancel', t)}>
                        {mine(t.fromWarehouse.id) && !isOversight ? 'Татгалзах' : 'Цуцлах'}
                      </button>
                    )}
                    {t.status === 'IN_TRANSIT' && isOversight && (
                      <button className="btn-danger text-xs px-3 py-1" disabled={busyId === t.id} onClick={() => void openAct('cancel', t)}>
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

      {mode && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submit} className="card w-full max-w-2xl space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">{mode === 'request' ? 'Бараа хүсэх' : 'Шууд илгээх'}</h3>
            <p className="text-xs text-slate-400">
              {mode === 'request'
                ? 'Хүсэлт явуулахад бараа хөдлөхгүй. Эх агуулах илгээсний дараа замд гарна.'
                : 'Илгээхэд бараа эх агуулахаас шууд хасагдана.'}
            </p>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-slate-400">
                Хаанаас
                <select
                  className="mt-1 w-full"
                  value={fromId}
                  onChange={(e) => {
                    setFromId(e.target.value);
                    setLines([]);
                  }}
                >
                  <option value="">— сонгох —</option>
                  {fromChoices.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-400">
                Хаашаа
                <select className="mt-1 w-full" value={toId} onChange={(e) => setToId(e.target.value)}>
                  <option value="">— сонгох —</option>
                  {toChoices.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex items-end gap-2">
              <label className="block flex-1 text-xs text-slate-400">
                Бараа хайх эсвэл баркод уншуулах (Enter нэмнэ)
                <input
                  className="mt-1 w-full"
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder="Код эсвэл нэр…"
                />
              </label>
              {mode === 'request' && (
                <button type="button" className="btn-ghost text-sm" onClick={() => void loadSuggestions()} title="Доод үлдэгдлээс доош орсон барааг нэмнэ">
                  Дутагдлаар санал
                </button>
              )}
            </div>
            {results.length > 0 && search.trim() && (
              <ul className="max-h-40 overflow-auto rounded border border-slate-700 divide-y divide-slate-800">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-steel-800 disabled:opacity-40"
                      disabled={lines.some((l) => l.productId === r.id)}
                      onClick={() => {
                        addLine(r);
                        setSearch('');
                      }}
                    >
                      <span className="font-mono text-[11px] text-slate-400">{r.sku}</span> {r.nameMn}
                      <span className="float-right text-slate-400">
                        эх агуулахад {qty(r.stockQty)} {r.unit}
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
                    <th>Эх агуулахад</th>
                    <th>{mode === 'request' ? 'Хүсэх тоо' : 'Илгээх тоо'}</th>
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
                        {l.available === null ? '—' : `${qty(l.available)} ${l.unit}`}
                      </td>
                      <td className="whitespace-nowrap">
                        <input
                          className="w-24"
                          type="number"
                          min="0.001"
                          step="any"
                          required
                          value={l.quantity}
                          onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                        />
                        {mode === 'send' && l.available !== null && (
                          <button
                            type="button"
                            className="ml-1 text-[11px] text-amber-300 hover:underline"
                            onClick={() => setLines(lines.map((x, i) => (i === idx ? { ...x, quantity: String(l.available) } : x)))}
                          >
                            бүгд
                          </button>
                        )}
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
              Тэмдэглэл {mode === 'send' ? '(машин, жолооч г.м.)' : '(хэзээ хэрэгтэй г.м.)'}
              <input className="mt-1 w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setMode(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : mode === 'request' ? 'Хүсэлт илгээх' : 'Илгээх'}
              </button>
            </div>
          </form>
        </div>
      )}

      {act && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submitAct} className="card w-full max-w-xl space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">
              {act.t.transferNumber} —{' '}
              {act.kind === 'dispatch' ? 'хүсэлтийг илгээх' : act.kind === 'receive' ? 'ирсэн тоогоор хүлээн авах' : 'цуцлах / татгалзах'}
            </h3>
            <p className="text-xs text-slate-400">
              {act.t.fromWarehouse.name} → {act.t.toWarehouse.name}
            </p>
            {actError && <p className="text-sm text-red-400">{actError}</p>}
            {act.kind !== 'cancel' && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-400">
                  <tr>
                    <th className="py-1">Бараа</th>
                    <th>{act.kind === 'dispatch' ? 'Хүссэн / байгаа' : 'Илгээсэн'}</th>
                    <th>{act.kind === 'dispatch' ? 'Илгээх' : 'Ирсэн'}</th>
                  </tr>
                </thead>
                <tbody>
                  {actLines.map((l, idx) => {
                    const short = act.kind === 'receive' && Number(l.value) < l.base;
                    return (
                      <tr key={l.productId} className="border-t border-slate-800 align-top">
                        <td className="py-1.5">{l.label}</td>
                        <td className="text-slate-400 whitespace-nowrap">
                          {qty(l.base)} {l.unit}
                          {act.kind === 'dispatch' && <span className={l.available! < l.base ? ' text-red-300' : ''}> / {qty(l.available)}</span>}
                        </td>
                        <td>
                          <input
                            className="w-24"
                            type="number"
                            min="0"
                            step="any"
                            value={l.value}
                            onChange={(e) => setActLines(actLines.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)))}
                          />
                          {short && (
                            <input
                              className="mt-1 block w-full text-xs"
                              placeholder="Дутуу шалтгаан (урагдсан, ирээгүй…)"
                              value={l.reason}
                              onChange={(e) => setActLines(actLines.map((x, i) => (i === idx ? { ...x, reason: e.target.value } : x)))}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {act.kind !== 'receive' && (
              <label className="block text-xs text-slate-400">
                {act.kind === 'dispatch' ? 'Тэмдэглэл (машин, жолооч)' : 'Шалтгаан'}
                <input className="mt-1 w-full" value={actText} onChange={(e) => setActText(e.target.value)} maxLength={300} />
              </label>
            )}
            {act.kind === 'cancel' && act.t.status === 'IN_TRANSIT' && (
              <p className="text-xs text-amber-300">Замд байгаа бараа {act.t.fromWarehouse.name}-д буцаж орно.</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setAct(null)}>
                Болих
              </button>
              <button className={act.kind === 'cancel' ? 'btn-danger' : 'btn-primary'} disabled={busyId === act.t.id}>
                {act.kind === 'dispatch' ? 'Илгээх' : act.kind === 'receive' ? 'Хүлээн авах' : 'Цуцлах'}
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
