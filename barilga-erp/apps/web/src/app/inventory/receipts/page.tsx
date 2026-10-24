'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerPicker } from '@/components/customer-picker';
import { Modal } from '@/components/modal';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import {
  NEW_CATEGORY,
  NEW_UNIT,
  categoryLabel,
  categoryOptions,
  isNoCategory,
  parseDecimal,
  unitLabel,
  unitOptions,
  useCategories,
  useUnits,
  withVolume,
} from '@/lib/catalog';
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

/** A ₮ amount as typed: spaces, thousands commas and ₮ are ignored ("15,000" = 15000); null when empty, NaN when not a number. */
function parseMoney(v: string): number | null {
  const s = v.replace(/[\s,₮]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s));
}

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

/** A size typed in the new-product form: 0 when empty. */
const size = (v: string) => (v.trim() ? parseDecimal(v) : 0);

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
  const { units: unitList, addNew: addNewUnit } = useUnits();
  const { categories: categoryList, addNew: addNewCategory } = useCategories();
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
    // A quantity the form refuses ("1,200") is not counted on from: the scan is not added and the line says why.
    const refused = lines.find((l) => l.productId === p.id && l.quantity.trim() && Number.isNaN(parseDecimal(l.quantity)));
    if (refused) {
      setFormError(`${refused.nameMn}: «${refused.quantity}» тоог эхлээд засна уу (мянгатын таслалгүй — 1200 эсвэл 1.2), дараа нь дахин уншуулна`);
      // The scanned code is cleared, so scanning again after fixing the number works.
      setSearch('');
      setResults([]);
      return;
    }
    setLines((prev) => {
      const at = prev.findIndex((l) => l.productId === p.id);
      if (at >= 0) {
        return prev.map((l, i) => {
          if (i !== at) return l;
          const q = parseDecimal(l.quantity);
          if (Number.isNaN(q) && l.quantity.trim()) return l;
          // Rounded to the 3 decimals a quantity may have (0.14 + 1 is not 1.1400000000000001).
          return { ...l, quantity: String(Math.round(((Number.isNaN(q) ? 0 : q) + 1) * 1000) / 1000) };
        });
      }
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

  /** The unit <select> of the new-product form: a saved unit, or «+ Шинэ нэгж» (asks for the name, saves it). */
  async function pickUnit(value: string) {
    if (value !== NEW_UNIT) return setNewProduct((np) => ({ ...np, unit: value }));
    try {
      const unit = await addNewUnit();
      if (unit) setNewProduct((np) => ({ ...np, unit }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Нэгж нэмж чадсангүй');
    }
  }

  /** The category <select> of the new-product form: a listed category, or «+ Шинэ ангилал» (asks for the name, saves it when allowed). */
  async function pickCategory(value: string) {
    if (value !== NEW_CATEGORY) return setNewProduct((np) => ({ ...np, category: value }));
    try {
      const name = await addNewCategory(canAddProduct);
      if (name) setNewProduct((np) => ({ ...np, category: name }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ангилал нэмж чадсангүй');
    }
  }

  /** Registers a product that arrived for the first time (its code as barcode), then puts it on the receipt. */
  async function createProduct() {
    if (!unknown || creatingProduct) return;
    const np = newProduct;
    const category = np.category.trim();
    const weightKg = parseDecimal(np.weightKg);
    const sizes = [np.lengthM, np.widthM, np.heightM, np.volumeM3].map(size);
    const price = parseMoney(np.priceMnt);
    // Checked here, not with `required`: these boxes sit inside the receipt form and must not block saving it.
    if (np.nameMn.trim().length < 2) return setFormError('Барааны нэрийг бичнэ үү');
    if (!np.sku.trim()) return setFormError('Барааны код (SKU)-ыг бичнэ үү');
    if (!category || isNoCategory(category)) return setFormError('Ангиллаа сонгоно уу');
    if (!(weightKg > 0) || weightKg > 100000) return setFormError('Жинг кг-аар оруулна уу (0-ээс их, жишээ: 0,5 эсвэл 1250 — мянгатын таслал бичихгүй)');
    if (sizes.some((v) => !Number.isFinite(v) || v < 0)) return setFormError('Урт, өргөн, өндөр, эзлэхүүнийг тоогоор бичнэ үү (жишээ: 0,25 эсвэл 1.25; «1,250» гэж бичихгүй)');
    if (price !== null && !Number.isFinite(price)) return setFormError('Зарах үнийг тоогоор бичнэ үү');
    const [lengthM, widthM, heightM, volumeM3] = sizes;
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
          priceMnt: Math.max(0, price ?? 0),
          weightKg,
          lengthM,
          widthM: np.widthM.trim() ? widthM : null,
          heightM: np.heightM.trim() ? heightM : null,
          volumeM3,
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

  const lineQty = (l: Line) => parseDecimal(l.quantity);
  const lineCost = (l: Line) => parseMoney(l.unitCost);
  const total = lines.reduce((s, l) => s + (lineQty(l) || 0) * (lineCost(l) || 0), 0);
  const units = lines.reduce((s, l) => s + (lineQty(l) || 0), 0);

  /** A manager corrects a purchase price later; the reason goes to the admin's edit report. */
  async function editCost(r: StockReceipt, i: StockReceipt['items'][number]) {
    const raw = window.prompt(`${i.product.nameMn}: шинэ нэгж үнэ (₮, хоосон бол үнэ оруулаагүй):`, i.unitCostMnt == null ? '' : String(i.unitCostMnt));
    if (raw === null) return;
    const cost = parseMoney(raw);
    if (cost !== null && !Number.isFinite(cost)) return flash('error', 'Үнийг тоогоор бичнэ үү');
    const reason = window.prompt('Засах шалтгаан (засварын түүхэд бичигдэнэ):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/inventory/receipts/${r.id}/items/${i.id}/cost`, {
        method: 'PATCH',
        body: JSON.stringify({ unitCostMnt: cost, reason: reason.trim() }),
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
    const bad = lines.find((l) => !(lineQty(l) > 0) || Math.abs(Math.round(lineQty(l) * 1000) - lineQty(l) * 1000) > 1e-6);
    if (bad) {
      return setFormError(`${bad.nameMn}: ирсэн тоог зөв бичнэ үү (0-ээс их, таслалаас хойш 3 орон хүртэл, жишээ: 1200 эсвэл 2,5; мянгатын таслал бичихгүй)`);
    }
    const badCost = lines.find((l) => {
      const c = lineCost(l);
      return c !== null && !Number.isFinite(c);
    });
    if (badCost) return setFormError(`${badCost.nameMn}: нэгж өртгийг тоогоор бичнэ үү`);
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
          items: lines.map((l) => {
            const cost = lineCost(l);
            return { productId: l.productId, quantity: lineQty(l), ...(cost !== null ? { unitCostMnt: cost } : {}) };
          }),
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
  const setLine = (idx: number, patch: Partial<Line>) => setLines((prev) => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  /** The quantity box of a receipt line (the same on a phone card and in the table). */
  const qtyInput = (l: Line, idx: number, cls: string) => {
    const n = lineQty(l);
    const wrong = l.quantity.trim() !== '' && !(n > 0);
    return (
      <input
        className={`${cls} text-right ${wrong ? 'border-red-500' : ''}`}
        inputMode="decimal"
        autoComplete="off"
        aria-label={`${l.nameMn}: ирсэн тоо`}
        value={l.quantity}
        onChange={(e) => setLine(idx, { quantity: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            searchRef.current?.focus();
          }
        }}
      />
    );
  };

  /** The unit cost box, with the warning and the "previous cost" shortcut under it. */
  const costInput = (l: Line, idx: number, cls: string) => {
    const cost = lineCost(l) ?? 0;
    const warn = cost > 0 && l.priceMnt > 0 && cost >= l.priceMnt;
    return (
      <>
        <input
          className={`${cls} text-right ${warn ? 'border-red-500' : ''}`}
          inputMode="numeric"
          autoComplete="off"
          aria-label={`${l.nameMn}: нэгж өртөг`}
          disabled={!canCost}
          placeholder={canCost ? (l.lastCostMnt != null ? `өмнө ${l.lastCostMnt}` : '') : 'эрхгүй'}
          value={l.unitCost}
          onChange={(e) => setLine(idx, { unitCost: e.target.value })}
        />
        {warn && <span className="block text-[11px] text-red-300">зарах үнээс их/тэнцүү</span>}
        {canCost && l.lastCostMnt != null && !l.unitCost && (
          <button
            type="button"
            className="block py-1 text-left text-[11px] text-amber-brand hover:underline"
            onClick={() => setLine(idx, { unitCost: String(l.lastCostMnt) })}
          >
            өмнөх өртөг {tugrik(l.lastCostMnt)}
          </button>
        )}
      </>
    );
  };

  const lineSum = (l: Line) => {
    const c = lineCost(l);
    const n = lineQty(l);
    return c !== null && Number.isFinite(c) && n > 0 ? tugrik(c * n) : '—';
  };

  const removeLineButton = (idx: number) => (
    <button
      type="button"
      className="btn-ghost h-9 w-9 shrink-0 p-0 text-xs"
      aria-label="Мөрийг хасах"
      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
    >
      ✕
    </button>
  );

  /** Supplier column of the receipts list (table and phone card). */
  const supplierInfo = (r: StockReceipt) => (
    <>
      {r.supplierName}
      {r.supplierCustomer && <span className="block text-[11px] text-sky-300">харилцагчийн тооцоонд орсон</span>}
      {canCost && features.enabled('PARTNER_ACCOUNTS') && (
        <button
          className="block py-1 text-left text-[11px] text-amber-300 hover:underline"
          onClick={() => setAttach({ receipt: r, partner: null, reason: '', busy: false })}
        >
          {r.supplierCustomer ? 'харилцагч солих / салгах' : 'харилцагчийн тооцоонд оруулах'}
        </button>
      )}
      {r.supplierInvoiceNo && <span className="block text-xs text-slate-400">№ {r.supplierInvoiceNo}</span>}
      {r.notes && <span className="block text-xs text-slate-500">{r.notes}</span>}
    </>
  );

  const itemList = (r: StockReceipt) => (
    <ul className="space-y-0.5">
      {r.items.map((i) => (
        <li key={i.id}>
          {i.product.nameMn} · <b>{qty(i.quantity)}</b> {unitLabel(i.product.unit)}
          {i.unitCostMnt != null && <span className="text-slate-400"> × {tugrik(i.unitCostMnt)}</span>}
          {canCost && (
            <button className="ml-2 py-1 text-[11px] text-amber-300 hover:underline" onClick={() => void editCost(r, i)}>
              өртөг засах
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  const costSummary = (r: StockReceipt) => {
    const costed = r.items.filter((i) => i.unitCostMnt != null);
    const sum = costed.reduce((s, i) => s + Number(i.quantity) * (i.unitCostMnt ?? 0), 0);
    return (
      <>
        {costed.length ? tugrik(sum) : '—'}
        {costed.length > 0 && costed.length < r.items.length && <span className="block text-[11px] text-slate-500">хэсэгчлэн</span>}
      </>
    );
  };

  const unitChoices = unitOptions(unitList, newProduct.unit);
  const categoryChoices = categoryOptions(categoryList, newProduct.category);

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
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
          <label className="block flex-1 text-xs text-slate-400 sm:flex-none">
            Хэзээнээс
            <input type="date" className="mt-1 block w-full sm:w-auto" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </label>
          {canReceive &&
            (isOversight || lockedTo ? (
              <button className="btn-primary" onClick={openCreate}>
                + Орлого авах
              </button>
            ) : (
              <p className="w-full text-xs text-slate-400 sm:max-w-[220px]">Орлого авахын тулд танд агуулах оноогдсон байх ёстой.</p>
            ))}
        </div>
      </div>

      {/* Phones: one card per receipt. */}
      <div className="space-y-2 md:hidden">
        {shown.map((r) => (
          <article key={r.id} className="card space-y-2 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-xs">{r.receiptNumber}</p>
                <p className="text-xs text-slate-400">
                  {new Date(r.receivedAt).toLocaleString('mn-MN')}
                  {r.receivedBy?.fullName ? ` · ${r.receivedBy.fullName}` : ''}
                </p>
              </div>
              <a className="btn-ghost shrink-0 px-3 text-xs" href={`/print/receipts/${r.id}`} target="_blank" rel="noreferrer">
                🖨 Хэвлэх
              </a>
            </div>
            <p className="text-xs text-slate-400">
              Агуулах: <span className="text-slate-200">{r.warehouse.name}</span>
            </p>
            <div className="text-xs text-slate-400">
              Нийлүүлэгч: <span className="text-slate-200">{supplierInfo(r)}</span>
            </div>
            {itemList(r)}
            <div className="flex justify-between border-t border-slate-800 pt-2">
              <span className="text-xs text-slate-400">Өртгийн дүн</span>
              <span className="text-right font-semibold">{costSummary(r)}</span>
            </div>
          </article>
        ))}
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
        {!loading && shown.length === 0 && <p className="p-3 text-slate-500">Энэ хугацаанд орлого алга. «+ Орлого авах» дарж эхэлнэ.</p>}
      </div>

      <div className="card hidden overflow-auto p-0 md:block">
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
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-slate-800 align-top">
                <td className="p-3 font-mono text-xs">{r.receiptNumber}</td>
                <td className="py-3 text-xs text-slate-300">
                  {new Date(r.receivedAt).toLocaleString('mn-MN')}
                  <br />
                  {r.receivedBy?.fullName}
                </td>
                <td className="py-3">{r.warehouse.name}</td>
                <td className="py-3">{supplierInfo(r)}</td>
                <td className="py-3">{itemList(r)}</td>
                <td className="py-3 text-right">{costSummary(r)}</td>
                <td className="py-3 pr-3 text-right">
                  <a className="btn-ghost px-2 py-1 text-xs" href={`/print/receipts/${r.id}`} target="_blank" rel="noreferrer">
                    🖨 Хэвлэх
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
        {!loading && shown.length === 0 && <p className="p-3 text-slate-500">Энэ хугацаанд орлого алга. «+ Орлого авах» дарж эхэлнэ.</p>}
      </div>

      {attach && (
        <Modal
          title={`${attach.receipt.receiptNumber}: нийлүүлэгч харилцагч`}
          busy={attach.busy}
          onClose={() => setAttach(null)}
          footer={
            <>
              <button type="button" className="btn-ghost" onClick={() => setAttach(null)} disabled={attach.busy}>
                Болих
              </button>
              <button
                className="btn-primary"
                type="submit"
                form="attach-form"
                disabled={attach.busy || (!attach.partner && !attach.receipt.supplierCustomer)}
              >
                {attach.partner ? 'Тооцоонд оруулах' : 'Тооцооноос гаргах'}
              </button>
            </>
          }
        >
          <form id="attach-form" onSubmit={saveAttach} className="space-y-3">
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
          </form>
        </Modal>
      )}

      {open && (
        <Modal
          title="Бараа орлого авах"
          size="xl"
          busy={saving}
          onClose={() => setOpen(false)}
          dirty={lines.length > 0}
          footer={
            <>
              {formError ? (
                <p className="mr-auto w-full text-sm text-red-400 sm:w-auto sm:self-center">{formError}</p>
              ) : (
                <span className="mr-auto hidden self-center text-xs text-slate-500 sm:inline">Хадгалсны дараа орлогын баримт хэвлэх цонх нээгдэнэ.</span>
              )}
              <button type="button" className="btn-ghost" onClick={close} disabled={saving}>
                Болих
              </button>
              <button className="btn-primary" type="submit" form="receipt-form" disabled={saving || !lines.length}>
                {saving ? 'Хадгалж байна…' : `Орлогод авах (${lines.length})`}
              </button>
            </>
          }
        >
          <form id="receipt-form" onSubmit={submit} className="space-y-4">

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
                type="search"
                enterKeyHint="search"
                autoComplete="off"
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
                      <button
                        type="button"
                        className="flex min-h-[40px] w-full flex-wrap items-center justify-between gap-x-2 px-3 py-1.5 text-left text-sm hover:bg-steel-800"
                        onClick={() => addLine(p)}
                      >
                        <span>
                          {p.nameMn} <span className="font-mono text-[11px] text-slate-500">{p.sku}</span>
                        </span>
                        <span className="text-xs text-slate-400">
                          үлдэгдэл {qty(p.stockQty)} {unitLabel(p.unit)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {unknown && (
              <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm">
                <p className="text-amber-200">
                  «<span className="break-all font-mono">{unknown}</span>» бүртгэлгүй бараа.
                  {!canAddProduct && ' Бараа бүртгэх эрхтэй ажилтнаар (админ, ерөнхий менежер) бүртгүүлнэ үү.'}
                </p>
                {canAddProduct && (
                  <div className="mt-2 space-y-2 text-xs text-slate-400">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="col-span-2">
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
                        <select className="mt-1 w-full" value={newProduct.category} onChange={(e) => void pickCategory(e.target.value)}>
                          {!newProduct.category && <option value="">— сонгох —</option>}
                          {categoryChoices.map((c) => (
                            <option key={c} value={c}>
                              {categoryLabel(c)}
                            </option>
                          ))}
                          <option value={NEW_CATEGORY}>+ Шинэ ангилал…</option>
                        </select>
                      </label>
                      <label>
                        Хэмжих нэгж
                        <select className="mt-1 w-full" value={newProduct.unit} onChange={(e) => void pickUnit(e.target.value)}>
                          {unitChoices.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                          <option value={NEW_UNIT}>+ Шинэ нэгж…</option>
                        </select>
                      </label>
                      <label>
                        Зарах үнэ ₮
                        <input
                          className="mt-1 w-full"
                          inputMode="numeric"
                          autoComplete="off"
                          value={newProduct.priceMnt}
                          onChange={(e) => setNewProduct({ ...newProduct, priceMnt: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <label>
                        Жин (кг)
                        <input
                          className="mt-1 w-full"
                          inputMode="decimal"
                          autoComplete="off"
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
                            inputMode="decimal"
                            autoComplete="off"
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
                          inputMode="decimal"
                          autoComplete="off"
                          value={newProduct.volumeM3}
                          onChange={(e) => setNewProduct({ ...newProduct, volumeM3: e.target.value })}
                          onKeyDown={createOnEnter}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn-primary col-span-2 self-end text-sm sm:col-span-1"
                        disabled={creatingProduct}
                        onClick={() => void createProduct()}
                      >
                        {creatingProduct ? 'Бүртгэж байна…' : 'Бүртгээд нэмэх'}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Урт, өргөн, өндрийг бөглөхөд эзлэхүүн автоматаар бодогдоно. Нэгж жагсаалтад байхгүй бол «+ Шинэ нэгж»-ийг сонгоно.
                    </p>
                  </div>
                )}
              </div>
            )}

            {lines.length > 0 && (
              <>
                {/* Phones: a card per product — the name, then the quantity and the cost side by side. */}
                <div className="space-y-2 md:hidden">
                  {lines.map((l, idx) => (
                    <div key={l.productId} className="rounded-lg border border-slate-800 p-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium leading-snug">{l.nameMn}</p>
                          <p className="font-mono text-[11px] text-slate-500">
                            {l.sku} · зарах {tugrik(l.priceMnt)} · одоо {qty(l.stockQty)} {unitLabel(l.unit)}
                          </p>
                        </div>
                        {removeLineButton(idx)}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="block text-xs text-slate-400">
                          Ирсэн тоо ({unitLabel(l.unit)})
                          <span className="mt-1 block">{qtyInput(l, idx, 'w-full')}</span>
                        </label>
                        <label className="block text-xs text-slate-400">
                          Нэгж өртөг ₮
                          <span className="mt-1 block">{costInput(l, idx, 'w-full')}</span>
                        </label>
                      </div>
                      <p className="mt-1 text-right text-xs text-slate-400">Дүн: {lineSum(l)}</p>
                    </div>
                  ))}
                  <div className="flex flex-wrap justify-between gap-2 border-t border-slate-700 pt-2 text-sm">
                    <span className="font-semibold">
                      {lines.length} төрөл · {qty(units)}
                    </span>
                    <span className="font-bold">{total > 0 ? tugrik(total) : '—'}</span>
                  </div>
                </div>

                <div className="table-scroll hidden md:block">
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
                      {lines.map((l, idx) => (
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
                          <td className="whitespace-nowrap">
                            {qtyInput(l, idx, 'w-24')} <span className="text-xs text-slate-400">{unitLabel(l.unit)}</span>
                          </td>
                          <td>{costInput(l, idx, 'w-28')}</td>
                          <td className="text-right text-slate-300">{lineSum(l)}</td>
                          <td className="text-right">{removeLineButton(idx)}</td>
                        </tr>
                      ))}
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
                </div>
              </>
            )}

            <label className="block text-xs text-slate-400">
              Тэмдэглэл
              <input className="mt-1 w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ж: машин 1234 УБА, гэмтэлтэй 2 ш буцаасан" />
            </label>
          </form>
        </Modal>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 left-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg sm:left-auto ${
            toast.kind === 'error' ? 'border-red-700 bg-red-950 text-red-100' : 'border-emerald-700 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}
