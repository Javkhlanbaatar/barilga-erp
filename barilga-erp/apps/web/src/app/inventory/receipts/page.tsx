'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerPicker } from '@/components/customer-picker';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { CATEGORIES, UNITS, categoryKey, categoryLabel, unitLabel, withVolume } from '@/lib/catalog';
import { useFeatures } from '@/lib/features';
import { can, useCan } from '@/lib/permissions';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser, Customer, Product, Role, StockReceipt, Warehouse } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };
type Line = {
  productId: string;
  sku: string;
  nameMn: string;
  unit: string;
  quantity: string;
  unitCost: string;
  /** For the person receiving: the shelf price and the last purchase price, to catch a wrong cost. */
  priceMnt: number;
  lastCostMnt: number | null;
  stockQty: number;
};

/** May open the page (read receipts); taking goods in also needs the RECEIPT_CREATE right. Same rule as the API. */
const RECEIPT_ROLES: Role[] = ['ADMIN', 'MANAGER', 'ACHIGCH_BELTGEGCH'];
const qty = (v: string | number) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);

/** A product registered on the spot from an unknown code; sizes stay text so empty boxes stay empty. */
type NewProduct = {
  nameMn: string;
  sku: string;
  category: string;
  unit: string;
  priceMnt: string;
  weightKg: string;
  lengthM: string;
  widthM: string;
  heightM: string;
  volumeM3: string;
};

const isBarcodeLike = (code: string) => /^[0-9]{8,14}$/.test(code);

/** The form for an unknown code: a barcode becomes P-<last 8 digits> as SKU, anything else is used as typed. */
const newProductFor = (code: string): NewProduct => ({
  nameMn: '',
  sku: isBarcodeLike(code) ? `P-${code.slice(-8)}` : code,
  category: '',
  unit: 'ш',
  priceMnt: '',
  weightKg: '',
  lengthM: '',
  widthM: '',
  heightM: '',
  volumeM3: '',
});

/**
 * Бараа орлого: goods arriving from a supplier. Scan or search each product (scanning the same one again
 * adds one more), type the quantity and — managers — the unit cost. A code that is not registered yet can be
 * registered on the spot. The receipt can be printed for the supplier's driver to sign.
 */
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
  const [unknown, setUnknown] = useState<string | null>(null);
  const [newProduct, setNewProduct] = useState<NewProduct>(() => newProductFor(''));
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [filterFrom, setFilterFrom] = useState(() => ymd(new Date(Date.now() - 29 * 86_400_000)));
  /** Putting an existing receipt on a partner's account (or taking it off). */
  const [attach, setAttach] = useState<{ receipt: StockReceipt; partner: Customer | null; reason: string; busy: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const isOversight = hasRole(me?.role, OVERSIGHT_ROLES);
  const features = useFeatures();
  const canDo = useCan();
  const canAddProduct = canDo('PRODUCT_WRITE');
  const canReceive = canDo('RECEIPT_CREATE');
  // Purchase costs and the supplier partner put money we owe on the books: managers by default.
  const canCost = canDo('RECEIPT_COST_EDIT');
  const lockedTo = isOversight ? null : (me?.warehouseId ?? null);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<StockReceipt[]>('/inventory/receipts?limit=300'));
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
    if (!hasRole(user.role, RECEIPT_ROLES) && !can(user, 'RECEIPT_CREATE')) {
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
    setUnknown(null);
    setOpen(true);
    window.setTimeout(() => searchRef.current?.focus(), 50);
  }

  function close() {
    if (lines.length && !window.confirm('Оруулсан бараанууд хадгалагдахгүй. Хаах уу?')) return;
    setOpen(false);
  }

  /** Adds the product, or one more of it when it is already on the receipt (scanning twice = 2). */
  function addLine(p: Product) {
    setLines((prev) => {
      const at = prev.findIndex((l) => l.productId === p.id);
      if (at >= 0) return prev.map((l, i) => (i === at ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l));
      return [
        ...prev,
        {
          productId: p.id,
          sku: p.sku,
          nameMn: p.nameMn,
          unit: p.unit,
          quantity: '1',
          unitCost: '',
          priceMnt: p.priceMnt,
          lastCostMnt: (p as Product & { lastCostMnt?: number | null }).lastCostMnt ?? null,
          stockQty: Number(p.stockQty),
        },
      ];
    });
    setSearch('');
    setResults([]);
    setUnknown(null);
    searchRef.current?.focus();
  }

  /** Enter in the search box (or a scanner): exact barcode / code first, then the only match. */
  async function onEnter() {
    const code = search.trim();
    if (!code) return;
    const t = code.toLowerCase();
    const pick = (list: Product[]) =>
      list.find((r) => r.barcode === code) ?? list.find((r) => r.sku.toLowerCase() === t) ?? (list.length === 1 ? list[0] : undefined);
    const hit = pick(results);
    if (hit) return addLine(hit);
    try {
      const found = await api<Product[]>(`/products?q=${encodeURIComponent(code)}`);
      const exact = pick(found);
      if (exact) return addLine(exact);
      if (!found.length) {
        // Not registered: offer to register it with this code.
        setUnknown(code);
        setNewProduct(newProductFor(code));
      } else setResults(found.slice(0, 30));
    } catch {
      // keep typing
    }
  }

  /** Registers a product that arrived for the first time (its code as barcode), then puts it on the receipt. */
  async function createProduct() {
    if (!unknown || creatingProduct) return;
    const np = newProduct;
    const category = categoryKey(np.category);
    // Checked here, not with `required`: these boxes sit inside the receipt form and must not block saving it.
    if (np.nameMn.trim().length < 2) return setFormError('Барааны нэрийг бичнэ үү');
    if (!np.sku.trim()) return setFormError('Барааны код (SKU)-ыг бичнэ үү');
    if (!np.category.trim() || category === 'General') return setFormError('Ангиллаа сонгоно уу');
    if (!(Number(np.weightKg) > 0)) return setFormError('Жинг кг-аар оруулна уу (0-ээс их)');
    const isBarcode = isBarcodeLike(unknown);
    setFormError('');
    setCreatingProduct(true);
    try {
      const p = await api<Product>('/products', {
        method: 'POST',
        body: JSON.stringify({
          sku: np.sku.trim(),
          barcode: isBarcode ? unknown : undefined,
          nameMn: np.nameMn.trim(),
          nameEn: np.nameMn.trim(),
          unit: np.unit.trim() || 'ш',
          category,
          priceMnt: Math.max(0, Math.round(Number(np.priceMnt) || 0)),
          weightKg: Number(np.weightKg),
          lengthM: Number(np.lengthM) || 0,
          widthM: np.widthM.trim() ? Number(np.widthM) : null,
          heightM: np.heightM.trim() ? Number(np.heightM) : null,
          volumeM3: Number(np.volumeM3) || 0,
          stockQty: 0,
        }),
      });
      flash('ok', `«${p.nameMn}» бүртгэгдлээ`);
      addLine(p);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Бараа бүртгэж чадсангүй');
    } finally {
      setCreatingProduct(false);
    }
  }

  /** Enter in a box of the new-product form registers the product instead of saving the receipt. */
  const createOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void createProduct();
  };

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);
  const units = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  /** A manager corrects a purchase price later; the reason goes to the admin's edit report. */
  async function editCost(r: StockReceipt, i: StockReceipt['items'][number]) {
    const raw = window.prompt(`${i.product.nameMn}: шинэ нэгж үнэ (₮, хоосон бол үнэ оруулаагүй):`, i.unitCostMnt == null ? '' : String(i.unitCostMnt));
    if (raw === null) return;
    const reason = window.prompt('Засах шалтгаан (засварын түүхэд бичигдэнэ):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/inventory/receipts/${r.id}/items/${i.id}/cost`, {
        method: 'PATCH',
        body: JSON.stringify({ unitCostMnt: raw.trim() === '' ? null : Math.round(Number(raw)), reason: reason.trim() }),
      });
      flash('ok', 'Өртөг засагдлаа');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Засаж чадсангүй');
    }
  }

  async function saveAttach(e: FormEvent) {
    e.preventDefault();
    if (!attach || attach.reason.trim().length < 3) return;
    setAttach({ ...attach, busy: true });
    try {
      await api(`/inventory/receipts/${attach.receipt.id}/partner`, {
        method: 'PATCH',
        body: JSON.stringify({ supplierCustomerId: attach.partner?.id ?? null, reason: attach.reason.trim() }),
      });
      flash('ok', attach.partner ? `${attach.receipt.receiptNumber}: ${attach.partner.name}-ийн тооцоонд орлоо` : `${attach.receipt.receiptNumber}: тооцооноос гарлаа`);
      setAttach(null);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Хадгалж чадсангүй');
      setAttach((a) => (a ? { ...a, busy: false } : a));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!supplierName.trim() && !partner) return setFormError('Нийлүүлэгчийн нэрийг бичнэ үү');
    if (lines.length === 0) return setFormError('Дор хаяж нэг бараа нэмнэ үү');
    const bad = lines.find((l) => !(Number(l.quantity) > 0));
    if (bad) return setFormError(`${bad.nameMn}: тоо 0-ээс их байх ёстой`);
    setSaving(true);
    try {
      const created = await api<StockReceipt>('/inventory/receipts', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId,
          supplierName: (partner?.name ?? supplierName).trim(),
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
      setLines([]);
      flash('ok', `${created.receiptNumber}: ${lines.length} төрлийн бараа орлогод авлаа`);
      window.open(`/print/receipts/${created.id}`, '_blank', 'noopener');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  const shown = rows.filter((r) => ymd(new Date(r.receivedAt)) >= filterFrom);

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Агуулах</p>
          <h2 className="text-xl font-bold">Бараа орлого</h2>
          <p className="text-slate-400 text-sm mt-1">
            Нийлүүлэгчээс ирсэн барааг уншуулж эсвэл хайж нэмнэ — нэг барааг дахин уншуулбал тоо нь нэмэгдэнэ. Өртгийг менежер оруулна.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-400">
            Хэзээнээс
            <input type="date" className="mt-1 block" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </label>
          {canReceive &&
            (isOversight || lockedTo ? (
              <button className="btn-primary" onClick={openCreate}>
                + Орлого авах
              </button>
            ) : (
              <p className="text-xs text-slate-400 max-w-[220px]">Орлого авахын тулд танд агуулах оноогдсон байх ёстой.</p>
            ))}
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
              <th className="text-right">Өртгийн дүн</th>
              <th className="pr-3" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
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
                    {canCost && features.enabled('PARTNER_ACCOUNTS') && (
                      <button
                        className="block text-[11px] text-amber-300 hover:underline"
                        onClick={() => setAttach({ receipt: r, partner: null, reason: '', busy: false })}
                      >
                        {r.supplierCustomer ? 'харилцагч солих / салгах' : 'харилцагчийн тооцоонд оруулах'}
                      </button>
                    )}
                    {r.supplierInvoiceNo && <span className="block text-xs text-slate-400">№ {r.supplierInvoiceNo}</span>}
                    {r.notes && <span className="block text-xs text-slate-500">{r.notes}</span>}
                  </td>
                  <td className="py-3">
                    <ul className="space-y-0.5">
                      {r.items.map((i) => (
                        <li key={i.id}>
                          {i.product.nameMn} · <b>{qty(i.quantity)}</b> {unitLabel(i.product.unit)}
                          {i.unitCostMnt != null && <span className="text-slate-400"> × {tugrik(i.unitCostMnt)}</span>}
                          {canCost && (
                            <button className="ml-2 text-[11px] text-amber-300 hover:underline" onClick={() => void editCost(r, i)}>
                              өртөг засах
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-3 text-right">
                    {costed.length ? tugrik(sum) : '—'}
                    {costed.length > 0 && costed.length < r.items.length && <span className="block text-[11px] text-slate-500">хэсэгчлэн</span>}
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <a className="btn-ghost px-2 py-1 text-xs" href={`/print/receipts/${r.id}`} target="_blank" rel="noreferrer">
                      🖨
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
        {!loading && shown.length === 0 && <p className="p-3 text-slate-500">Энэ хугацаанд орлого алга. «+ Орлого авах» дарж эхэлнэ.</p>}
      </div>

      {attach && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !attach.busy && setAttach(null)}>
          <form onSubmit={saveAttach} className="card w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">{attach.receipt.receiptNumber}: нийлүүлэгч харилцагч</h3>
            <p className="text-xs text-slate-400">
              Одоо: <b>{attach.receipt.supplierName}</b>
              {attach.receipt.supplierCustomer ? ' (тооцоонд орсон)' : ' (тооцоонд ороогүй)'}. Сонгосон харилцагчийн өглөгт энэ орлогын өртөгтэй
              мөрүүдийн дүн орно; хоосон үлдээвэл тооцооноос гарна.
            </p>
            <CustomerPicker
              value={attach.partner}
              onChange={(c) => setAttach({ ...attach, partner: c })}
              filter={(c) => !!c.sellsToUs || !!c.barterContract}
            />
            <label className="block text-xs text-slate-400">
              Шалтгаан (засварын түүхэд бичигдэнэ)
              <input
                className="mt-1 block w-full"
                required
                minLength={3}
                value={attach.reason}
                onChange={(e) => setAttach({ ...attach, reason: e.target.value })}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setAttach(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={attach.busy || (!attach.partner && !attach.receipt.supplierCustomer)}>
                {attach.partner ? 'Тооцоонд оруулах' : 'Тооцооноос гаргах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submit} className="card w-full max-w-4xl space-y-4 max-h-[92vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Бараа орлого авах</h3>
              <button type="button" className="btn-ghost text-xs" onClick={close}>
                ✕
              </button>
            </div>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs text-slate-400">
                1. Аль агуулахад авах
                <select className="mt-1 w-full" value={warehouseId} disabled={!!lockedTo} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses
                    .filter((w) => w.isActive)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="block text-xs text-slate-400">
                2. Нийлүүлэгч
                <div className="mt-1 space-y-1">
                  {canCost && (
                    <CustomerPicker
                      value={partner}
                      onChange={(c) => {
                        setPartner(c);
                        if (c) setSupplierName(c.name);
                      }}
                      filter={(c) => !!c.sellsToUs || !!c.barterContract}
                    />
                  )}
                  {!partner && (
                    <input
                      className="w-full"
                      placeholder={canCost ? 'Гэрээгүй бол нэрээр бичнэ' : 'Нийлүүлэгчийн нэр'}
                      value={supplierName}
                      onChange={(e) => setSupplierName(e.target.value)}
                    />
                  )}
                  {partner && <p className="text-[11px] text-sky-300">Өртөгтэй мөрүүд энэ харилцагчийн тооцоонд (өглөг) орно.</p>}
                </div>
              </div>
              <label className="block text-xs text-slate-400">
                Падаан / нэхэмжлэхийн № (заавал биш)
                <input className="mt-1 w-full" value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} />
              </label>
            </div>

            <div className="relative">
              <p className="mb-1 text-xs text-slate-400">3. Бараа (баркод уншуулах эсвэл нэр, код бичээд Enter)</p>
              <input
                ref={searchRef}
                className="w-full text-base"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void onEnter();
                }}
                placeholder="🔍 Баркод / нэр / код…"
              />
              {results.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border border-slate-700 bg-steel-900 divide-y divide-slate-800">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="flex w-full justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-steel-800" onClick={() => addLine(p)}>
                        <span>
                          {p.nameMn} <span className="font-mono text-[11px] text-slate-500">{p.sku}</span>
                        </span>
                        <span className="text-xs text-slate-400">үлдэгдэл {qty(p.stockQty)} {unitLabel(p.unit)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {unknown && (
              <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm">
                <p className="text-amber-200">
                  «<span className="font-mono">{unknown}</span>» бүртгэлгүй бараа.
                  {!canAddProduct && ' Бараа бүртгэх эрхтэй ажилтнаар (админ, ерөнхий менежер) бүртгүүлнэ үү.'}
                </p>
                {canAddProduct && (
                  <div className="mt-2 space-y-2 text-xs text-slate-400">
                    <div className="grid gap-2 sm:grid-cols-4">
                      <label className="sm:col-span-2">
                        Барааны нэр
                        <input
                          className="mt-1 w-full"
                          maxLength={160}
                          value={newProduct.nameMn}
                          onChange={(e) => setNewProduct({ ...newProduct, nameMn: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <label>
                        Код (SKU)
                        <input
                          className="mt-1 w-full font-mono"
                          maxLength={64}
                          value={newProduct.sku}
                          onChange={(e) => setNewProduct({ ...newProduct, sku: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <label>
                        Ангилал
                        <input
                          className="mt-1 w-full"
                          list="receipt-new-categories"
                          maxLength={60}
                          placeholder="Сонгох эсвэл бичих"
                          value={newProduct.category}
                          onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                        <datalist id="receipt-new-categories">
                          {CATEGORIES.filter((c) => c !== 'General').map((c) => (
                            <option key={c} value={categoryLabel(c)} />
                          ))}
                        </datalist>
                      </label>
                      <label>
                        Нэгж
                        <input
                          className="mt-1 w-full"
                          list="receipt-new-units"
                          maxLength={16}
                          value={newProduct.unit}
                          onChange={(e) => setNewProduct({ ...newProduct, unit: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                        <datalist id="receipt-new-units">
                          {UNITS.map((u) => (
                            <option key={u} value={u} />
                          ))}
                        </datalist>
                      </label>
                      <label>
                        Зарах үнэ ₮
                        <input
                          className="mt-1 w-full"
                          inputMode="numeric"
                          value={newProduct.priceMnt}
                          onChange={(e) => setNewProduct({ ...newProduct, priceMnt: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <label>
                        Жин (кг)
                        <input
                          className="mt-1 w-full"
                          type="number"
                          step="any"
                          placeholder="заавал"
                          value={newProduct.weightKg}
                          onChange={(e) => setNewProduct({ ...newProduct, weightKg: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {(
                        [
                          ['lengthM', 'Урт (м)'],
                          ['widthM', 'Өргөн (м)'],
                          ['heightM', 'Өндөр (м)'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            className="mt-1 w-full"
                            type="number"
                            step="any"
                            value={newProduct[key]}
                            onChange={(e) => setNewProduct(withVolume({ ...newProduct, [key]: e.target.value }))}
                            onKeyDown={createOnEnter}
                          />
                        </label>
                      ))}
                      <label>
                        Эзлэхүүн (м³)
                        <input
                          className="mt-1 w-full"
                          type="number"
                          step="any"
                          value={newProduct.volumeM3}
                          onChange={(e) => setNewProduct({ ...newProduct, volumeM3: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn-primary self-end text-sm"
                        disabled={creatingProduct}
                        onClick={() => void createProduct()}
                      >
                        {creatingProduct ? 'Бүртгэж байна…' : 'Бүртгээд нэмэх'}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500">Урт, өргөн, өндрийг бөглөхөд эзлэхүүн автоматаар бодогдоно.</p>
                  </div>
                )}
              </div>
            )}

            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400 text-xs">
                  <tr>
                    <th className="py-1">Бараа</th>
                    <th>Одоо байгаа</th>
                    <th>Ирсэн тоо</th>
                    <th>Нэгж өртөг ₮</th>
                    <th className="text-right">Дүн</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => {
                    const cost = Number(l.unitCost) || 0;
                    const warn = cost > 0 && l.priceMnt > 0 && cost >= l.priceMnt;
                    return (
                      <tr key={l.productId} className="border-t border-slate-800 align-top">
                        <td className="py-1.5">
                          {l.nameMn}
                          <span className="block font-mono text-[11px] text-slate-500">
                            {l.sku} · зарах үнэ {tugrik(l.priceMnt)}
                          </span>
                        </td>
                        <td className="text-xs text-slate-400">
                          {qty(l.stockQty)} {unitLabel(l.unit)}
                        </td>
                        <td>
                          <input
                            className="w-24 text-right"
                            type="number"
                            min="0.001"
                            step="any"
                            required
                            value={l.quantity}
                            onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                searchRef.current?.focus();
                              }
                            }}
                          />{' '}
                          <span className="text-xs text-slate-400">{unitLabel(l.unit)}</span>
                        </td>
                        <td>
                          <input
                            className={`w-28 text-right ${warn ? 'border-red-500' : ''}`}
                            type="number"
                            min="0"
                            step="1"
                            disabled={!canCost}
                            placeholder={canCost ? (l.lastCostMnt != null ? `өмнө ${l.lastCostMnt}` : '') : 'өртөг оруулах эрхгүй'}
                            value={l.unitCost}
                            onChange={(e) => setLines(lines.map((x, i) => (i === idx ? { ...x, unitCost: e.target.value } : x)))}
                          />
                          {warn && <span className="block text-[11px] text-red-300">зарах үнээс их/тэнцүү</span>}
                          {canCost && l.lastCostMnt != null && !l.unitCost && (
                            <button
                              type="button"
                              className="block text-[11px] text-amber-brand hover:underline"
                              onClick={() => setLines(lines.map((x, i) => (i === idx ? { ...x, unitCost: String(l.lastCostMnt) } : x)))}
                            >
                              өмнөх өртөг {tugrik(l.lastCostMnt)}
                            </button>
                          )}
                        </td>
                        <td className="text-right text-slate-300">{l.unitCost && l.quantity ? tugrik(cost * Number(l.quantity)) : '—'}</td>
                        <td className="text-right">
                          <button type="button" className="btn-ghost text-xs px-2 py-0.5" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 text-sm">
                    <td className="py-2 font-semibold">{lines.length} төрөл</td>
                    <td />
                    <td className="font-semibold">{qty(units)}</td>
                    <td />
                    <td className="text-right font-bold">{total > 0 ? tugrik(total) : '—'}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}

            <label className="block text-xs text-slate-400">
              Тэмдэглэл
              <input className="mt-1 w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ж: машин 1234 УБА, гэмтэлтэй 2 ш буцаасан" />
            </label>
            <div className="flex items-center justify-end gap-2 pt-2">
              <span className="mr-auto text-xs text-slate-500">Хадгалсны дараа орлогын баримт хэвлэх цонх нээгдэнэ.</span>
              <button type="button" className="btn-ghost" onClick={close}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving || !lines.length}>
                {saving ? 'Хадгалж байна…' : `Орлогод авах (${lines.length})`}
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
