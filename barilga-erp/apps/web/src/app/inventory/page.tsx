'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/modal';
import { ProductImage } from '@/components/product-image';
import { Shell } from '@/components/shell';
import { api, apiUpload, tugrik } from '@/lib/api';
import {
  AuthUser,
  Product,
  StockMovement,
  StockReport,
  StockStatus,
  productMatchesQuery,
  productStockStatus,
} from '@/lib/types';
import {
  NEW_CATEGORY,
  NEW_UNIT,
  UNIT_MAX_LENGTH,
  categoryLabel,
  isNoCategory,
  categoryOptions,
  missingInfo,
  parseDecimal,
  unitLabel,
  unitOptions,
  useCategories,
  useUnits,
  withVolume,
} from '@/lib/catalog';
import { can, savedUser, useCan } from '@/lib/permissions';
import { OVERSIGHT_ROLES, hasRole } from '@/lib/rbac';

const STATUS_LABEL: Record<StockStatus, string> = {
  IN_STOCK: 'Байгаа',
  LOW_STOCK: 'Дуусч буй',
  OUT_OF_STOCK: 'Дууссан',
  NEGATIVE_STOCK: 'Илүү зарагдсан',
};

const MOVEMENT_LABEL: Record<string, string> = {
  OPENING: 'Эхний үлдэгдэл',
  SALE: 'Борлуулалт',
  RETURN: 'Буцаалт',
  RECEIPT: 'Орлого',
  TRANSFER_OUT: 'Шилжүүлэг (гарсан)',
  TRANSFER_IN: 'Шилжүүлэг (орсон)',
  ADJUSTMENT: 'Тохируулга',
  RECONCILE: 'Нийлүүлэгчээр тохируулсан',
};

/** INCOMPLETE: products still missing a category, weight, length or volume. */
type StockFilter = 'ALL' | 'NEGATIVE_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'INCOMPLETE';

/** The printed price list takes at most this many hand-picked products (same limit as the API). */
const MAX_SHEET_PRODUCTS = 200;

/** A saved size or weight for the form: empty when not registered (0). */
const dim = (v?: number | string | null) => (Number(v) > 0 ? String(Number(v)) : '');

/** One "goes with it" line in the form; `productId` is set when it was picked from the catalog. */
type CompanionDraft = { name: string; qtyPerUnit: string; unit: string; productId?: string };

const emptyForm = {
  barcode: '',
  sku: '',
  nameMn: '',
  nameEn: '',
  unit: 'ш',
  category: '',
  priceMnt: 0,
  // Sizes are typed as text so an empty box stays empty (width / height are optional) and "0,5" works.
  weightKg: '',
  lengthM: '',
  widthM: '',
  heightM: '',
  volumeM3: '',
  stockQty: 0,
  minStockLevel: 0,
  imageUrl: '',
  description: '',
  active: true,
  companions: [] as CompanionDraft[],
};

type Toast = { kind: 'error' | 'ok'; text: string };

/** Why a companion's "per unit" quantity cannot be saved (null when it is fine or the line is empty). */
function companionQtyError(c: CompanionDraft): string | null {
  if (!c.name.trim() && !c.productId) return null;
  if (!c.qtyPerUnit.trim()) return '1 нэгжид ногдох тоог бичнэ үү';
  const n = parseDecimal(c.qtyPerUnit);
  if (!Number.isFinite(n) || n <= 0) return 'Тоог зөв бичнэ үү (жишээ: 1, 2 эсвэл 0,5; «1,250» гэж мянгатын таслал бичихгүй)';
  if (n > 1000) return '1000-аас ихгүй тоо бичнэ үү';
  if (Math.abs(Math.round(n * 1000) - n * 1000) > 1e-6) return 'Таслалаас хойш 3 орон хүртэл (жишээ: 0,125)';
  return null;
}

/** A size typed in the form: null when empty, NaN when it is not a number. */
const sizeValue = (v: string) => (v.trim() ? parseDecimal(v) : null);

function Badge({ status }: { status: StockStatus }) {
  const cls =
    status === 'NEGATIVE_STOCK'
      ? 'bg-rose-950 text-rose-100 border-rose-500'
      : status === 'OUT_OF_STOCK'
        ? 'bg-red-900/70 text-red-200 border-red-700'
        : status === 'LOW_STOCK'
          ? 'bg-amber-900/70 text-amber-200 border-amber-600'
          : 'bg-emerald-900/70 text-emerald-200 border-emerald-700';
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        active ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200' : 'border-slate-600 text-slate-400'
      }`}
    >
      {active ? 'Идэвхтэй' : 'Идэвхгүй'}
    </span>
  );
}

/** "Дутуу: жин, урт" under a product whose registration is not complete; a link to the form for those who can fix it. */
function MissingNote({ missing, onFix }: { missing: string[]; onFix?: () => void }) {
  if (!missing.length) return null;
  const text = `Дутуу: ${missing.join(', ')}`;
  return onFix ? (
    <button type="button" className="mt-0.5 block py-1 text-left text-[11px] text-amber-300 hover:underline" onClick={onFix}>
      {text} — засах
    </button>
  ) : (
    <p className="mt-0.5 text-[11px] text-amber-300">{text}</p>
  );
}

/** A checkbox that can also show "some are chosen" (the dash), for "select all visible". */
function SelectAllBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !all;
  }, [all, some]);
  return <input ref={ref} type="checkbox" className="h-5 w-5 cursor-pointer" checked={all} onChange={onChange} aria-label={label} />;
}

export default function InventoryPage() {
  const [report, setReport] = useState<StockReport | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<StockFilter>('ALL');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  /** Products chosen for printing labels or a price list. */
  const [picked, setPicked] = useState<string[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [adjustForm, setAdjustForm] = useState({ warehouseId: '', counted: '', reason: '' });
  const [ledger, setLedger] = useState<{ product: Product; rows: StockMovement[] } | null>(null);
  const [openingWarehouse, setOpeningWarehouse] = useState('');
  /** The companion line whose product suggestions are open. */
  const [companionFocus, setCompanionFocus] = useState<number | null>(null);
  /** The form as it was opened, so closing it by accident asks before throwing typed changes away. */
  const openedForm = useRef(emptyForm);

  const canDo = useCan();
  const { units, addNew: addNewUnit } = useUnits();
  const { categories: categoryList, addNew: addNewCategory } = useCategories();
  const canManage = hasRole(user?.role, OVERSIGHT_ROLES);
  // The catalog and prices are shared by every shop: admin and the general manager by default, or whoever the admin allows.
  const canEditCatalog = canDo('PRODUCT_WRITE');
  const canAdjust = canDo('STOCK_ADJUST');
  const showActions = canManage || canEditCatalog || canAdjust;
  const warehouses = report?.warehouses ?? [];
  const severalWarehouses = warehouses.length > 1;
  // Staff assigned to a warehouse only ever see that one (the server enforces it too).
  const canPickWarehouse = severalWarehouses && (canManage || !user?.warehouseId);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await api<StockReport>(`/inventory/stock${warehouseId ? `?warehouseId=${warehouseId}` : ''}`));
      if (can(savedUser(), 'PRODUCT_WRITE')) {
        setCatalog(await api<Product[]>('/products/all'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Үлдэгдэл ачаалж чадсангүй';
      setError(message);
      flash('error', message);
    } finally {
      setLoading(false);
    }
  }, [flash, warehouseId]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (raw) setUser(JSON.parse(raw) as AuthUser);
    void load();
  }, [load]);

  function openAdjust(row: Product) {
    setAdjusting(row);
    setError('');
    setAdjustForm({
      warehouseId: warehouseId || warehouses.find((w) => w.isDefault)?.id || warehouses[0]?.id || '',
      counted: '',
      reason: '',
    });
  }

  async function submitAdjust(e: FormEvent) {
    e.preventDefault();
    if (!adjusting) return;
    const counted = parseDecimal(adjustForm.counted);
    if (!Number.isFinite(counted) || counted < 0 || Math.abs(Math.round(counted * 1000) - counted * 1000) > 1e-6) {
      return setError('Тоолсон тоог зөв бичнэ үү (0 эсвэл түүнээс их, таслалаас хойш 3 орон хүртэл; мянгатын таслал бичихгүй — 1200)');
    }
    setSaving(true);
    setError('');
    try {
      await api('/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: adjustForm.warehouseId,
          productId: adjusting.id,
          countedQuantity: counted,
          reason: adjustForm.reason.trim(),
        }),
      });
      setAdjusting(null);
      flash('ok', 'Үлдэгдэл тохируулагдлаа');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Тохируулж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  async function openLedger(row: Product) {
    try {
      const rows = await api<StockMovement[]>(
        `/inventory/movements?productId=${row.id}${warehouseId ? `&warehouseId=${warehouseId}` : ''}&limit=60`,
      );
      setLedger({ product: row, rows });
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Түүх ачаалж чадсангүй');
    }
  }

  function openCreate() {
    setEditing(null);
    setError('');
    setForm(emptyForm);
    openedForm.current = emptyForm;
    setFile(null);
    setModal('create');
  }

  function openEdit(row: Product) {
    setEditing(row);
    setError('');
    const next = {
      sku: row.sku,
      barcode: row.barcode ?? '',
      nameMn: row.nameMn,
      nameEn: row.nameEn,
      unit: unitLabel(row.unit),
      // "General" is not a real choice: the box starts empty so a category has to be picked.
      // The stored name (an old English key stays as it is; the list shows it in Mongolian).
      category: row.category && !isNoCategory(row.category) ? row.category : '',
      priceMnt: Number(row.priceMnt),
      weightKg: dim(row.weightKg),
      lengthM: dim(row.lengthM),
      widthM: dim(row.widthM),
      heightM: dim(row.heightM),
      volumeM3: dim(row.volumeM3),
      stockQty: Number(row.stockQty),
      minStockLevel: Number(row.minStockLevel ?? 0),
      imageUrl: row.imageUrl ?? '',
      description: row.description ?? '',
      active: row.active !== false,
      companions: (row.companions ?? []).map((c) => ({
        name: c.name,
        qtyPerUnit: String(c.qtyPerUnit),
        unit: unitLabel(c.unit),
        ...(c.productId ? { productId: c.productId } : {}),
      })),
    };
    setForm(next);
    openedForm.current = next;
    setFile(null);
    setModal('edit');
  }

  /** Tap outside / Esc / Болих: asks first when something was typed. */
  function closeForm() {
    const changed = Boolean(file) || JSON.stringify(form) !== JSON.stringify(openedForm.current);
    if (changed && !window.confirm('Хадгалаагүй өөрчлөлт алга болно. Хаах уу?')) return;
    setModal(null);
  }

  /** The unit <select>: a saved unit, or «+ Шинэ нэгж» which asks for the name, saves it and selects it. */
  async function pickUnit(value: string) {
    if (value !== NEW_UNIT) return setForm((f) => ({ ...f, unit: value }));
    try {
      const unit = await addNewUnit();
      if (unit) {
        setForm((f) => ({ ...f, unit }));
        flash('ok', `«${unit}» нэгж нэмэгдлээ`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Нэгж нэмж чадсангүй');
    }
  }

  /**
   * The category <select>: a listed category, or «+ Шинэ ангилал» which asks for the name and selects it (added to
   * the shop's list when this person may change the catalog, otherwise used for this product only).
   */
  async function pickCategory(value: string) {
    if (value !== NEW_CATEGORY) return setForm((f) => ({ ...f, category: value }));
    try {
      const name = await addNewCategory(canEditCatalog);
      if (name) {
        setForm((f) => ({ ...f, category: name }));
        // The list as it was before this pick: a name already there is only selected.
        const existed = categoryList.some((c) => c.toLowerCase() === name.toLowerCase());
        if (canEditCatalog) flash('ok', existed ? `«${name}» ангилал жагсаалтад байсан — сонгогдлоо` : `«${name}» ангилал жагсаалтад нэмэгдлээ`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ангилал нэмж чадсангүй');
    }
  }

  const setCompanion = (idx: number, patch: Partial<CompanionDraft>) =>
    setForm((f) => ({ ...f, companions: f.companions.map((c, j) => (j === idx ? { ...c, ...patch } : c)) }));

  /** A product picked from the suggestions: its name and unit are filled in and it is linked by id. */
  function pickCompanion(idx: number, p: Product) {
    setCompanion(idx, { name: p.nameMn, unit: unitLabel(p.unit) || 'ш', productId: p.id });
    setCompanionFocus(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const categoryValue = form.category.trim();
    if (!categoryValue || isNoCategory(categoryValue)) return setError('Ангиллаа сонгоно уу');
    const weightKg = parseDecimal(form.weightKg);
    if (!(weightKg > 0) || weightKg > 100000) return setError('Жинг кг-аар оруулна уу (0-ээс их, жишээ: 0,5 эсвэл 1250 — мянгатын таслал бичихгүй)');
    const [lengthM, widthM, heightM] = [form.lengthM, form.widthM, form.heightM].map(sizeValue);
    if ([lengthM, widthM, heightM].some((v) => v !== null && (!Number.isFinite(v) || v < 0 || v > 100))) {
      return setError('Урт, өргөн, өндрийг метрээр 0–100 хооронд бичнэ үү (жишээ: 0,25 эсвэл 1.25; «1,250» гэж бичихгүй)');
    }
    const volumeM3 = sizeValue(form.volumeM3);
    if (volumeM3 !== null && (!Number.isFinite(volumeM3) || volumeM3 < 0 || volumeM3 > 1000)) {
      return setError('Эзлэхүүнийг м³-ээр 0–1000 хооронд бичнэ үү');
    }
    // A line without a name (and not picked from the catalog) is an unused empty row.
    const companionRows = form.companions.filter((c) => c.name.trim() || c.productId);
    for (const c of companionRows) {
      const problem = companionQtyError(c);
      if (problem) return setError(`Дагалдах бараа «${c.name.trim()}»: ${problem}`);
      if (editing && c.productId === editing.id) return setError('Бараа өөрийгөө дагалдах бараа болгохгүй');
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        priceMnt: Number(form.priceMnt),
        weightKg,
        lengthM: lengthM ?? 0,
        widthM,
        heightM,
        volumeM3: volumeM3 ?? 0,
        stockQty: Number(form.stockQty),
        minStockLevel: Number(form.minStockLevel),
        imageUrl: form.imageUrl || null,
        description: form.description.trim() || null,
        category: categoryValue,
        companions: companionRows.map((c) => ({
          ...(c.productId ? { productId: c.productId } : {}),
          name: c.name.trim(),
          qtyPerUnit: Math.round(parseDecimal(c.qtyPerUnit) * 1000) / 1000,
          unit: c.unit.trim() || 'ш',
        })),
      };
      let product: Product;
      if (modal === 'create') {
        product = await api<Product>('/products', {
          method: 'POST',
          body: JSON.stringify({ ...payload, warehouseId: openingWarehouse || undefined }),
        });
      } else if (editing) {
        // With several warehouses the quantity is changed per warehouse ("Тохируулах"), never from this form.
        const { stockQty: _ignored, ...withoutStock } = payload;
        product = await api<Product>(`/products/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(severalWarehouses ? withoutStock : payload),
        });
      } else {
        return;
      }
      if (file) {
        await apiUpload(`/products/${product.id}/image`, file);
      }
      setModal(null);
      flash('ok', modal === 'create' ? 'Бараа нэмэгдлээ' : 'Бараа шинэчлэгдлээ');
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Хадгалж чадсангүй';
      setError(message);
      flash('error', message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await api(`/products/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      flash('ok', `${deleting.sku} идэвхгүй боллоо`);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Идэвхгүй болгож чадсангүй';
      flash('error', message);
    } finally {
      setSaving(false);
    }
  }

  const lowItems = report?.items.filter((i) => i.lowStock && i.status !== 'NEGATIVE_STOCK') ?? [];
  type Row = Product & { stockStatus: StockStatus; warehouses?: NonNullable<StockReport['items'][number]['warehouses']> };
  const reportById = new Map((report?.items ?? []).map((i) => [i.id, i]));
  const allRows: Row[] = canEditCatalog
    ? catalog.map((p) => {
        // The quantity shown is the selected warehouse, or the total, exactly as the server reports it.
        const stock = reportById.get(p.id);
        const withQty = { ...p, stockQty: stock?.stockQty ?? Number(p.stockQty) };
        return { ...withQty, stockStatus: productStockStatus(withQty), warehouses: stock?.warehouses };
      })
    : (report?.items ?? []).map((p) => ({
        ...p,
        priceMnt: p.priceMnt ?? 0,
        weightKg: p.weightKg ?? 0,
        lengthM: p.lengthM ?? 0,
        volumeM3: p.volumeM3 ?? 0,
        category: p.category ?? 'General',
        stockStatus: p.status,
      }));
  const incompleteCount = allRows.filter((row) => missingInfo(row).length > 0).length;
  const rows = allRows
    .filter((row) =>
      filter === 'ALL' ? true : filter === 'INCOMPLETE' ? missingInfo(row).length > 0 : row.stockStatus === filter,
    )
    .filter((row) => productMatchesQuery(row, query) && (!category || (row.category ?? 'General') === category));
  const categories = [...new Set(allRows.map((r) => r.category ?? 'General'))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  const missingBarcodes = catalog.filter((p) => !p.barcode).length;

  // Selection: chosen products stay chosen when the filter changes; "all visible" works on what is shown.
  const pickedSet = new Set(picked);
  const visiblePicked = rows.filter((r) => pickedSet.has(r.id)).length;
  const allVisiblePicked = rows.length > 0 && visiblePicked === rows.length;
  const toggleOne = (id: string, on: boolean) => setPicked((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  function toggleAllVisible() {
    const visible = rows.map((r) => r.id);
    if (allVisiblePicked) {
      const hide = new Set(visible);
      setPicked((prev) => prev.filter((id) => !hide.has(id)));
    } else {
      setPicked((prev) => [...prev, ...visible.filter((id) => !prev.includes(id))]);
    }
  }
  /** Only the category box narrows the list: the price list can be printed for that category as a whole. */
  const onlyCategory = Boolean(category) && filter === 'ALL' && !query.trim();
  const categoryHref = `/print/price-list?id=retail&cat=${encodeURIComponent(category)}`;
  const pickedIsCategory = onlyCategory && allVisiblePicked && picked.length === rows.length;
  const pickedPriceHref = pickedIsCategory ? categoryHref : `/print/price-list?id=retail&ids=${picked.join(',')}`;
  const tooManyForPrice = !pickedIsCategory && picked.length > MAX_SHEET_PRODUCTS;

  async function fillBarcodes() {
    try {
      const r = await api<{ assigned: number }>('/products/barcodes/fill', { method: 'POST', body: '{}' });
      flash('ok', `${r.assigned} бараанд баркод олголоо`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Баркод олгож чадсангүй');
    }
  }
  const negativeCount =
    report?.summary.negativeStock ?? allRows.filter((r) => r.stockStatus === 'NEGATIVE_STOCK').length;

  /** Buttons for one product, the same in the table and on the phone card. */
  const actions = (row: Row, small: boolean) => {
    const cls = small ? 'text-xs px-3 py-1' : 'text-sm px-3';
    return (
      <>
        {canEditCatalog && (
          <button className={`btn-ghost ${cls}`} onClick={() => openEdit(row)}>
            Засах
          </button>
        )}
        {canAdjust && (
          <button className={`btn-ghost ${cls}`} onClick={() => openAdjust(row)}>
            Тохируулах
          </button>
        )}
        {canManage && (
          <button className={`btn-ghost ${cls}`} onClick={() => void openLedger(row)}>
            Түүх
          </button>
        )}
        {canEditCatalog && row.active !== false && (
          <button className={`btn-danger ${cls}`} onClick={() => setDeleting(row)}>
            Идэвхгүй болгох
          </button>
        )}
      </>
    );
  };

  const stockBreakdown = (row: Row) =>
    severalWarehouses && !report?.warehouseId && row.warehouses ? (
      <p className="mt-0.5 text-[11px] font-normal text-slate-500">{row.warehouses.map((w) => `${w.code}: ${w.quantity}`).join(' · ')}</p>
    ) : null;

  const unitChoices = unitOptions(units, form.unit);
  const categoryChoices = categoryOptions(categoryList, form.category);
  const companionSuggestions = (c: CompanionDraft, idx: number) =>
    companionFocus === idx && !c.productId && c.name.trim()
      ? catalog.filter((p) => p.id !== editing?.id && p.active !== false && productMatchesQuery(p, c.name)).slice(0, 8)
      : [];

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Үлдэгдэл</p>
          <h2 className="text-xl font-bold">Барааны удирдлага</h2>
          <p className="text-slate-400 text-sm mt-1">
            Бараа нэмэх, засах, идэвхгүй болгох. Агуулах захиалгыг олгоход үлдэгдэл хасагдана.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEditCatalog && (
            <button className="btn-primary" onClick={openCreate}>
              Бараа нэмэх
            </button>
          )}
          <a className="btn-ghost" href={onlyCategory ? categoryHref : '/print/price-list?id=retail'} target="_blank" rel="noreferrer">
            Үнийн жагсаалт хэвлэх{onlyCategory ? ` (${categoryLabel(category)})` : ''}
          </a>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      {error && !modal && !adjusting && <p className="text-red-400 mb-3">{error}</p>}

      {report && (
        <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <article className="card">
            <p className="text-xs text-slate-400 uppercase">Байгаа</p>
            <p className="text-2xl font-bold">{report.summary.inStock}</p>
          </article>
          <article className="card">
            <p className="text-xs text-slate-400 uppercase">Дуусч буй</p>
            <p className="text-2xl font-bold text-amber-300">{report.summary.lowStock}</p>
          </article>
          <article className="card">
            <p className="text-xs text-slate-400 uppercase">Дууссан</p>
            <p className="text-2xl font-bold text-red-300">{report.summary.outOfStock}</p>
          </article>
          <article className="card border-rose-800">
            <p className="text-xs text-rose-300 uppercase">Илүү зарагдсан</p>
            <p className="text-2xl font-bold text-rose-200">{negativeCount}</p>
          </article>
        </section>
      )}

      {severalWarehouses && (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          {canPickWarehouse ? (
            <label className="block w-full text-xs text-slate-400 sm:w-auto">
              Агуулах / дэлгүүр
              <select className="mt-1 block w-full sm:w-auto sm:min-w-[220px]" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Бүгд (нийт)</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-slate-300">
              Агуулах: <span className="font-semibold">{warehouses.find((w) => w.id === report?.warehouseId)?.name ?? '—'}</span>
            </p>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="block w-full text-xs text-slate-400 sm:w-auto sm:flex-1">
          Нэр, тайлбар, SKU, баркодоор хайх
          <input
            className="mt-1 w-full sm:max-w-md"
            type="search"
            value={query}
            autoComplete="off"
            placeholder="жишээ: суурь, цемент, CEM-42, 2000000000015"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="block w-full text-xs text-slate-400 sm:w-auto">
          Ангилал
          <select className="mt-1 block w-full sm:w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Бүгд</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <a className="btn-ghost text-sm" href="/print/labels" target="_blank" rel="noreferrer">
          Баркод хэвлэх
        </a>
        {canEditCatalog && missingBarcodes > 0 && (
          <button className="btn-ghost text-sm" onClick={() => void fillBarcodes()}>
            Баркодгүй {missingBarcodes} бараанд баркод олгох
          </button>
        )}
      </div>

      {/* One row that scrolls sideways on a phone instead of wrapping into several lines. */}
      <div className="-mx-3 mb-4 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {(
          [
            ['ALL', 'Бүгд'],
            ['NEGATIVE_STOCK', 'Хасах үлдэгдэл / илүү зарагдсан'],
            ['LOW_STOCK', 'Дуусч буй'],
            ['OUT_OF_STOCK', 'Дууссан'],
            ['INCOMPLETE', `Бүртгэл дутуу (${incompleteCount})`],
          ] as Array<[StockFilter, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`shrink-0 whitespace-nowrap text-xs px-3 py-1 ${filter === key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilter(key)}
          >
            {label}
            {key === 'NEGATIVE_STOCK' && negativeCount > 0 ? ` (${negativeCount})` : ''}
          </button>
        ))}
      </div>

      {filter === 'INCOMPLETE' && incompleteCount > 0 && (
        <div className="mb-4 rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          {incompleteCount} барааны ангилал, жин эсвэл хэмжээ (урт, эзлэхүүн) бүртгэгдээгүй.
          {canEditCatalog ? ' Бараа бүрийн «Дутуу» дээр дарж бөглөнө үү.' : ' Бараа бүртгэх эрхтэй ажилтнаар бөглүүлнэ үү.'}
        </div>
      )}

      {negativeCount > 0 && (
        <div className="mb-4 rounded-xl border border-rose-700 bg-rose-950/40 px-4 py-3 text-sm text-rose-100">
          {negativeCount} бараа үлдэгдлээсээ илүү зарагдсан. Үлдэгдлийг засахын тулд холбогдох захиалга дээр гадны нийлүүлэгч оноогоорой.
        </div>
      )}

      {lowItems.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          {lowItems.length} бараа доод үлдэгдэлд хүрсэн: {lowItems.map((i) => i.sku).join(', ')}
        </div>
      )}

      {rows.length > 0 && (
        <label className="mb-2 flex min-h-[40px] cursor-pointer items-center gap-2 text-sm text-slate-300">
          <SelectAllBox
            all={allVisiblePicked}
            some={visiblePicked > 0}
            onChange={toggleAllVisible}
            label="Харагдаж буй бүх барааг сонгох"
          />
          {allVisiblePicked ? `Харагдаж буй ${rows.length} барааг сонгосон` : `Харагдаж буй ${rows.length} барааг сонгох`}
          <span className="text-xs text-slate-500">— баркод эсвэл үнийн жагсаалт хэвлэхэд</span>
        </label>
      )}

      {/* Phones: one card per product. */}
      <div className="space-y-2 md:hidden">
        {rows.map((row) => {
          const on = pickedSet.has(row.id);
          return (
            <article
              key={row.id}
              className={`card p-3 ${row.active === false ? 'opacity-60' : ''} ${on ? 'border-amber-500/70' : ''}`}
            >
              <div className="flex gap-3">
                <label className="-ml-1 flex w-9 shrink-0 cursor-pointer justify-center pt-1">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={on}
                    onChange={(e) => toggleOne(row.id, e.target.checked)}
                    aria-label={`${row.nameMn} сонгох`}
                  />
                </label>
                <ProductImage src={row.imageUrl} alt={row.nameMn} className="h-16 w-16 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-snug">{row.nameMn}</p>
                  <p className="break-all font-mono text-[11px] text-slate-400">
                    {row.sku}
                    {row.barcode ? ` · ${row.barcode}` : ''}
                  </p>
                  <p className="text-xs text-slate-400">
                    {categoryLabel(row.category)} · {tugrik(Number(row.priceMnt ?? 0))}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className={`text-base font-semibold ${row.stockStatus === 'NEGATIVE_STOCK' ? 'text-rose-300' : ''}`}>
                      {Number(row.stockQty)} <span className="text-xs font-normal text-slate-400">{unitLabel(row.unit)}</span>
                    </span>
                    <Badge status={row.stockStatus} />
                    {row.active === false && <ActiveBadge active={false} />}
                  </div>
                  {stockBreakdown(row)}
                  <MissingNote missing={missingInfo(row)} onFix={canEditCatalog ? () => openEdit(row) : undefined} />
                </div>
              </div>
              {showActions && <div className="mt-2 flex flex-wrap gap-2">{actions(row, false)}</div>}
            </article>
          );
        })}
        {loading && <p className="p-3 text-slate-500">Бараа уншиж байна…</p>}
        {!loading && rows.length === 0 && <p className="p-3 text-slate-500">Бараа олдсонгүй.</p>}
      </div>

      <div className="card hidden overflow-auto p-0 md:block">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="w-10 p-3">
                {rows.length > 0 && (
                  <SelectAllBox
                    all={allVisiblePicked}
                    some={visiblePicked > 0}
                    onChange={toggleAllVisible}
                    label="Харагдаж буй бүх барааг сонгох"
                  />
                )}
              </th>
              <th className="w-16 py-3">Зураг</th>
              <th>SKU</th>
              <th>Барааны нэр</th>
              <th>Ангилал</th>
              <th className="text-right">Үнэ</th>
              <th className="text-right">Үлдэгдэл</th>
              <th>Төлөв</th>
              {showActions && <th className="pr-3 text-right">Үйлдэл</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t border-slate-800 ${row.active === false ? 'opacity-60' : ''} ${pickedSet.has(row.id) ? 'bg-amber-950/20' : ''}`}
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    className="h-5 w-5 cursor-pointer"
                    checked={pickedSet.has(row.id)}
                    onChange={(e) => toggleOne(row.id, e.target.checked)}
                    aria-label={`${row.nameMn} сонгох`}
                  />
                </td>
                <td className="py-3">
                  <ProductImage src={row.imageUrl} alt={row.nameMn} className="h-12 w-12 rounded-md" />
                </td>
                <td className="font-mono text-xs">
                  {row.sku}
                  {row.barcode && <span className="block text-[10px] text-slate-500">{row.barcode}</span>}
                </td>
                <td>
                  <p className="font-medium">{row.nameMn}</p>
                  <p className="text-xs text-slate-500">{row.nameEn}</p>
                  {row.description ? <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{row.description}</p> : null}
                  <MissingNote missing={missingInfo(row)} onFix={canEditCatalog ? () => openEdit(row) : undefined} />
                </td>
                <td>{categoryLabel(row.category)}</td>
                <td className="text-right">{tugrik(Number(row.priceMnt ?? 0))}</td>
                <td className={`text-right font-semibold ${row.stockStatus === 'NEGATIVE_STOCK' ? 'text-rose-300' : ''}`}>
                  {Number(row.stockQty)} <span className="text-xs font-normal text-slate-400">{unitLabel(row.unit)}</span>
                  {stockBreakdown(row)}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    <Badge status={row.stockStatus} />
                    <ActiveBadge active={row.active !== false} />
                  </div>
                </td>
                {showActions && (
                  <td className="pr-3">
                    <div className="flex flex-wrap justify-end gap-1">{actions(row, true)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Бараа уншиж байна…</p>}
        {!loading && rows.length === 0 && <p className="p-3 text-slate-500">Бараа олдсонгүй.</p>}
      </div>

      {picked.length > 0 && (
        <>
          {/* Room for the bar below, so it never covers the last product. */}
          <div className="h-28 md:h-20" aria-hidden />
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-amber-700/60 bg-steel-900/95 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur md:left-[240px] print:hidden">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-sm font-semibold text-amber-200">{picked.length} сонгосон:</span>
              {picked.length > MAX_SHEET_PRODUCTS ? (
                // The ids go in the link; more than this does not fit in one address.
                <button className="btn-ghost text-sm" disabled title="">
                  Баркод хэвлэх
                </button>
              ) : (
                <a className="btn-ghost text-sm" href={`/print/labels?ids=${picked.join(',')}`} target="_blank" rel="noreferrer">
                  Баркод хэвлэх
                </a>
              )}
              {tooManyForPrice ? (
                <button className="btn-ghost text-sm" disabled>
                  Үнийн жагсаалт хэвлэх
                </button>
              ) : (
                <a className="btn-ghost text-sm" href={pickedPriceHref} target="_blank" rel="noreferrer">
                  Үнийн жагсаалт хэвлэх{pickedIsCategory ? ` (${categoryLabel(category)})` : ''}
                </a>
              )}
              <button className="btn-ghost text-sm" onClick={() => setPicked([])}>
                Цуцлах
              </button>
              {(tooManyForPrice || picked.length > MAX_SHEET_PRODUCTS) && (
                <span className="w-full text-xs text-amber-300 sm:w-auto">
                  Нэг удаад {MAX_SHEET_PRODUCTS} хүртэл бараа сонгож хэвлэнэ (үнийн жагсаалтад ангиллаар шүүгээд бүгдийг сонгож болно).
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {modal && (
        <Modal
          title={modal === 'create' ? 'Бараа нэмэх' : 'Бараа засах'}
          size="lg"
          busy={saving}
          onClose={closeForm}
          guardTyping={false}
          footer={
            <>
              {error && <p className="mr-auto w-full text-sm text-red-400 sm:w-auto sm:self-center">{error}</p>}
              <button type="button" className="btn-ghost" onClick={closeForm} disabled={saving}>
                Болих
              </button>
              <button className="btn-primary" type="submit" form="product-form" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </>
          }
        >
          <form id="product-form" onSubmit={save} className="space-y-3">
            <div className="flex items-center gap-3">
              <ProductImage
                src={file ? URL.createObjectURL(file) : form.imageUrl}
                alt="Урьдчилан харах"
                className="h-20 w-20 shrink-0 rounded-lg"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <label className="block text-xs text-slate-400">
                  Зургийн холбоос (URL)
                  <input
                    className="mt-1 w-full"
                    type="url"
                    value={form.imageUrl}
                    onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                    placeholder="https://… эсвэл хоосон орхино"
                  />
                </label>
                <label className="block text-xs text-slate-400">
                  Зураг оруулах
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="mt-1 w-full text-sm"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-400">
                SKU
                <input className="mt-1 w-full" required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </label>
              <label className="text-xs text-slate-400">
                Ангилал
                <select className="mt-1 w-full" required value={form.category} onChange={(e) => void pickCategory(e.target.value)}>
                  {!form.category && <option value="">— сонгох —</option>}
                  {categoryChoices.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                  <option value={NEW_CATEGORY}>+ Шинэ ангилал…</option>
                </select>
                <span className="mt-1 block text-[11px] text-slate-500">Жагсаалтад байхгүй бол «+ Шинэ ангилал»-ыг сонгоно.</span>
              </label>
              <label className="text-xs text-slate-400 col-span-2">
                Баркод
                <input
                  className="mt-1 w-full font-mono"
                  value={form.barcode}
                  inputMode="numeric"
                  placeholder="Уншуулах эсвэл бичих. Хоосон бол автоматаар үүснэ (200…)"
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                />
              </label>
              <label className="text-xs text-slate-400">
                Хэмжих нэгж
                <select className="mt-1 w-full" required value={form.unit} onChange={(e) => void pickUnit(e.target.value)}>
                  {!form.unit && <option value="">— сонгох —</option>}
                  {unitChoices.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                  {canEditCatalog && <option value={NEW_UNIT}>+ Шинэ нэгж…</option>}
                </select>
                <span className="mt-1 block text-[11px] text-slate-500">Жагсаалтад байхгүй бол «+ Шинэ нэгж»-ийг сонгоно.</span>
              </label>
              <label className="text-xs text-slate-400">
                Үнэ ₮
                <input
                  type="number"
                  inputMode="numeric"
                  className="mt-1 w-full"
                  required
                  min={0}
                  value={form.priceMnt}
                  onChange={(e) => setForm({ ...form, priceMnt: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs text-slate-400 col-span-2">
                Нэр (монгол)
                <input className="mt-1 w-full" required value={form.nameMn} onChange={(e) => setForm({ ...form, nameMn: e.target.value })} />
              </label>
              <label className="text-xs text-slate-400 col-span-2">
                Нэр (англи)
                <input className="mt-1 w-full" required value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </label>
              <fieldset className="col-span-2 rounded border border-slate-700 p-2 text-xs text-slate-400">
                <legend className="px-1">Дагалдах бараа (жишээ: давирхайн будагт хатаагч)</legend>
                <p className="mb-2 text-[11px] text-slate-500">
                  Энэ барааны 1 нэгжийг зарах бүрт хамт олгох зүйл. Бараанаас хайж сонгох эсвэл нэрийг нь бичнэ. Тасалбар, бэлтгэх хуудас,
                  баримт дээр «+ Хатаагч × 2 ш» гэж гарна; үлдэгдлээс хасагдахгүй.
                </p>
                {form.companions.map((c, idx) => {
                  const hits = companionSuggestions(c, idx);
                  const qtyProblem = c.qtyPerUnit.trim() || c.name.trim() ? companionQtyError(c) : null;
                  return (
                    <div key={idx} className="mb-2 rounded border border-slate-800 p-2">
                      <div className="flex flex-wrap items-end gap-2 sm:flex-nowrap">
                        <div className="relative w-full sm:flex-1">
                          <label className="block">
                            Бараа эсвэл нэр
                            <input
                              className="mt-1 w-full"
                              placeholder="Хайх: нэр, код, баркод…"
                              autoComplete="off"
                              maxLength={80}
                              value={c.name}
                              onFocus={() => setCompanionFocus(idx)}
                              onBlur={() => window.setTimeout(() => setCompanionFocus((f) => (f === idx ? null : f)), 200)}
                              // Typing after a pick turns it back into a free-text name.
                              onChange={(e) => setCompanion(idx, { name: e.target.value, productId: undefined })}
                            />
                          </label>
                          {hits.length > 0 && (
                            <ul className="absolute z-20 mt-1 max-h-56 w-full divide-y divide-slate-800 overflow-auto rounded border border-slate-700 bg-steel-900">
                              {hits.map((p) => (
                                <li key={p.id}>
                                  <button
                                    type="button"
                                    className="flex min-h-[40px] w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-slate-100 hover:bg-steel-800"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => pickCompanion(idx, p)}
                                  >
                                    <span className="min-w-0">
                                      {p.nameMn} <span className="font-mono text-[11px] text-slate-500">{p.sku}</span>
                                    </span>
                                    <span className="shrink-0 text-xs text-slate-400">{unitLabel(p.unit)}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <label className="block min-w-0 flex-1 sm:w-24 sm:flex-none">
                          1 нэгжид
                          <input
                            className={`mt-1 w-full text-right ${qtyProblem ? 'border-red-500' : ''}`}
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="1"
                            value={c.qtyPerUnit}
                            onChange={(e) => setCompanion(idx, { qtyPerUnit: e.target.value })}
                          />
                        </label>
                        <label className="block w-20 shrink-0">
                          Нэгж
                          <input
                            className="mt-1 w-full"
                            placeholder="ш"
                            maxLength={UNIT_MAX_LENGTH}
                            value={c.unit}
                            onChange={(e) => setCompanion(idx, { unit: e.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn-ghost h-10 w-10 shrink-0 p-0"
                          aria-label="Энэ мөрийг хасах"
                          onClick={() => setForm((f) => ({ ...f, companions: f.companions.filter((_, j) => j !== idx) }))}
                        >
                          ✕
                        </button>
                      </div>
                      {c.productId && <p className="mt-1 text-[11px] text-sky-300">✓ Бараанаас сонгосон</p>}
                      {qtyProblem && <p className="mt-1 text-[11px] text-red-300">{qtyProblem}</p>}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setForm((f) => ({ ...f, companions: [...f.companions, { name: '', qtyPerUnit: '1', unit: 'ш' }] }))}
                >
                  + Дагалдах бараа нэмэх
                </button>
              </fieldset>
              <label className="text-xs text-slate-400 col-span-2">
                Тайлбар (заавал биш)
                <textarea
                  className="mt-1 w-full"
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Хайлтад ашиглагдах тэмдэглэл — хоосон орхиж болно"
                />
              </label>
              <label className="text-xs text-slate-400">
                {modal === 'create' && severalWarehouses ? 'Эхний үлдэгдэл' : 'Үлдэгдэл'}
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  className="mt-1 w-full"
                  value={form.stockQty}
                  disabled={modal === 'edit' && (severalWarehouses || !canAdjust)}
                  onChange={(e) => setForm({ ...form, stockQty: Number(e.target.value) })}
                />
                {modal === 'edit' && severalWarehouses && (
                  <span className="mt-1 block text-[11px] text-slate-500">Агуулах бүрийн үлдэгдлийг «Тохируулах» товчоор өөрчилнө.</span>
                )}
                {modal === 'edit' && !severalWarehouses && !canAdjust && (
                  <span className="mt-1 block text-[11px] text-slate-500">Үлдэгдлийг тооллогын эрхтэй хүн өөрчилнө.</span>
                )}
              </label>
              {modal === 'create' && severalWarehouses && (
                <label className="text-xs text-slate-400">
                  Эхний үлдэгдэл орох агуулах
                  <select className="mt-1 w-full" value={openingWarehouse} onChange={(e) => setOpeningWarehouse(e.target.value)}>
                    <option value="">Миний / анхдагч агуулах</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.code})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-xs text-slate-400">
                Доод үлдэгдэл
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  className="mt-1 w-full"
                  value={form.minStockLevel}
                  onChange={(e) => setForm({ ...form, minStockLevel: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs text-slate-400">
                Жин (кг)
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  className="mt-1 w-full"
                  placeholder="заавал, жишээ: 0,5"
                  value={form.weightKg}
                  onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
                />
              </label>
              {modal === 'edit' && (
                <label className="text-xs text-slate-400 flex min-h-[40px] items-center gap-2 sm:mt-5">
                  <input type="checkbox" className="h-5 w-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Идэвхтэй (ПОС-д харагдана)
                </label>
              )}
              <fieldset className="col-span-2 rounded border border-slate-700 p-2 text-xs text-slate-400">
                <legend className="px-1">Хэмжээ (нэг нэгжийн)</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                        inputMode="decimal"
                        autoComplete="off"
                        className="mt-1 w-full"
                        value={form[key]}
                        onChange={(e) => setForm(withVolume({ ...form, [key]: e.target.value }))}
                      />
                    </label>
                  ))}
                  <label>
                    Эзлэхүүн (м³)
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      className="mt-1 w-full"
                      value={form.volumeM3}
                      onChange={(e) => setForm({ ...form, volumeM3: e.target.value })}
                    />
                  </label>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">Урт, өргөн, өндрийг бөглөхөд эзлэхүүн автоматаар бодогдоно (засаж болно).</p>
              </fieldset>
            </div>
          </form>
        </Modal>
      )}

      {adjusting && (
        <Modal
          title="Үлдэгдэл тохируулах"
          busy={saving}
          onClose={() => setAdjusting(null)}
          footer={
            <>
              <button type="button" className="btn-ghost" onClick={() => setAdjusting(null)} disabled={saving}>
                Болих
              </button>
              <button className="btn-primary" type="submit" form="adjust-form" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Тохируулах'}
              </button>
            </>
          }
        >
          <form id="adjust-form" onSubmit={submitAdjust} className="space-y-3">
            <p className="text-sm text-slate-300">
              <span className="font-semibold text-white">{adjusting.nameMn}</span> ({adjusting.sku})
            </p>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <label className="block text-xs text-slate-400">
              Агуулах
              <select
                className="mt-1 w-full"
                required
                value={adjustForm.warehouseId}
                onChange={(e) => setAdjustForm({ ...adjustForm, warehouseId: e.target.value })}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                    {` — одоо ${reportById.get(adjusting.id)?.warehouses?.find((x) => x.warehouseId === w.id)?.quantity ?? 0}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-400">
              Бодит тоолсон тоо хэмжээ
              <input
                inputMode="decimal"
                autoComplete="off"
                required
                className="mt-1 w-full"
                placeholder="жишээ: 12 эсвэл 2,5"
                value={adjustForm.counted}
                onChange={(e) => setAdjustForm({ ...adjustForm, counted: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Шалтгаан (заавал)
              <input
                required
                minLength={3}
                className="mt-1 w-full"
                value={adjustForm.reason}
                onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                placeholder="жишээ: тооллогын зөрүү"
              />
            </label>
            <p className="text-[11px] text-slate-500">Өөрчлөлт бүр хөдөлгөөний түүхэнд хэн, яагаад гэдгээр хадгалагдана.</p>
          </form>
        </Modal>
      )}

      {ledger && (
        <Modal title={`Хөдөлгөөний түүх — ${ledger.product.nameMn} (${ledger.product.sku})`} size="xl" onClose={() => setLedger(null)}>
          {/* Phones: one line per movement. */}
          <ul className="space-y-2 md:hidden">
            {ledger.rows.map((m) => (
              <li key={m.id} className="rounded-lg border border-slate-800 p-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>{MOVEMENT_LABEL[m.type] ?? m.type}</span>
                  <span className={`font-semibold ${Number(m.quantityDelta) < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                    {Number(m.quantityDelta) > 0 ? '+' : ''}
                    {Number(m.quantityDelta)} → {Number(m.balanceAfter)}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {new Date(m.createdAt).toLocaleString('mn-MN')} · {m.warehouse?.code}
                </p>
                {(m.reason || m.actor?.fullName) && (
                  <p className="text-xs text-slate-500">
                    {m.reason ?? ''}
                    {m.actor?.fullName ? ` — ${m.actor.fullName}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <div className="table-scroll hidden md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="py-2">Огноо</th>
                  <th>Агуулах</th>
                  <th>Төрөл</th>
                  <th className="text-right">Өөрчлөлт</th>
                  <th className="text-right">Үлдэгдэл</th>
                  <th>Тайлбар / хэн</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((m) => (
                  <tr key={m.id} className="border-t border-slate-800 align-top">
                    <td className="py-2 text-xs text-slate-400">{new Date(m.createdAt).toLocaleString('mn-MN')}</td>
                    <td className="text-xs">{m.warehouse?.code}</td>
                    <td className="text-xs">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                    <td className={`text-right font-semibold ${Number(m.quantityDelta) < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                      {Number(m.quantityDelta) > 0 ? '+' : ''}
                      {Number(m.quantityDelta)}
                    </td>
                    <td className="text-right">{Number(m.balanceAfter)}</td>
                    <td className="text-xs text-slate-400">
                      {m.reason ?? ''}
                      {m.actor?.fullName ? ` — ${m.actor.fullName}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ledger.rows.length === 0 && <p className="text-slate-500 text-sm">Түүх алга.</p>}
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Бараа идэвхгүй болгох"
          size="sm"
          busy={saving}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn-ghost" onClick={() => setDeleting(null)} disabled={saving}>
                Болих
              </button>
              <button className="btn-danger" disabled={saving} onClick={() => void confirmDelete()}>
                {saving ? 'Түр хүлээнэ үү…' : 'Идэвхгүй болгох'}
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-white">{deleting.nameMn}</span> ({deleting.sku})-г ПОС-оос хасах уу? Өмнөх захиалгууд
            хэвээр үлдэнэ. Дараа нь «Засах»-аас дахин идэвхжүүлж болно.
          </p>
        </Modal>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 left-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg sm:left-auto ${
            toast.kind === 'error'
              ? 'border-red-700 bg-red-950 text-red-100'
              : 'border-emerald-700 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}
