'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerPicker } from '@/components/customer-picker';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser, Customer, Product, Role, StockReceipt, Warehouse } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };
type Line = { productId: string; sku: string; nameMn: string; unit: string; quantity: string; unitCost: string };

const RECEIPT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'];
const qty = (v: string | number) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });

export default function ReceiptsPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [rows, setRows] = useState<StockReceipt[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast | null>(null);
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  /** Registered partner the goods came from: priced lines then go into their account. */
  const [partner, setPartner] = useState<Customer | null>(null);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
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
      setRows(await api<StockReceipt[]>('/inventory/receipts'));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const user = JSON.parse(raw) as AuthUser;
    if (!hasRole(user.role, RECEIPT_ROLES)) {
      router.replace(homeForRole(user.role));
      return;
    }
    setMe(user);
    void api<Warehouse[]>('/inventory/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, [router]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  useEffect(() => {
    if (!open) return;
    const term = search.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        setResults((await api<Product[]>(`/products?q=${encodeURIComponent(term)}`)).slice(0, 30));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [open, search]);

  function openCreate() {
    setWarehouseId(lockedTo ?? warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? '');
    setSupplierName('');
    setPartner(null);
    setSupplierInvoiceNo('');
    setNotes('');
    setSearch('');
    setLines([]);
    setFormError('');
    setOpen(true);
  }

  function addLine(p: Product) {
    if (lines.some((l) => l.productId === p.id)) return;
    setLines([...lines, { productId: p.id, sku: p.sku, nameMn: p.nameMn, unit: p.unit, quantity: '1', unitCost: '' }]);
    setSearch('');
    setResults([]);
  }

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);

  /** A manager corrects a purchase price later; the reason goes to the admin's edit report. */
  async function editCost(r: StockReceipt, i: StockReceipt['items'][number]) {
    const raw = window.prompt(`${i.product.nameMn}: шинэ нэгж үнэ (₮, хоосон бол үнэгүй):`, i.unitCostMnt == null ? '' : String(i.unitCostMnt));
    if (raw === null) return;
    const reason = window.prompt('Засах шалтгаан (админ харна):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/inventory/receipts/${r.id}/items/${i.id}/cost`, {
        method: 'PATCH',
        body: JSON.stringify({ unitCostMnt: raw.trim() === '' ? null : Math.round(Number(raw)), reason: reason.trim() }),
      });
      flash('ok', 'Үнэ засагдлаа');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Засаж чадсангүй');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (lines.length === 0) return setFormError('Дор хаяж нэг бараа нэмнэ үү');
    const bad = lines.find((l) => !(Number(l.quantity) > 0));
    if (bad) return setFormError(`${bad.sku}: тоо 0-ээс их байх ёстой`);
    setSaving(true);
    try {
      const created = await api<StockReceipt>('/inventory/receipts', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId,
          supplierName: supplierName.trim(),
          supplierCustomerId: partner?.id,
          supplierInvoiceNo: supplierInvoiceNo.trim() || undefined,
          notes: notes.trim() || undefined,
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            ...(l.unitCost.trim() ? { unitCostMnt: Math.round(Number(l.unitCost)) } : {}),
          })),
        }),
      });
      setOpen(false);
      flash('ok', `${created.receiptNumber}: ${lines.length} бараа орлогод авлаа`);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Агуулах</p>
          <h2 className="text-xl font-bold">Бараа орлого</h2>
          <p className="text-slate-400 text-sm mt-1">
            Нийлүүлэгчээс ирсэн барааг агуулахад авна. Өртөг заавал биш. Алдааг «Агуулахын үлдэгдэл» дээр тохируулгаар засна.
          </p>
        </div>
        <div className="flex gap-2">
          {isOversight || lockedTo ? (
            <button className="btn-primary" onClick={openCreate}>
              Орлого авах
            </button>
          ) : (
            <p className="text-xs text-slate-400 max-w-[220px]">Орлого авахын тулд танд агуулах оноогдсон байх ёстой.</p>
          )}
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Огноо</th>
              <th>Агуулах</th>
              <th>Нийлүүлэгч</th>
              <th>Бараа</th>
              <th className="text-right pr-3">Өртгийн дүн</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const costed = r.items.filter((i) => i.unitCostMnt != null);
              const sum = costed.reduce((s, i) => s + Number(i.quantity) * (i.unitCostMnt ?? 0), 0);
              return (
                <tr key={r.id} className="border-t border-slate-800 align-top">
                  <td className="p-3 font-mono text-xs">{r.receiptNumber}</td>
                  <td className="py-3 text-xs text-slate-300">
                    {new Date(r.receivedAt).toLocaleString('mn-MN')}
                    <br />
                    {r.receivedBy?.fullName}
                  </td>
                  <td className="py-3">{r.warehouse.name}</td>
                  <td className="py-3">
                    {r.supplierName}
                    {r.supplierCustomer && <span className="block text-[11px] text-sky-300">харилцагчийн тооцоонд орсон</span>}
                    {r.supplierInvoiceNo && <span className="block text-xs text-slate-400">№ {r.supplierInvoiceNo}</span>}
                    {r.notes && <span className="block text-xs text-slate-500">{r.notes}</span>}
                  </td>
                  <td className="py-3">
                    <ul className="space-y-0.5">
                      {r.items.map((i) => (
                        <li key={i.id}>
                          <span className="font-mono text-[11px] text-slate-400">{i.product.sku}</span> {i.product.nameMn} ·{' '}
                          <b>{qty(i.quantity)}</b> {i.product.unit}
                          {i.unitCostMnt != null && <span className="text-slate-400"> × {tugrik(i.unitCostMnt)}</span>}
                          {isOversight && (
                            <button className="ml-2 text-[11px] text-amber-300 hover:underline" onClick={() => void editCost(r, i)}>
                              үнэ засах
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-3 pr-3 text-right">
                    {costed.length ? tugrik(sum) : '—'}
                    {costed.length > 0 && costed.length < r.items.length && (
                      <span className="block text-[11px] text-slate-500">хэсэгчлэн</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
        {!loading && rows.length === 0 && <p className="p-3 text-slate-500">Орлого алга.</p>}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submit} className="card w-full max-w-3xl space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">Бараа орлого авах</h3>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs text-slate-400">
                Агуулах
                <select className="mt-1 w-full" value={warehouseId} disabled={!!lockedTo} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.filter((w) => w.isActive).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="block text-xs text-slate-400 space-y-1">
                Нийлүүлэгч
                <CustomerPicker
                  value={partner}
                  onChange={(c) => {
                    setPartner(c);
                    if (c) setSupplierName(c.name);
                  }}
                  filter={(c) => !!c.sellsToUs || !!c.barterContract}
                />
                {!partner && (
                  <input
                    className="w-full"
                    required
                    minLength={2}
                    placeholder="эсвэл нэрээр бичих (тооцоонд орохгүй)"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                  />
                )}
              </div>
              <label className="block text-xs text-slate-400">
                Падаан / нэхэмжлэхийн № (заавал биш)
                <input className="mt-1 w-full" value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} />
              </label>
            </div>

            <div className="relative">
              <input
                className="w-full"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // Barcode scanner / Enter: add the exact code or the only match.
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const t = search.trim().toLowerCase();
                  const hit = results.find((r) => r.sku.toLowerCase() === t) ?? (results.length === 1 ? results[0] : undefined);
                  if (hit) return addLine(hit);
                  // A scanner is faster than the search: look the code up directly.
                  void api<Product[]>(`/products?q=${encodeURIComponent(search.trim())}`)
                    .then((found) => {
                      const exact = found.find((r) => r.sku.toLowerCase() === t);
                      if (exact) addLine(exact);
                    })
                    .catch(() => undefined);
                }}
                placeholder="Бараа хайх эсвэл баркод уншуулах (Enter нэмнэ)…"
              />
              {results.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded border border-slate-700 bg-steel-900 divide-y divide-slate-800">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-steel-800" onClick={() => addLine(p)}>
                        <span className="font-mono text-[11px] text-slate-400">{p.sku}</span> {p.nameMn}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400 text-xs">
                  <tr>
                    <th className="py-1">Бараа</th>
                    <th>Тоо</th>
                    <th>Нэгж өртөг ₮ (заавал биш)</th>
                    <th className="text-right">Дүн</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.productId} className="border-t border-slate-800">
                      <td className="py-1.5">
                        <span className="font-mono text-[11px] text-slate-400">{l.sku}</span> {l.nameMn}
                      </td>
                      <td>
                        <input
                          className="w-24"
                          type="number"
                          min="0.001"
                          step="any"
                          required
                          value={l.quantity}
                          onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                        />{' '}
                        <span className="text-xs text-slate-400">{l.unit}</span>
                      </td>
                      <td>
                        <input
                          className="w-32"
                          type="number"
                          min="0"
                          step="1"
                          value={l.unitCost}
                          onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, unitCost: e.target.value } : x)))}
                        />
                      </td>
                      <td className="text-right text-slate-300">
                        {l.unitCost && l.quantity ? tugrik(Number(l.unitCost) * Number(l.quantity)) : '—'}
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
            {total > 0 && <p className="text-right text-sm">Өртгийн нийт дүн: <b>{tugrik(total)}</b></p>}

            <label className="block text-xs text-slate-400">
              Тэмдэглэл
              <input className="mt-1 w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Орлогод авах'}
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
