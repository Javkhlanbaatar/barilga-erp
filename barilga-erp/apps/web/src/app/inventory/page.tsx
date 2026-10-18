'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
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
import { useFeatures } from '@/lib/features';
import { OVERSIGHT_ROLES, TOP_ROLES, hasRole } from '@/lib/rbac';

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

type StockFilter = 'ALL' | 'NEGATIVE_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

const CATEGORIES = ['General', 'Cement', 'Steel', 'Masonry', 'Aggregates', 'Wood', 'Hardware', 'Other'];

const CATEGORY_LABEL: Record<string, string> = {
  General: 'Ерөнхий',
  Cement: 'Цемент',
  Steel: 'Төмөр',
  Masonry: 'Тоосго, блок',
  Aggregates: 'Дүүргэгч',
  Wood: 'Мод',
  Hardware: 'Төмөрлөг, багаж',
  Other: 'Бусад',
};

const emptyForm = {
  sku: '',
  nameMn: '',
  nameEn: '',
  unit: 'pcs',
  category: 'General',
  priceMnt: 0,
  weightKg: 0,
  lengthM: 0,
  volumeM3: 0,
  stockQty: 0,
  minStockLevel: 0,
  imageUrl: '',
  description: '',
  active: true,
  companions: [] as Array<{ name: string; qtyPerUnit: string; unit: string }>,
};

type Toast = { kind: 'error' | 'ok'; text: string };

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
  const [warehouseId, setWarehouseId] = useState('');
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [adjustForm, setAdjustForm] = useState({ warehouseId: '', counted: '', reason: '' });
  const [ledger, setLedger] = useState<{ product: Product; rows: StockMovement[] } | null>(null);
  const [openingWarehouse, setOpeningWarehouse] = useState('');

  const features = useFeatures();
  const canManage = hasRole(user?.role, OVERSIGHT_ROLES);
  // The catalog and prices are shared by every shop: only admin and the general manager change them.
  const canEditCatalog = hasRole(user?.role, TOP_ROLES);
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
      const raw = localStorage.getItem('barilga_user');
      const role = raw ? (JSON.parse(raw) as AuthUser).role : null;
      if (hasRole(role, TOP_ROLES)) {
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
    setSaving(true);
    setError('');
    try {
      await api('/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: adjustForm.warehouseId,
          productId: adjusting.id,
          countedQuantity: Number(adjustForm.counted),
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
    setForm(emptyForm);
    setFile(null);
    setModal('create');
  }

  function openEdit(row: Product) {
    setEditing(row);
    setForm({
      sku: row.sku,
      nameMn: row.nameMn,
      nameEn: row.nameEn,
      unit: row.unit,
      category: row.category ?? 'General',
      priceMnt: Number(row.priceMnt),
      weightKg: Number(row.weightKg),
      lengthM: Number(row.lengthM),
      volumeM3: Number(row.volumeM3),
      stockQty: Number(row.stockQty),
      minStockLevel: Number(row.minStockLevel ?? 0),
      imageUrl: row.imageUrl ?? '',
      description: row.description ?? '',
      active: row.active !== false,
      companions: (row.companions ?? []).map((c) => ({ name: c.name, qtyPerUnit: String(c.qtyPerUnit), unit: c.unit })),
    });
    setFile(null);
    setModal('edit');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        priceMnt: Number(form.priceMnt),
        weightKg: Number(form.weightKg),
        lengthM: Number(form.lengthM),
        volumeM3: Number(form.volumeM3),
        stockQty: Number(form.stockQty),
        minStockLevel: Number(form.minStockLevel),
        imageUrl: form.imageUrl || null,
        description: form.description.trim() || null,
        category: form.category.trim() || 'General',
        companions: form.companions
          .filter((c) => c.name.trim() && Number(c.qtyPerUnit) > 0)
          .map((c) => ({ name: c.name.trim(), qtyPerUnit: Number(c.qtyPerUnit), unit: c.unit.trim() || 'ш' })),
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
  const rows = (filter === 'ALL' ? allRows : allRows.filter((row) => row.stockStatus === filter)).filter((row) =>
    productMatchesQuery(row, query),
  );
  const negativeCount =
    report?.summary.negativeStock ?? allRows.filter((r) => r.stockStatus === 'NEGATIVE_STOCK').length;

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Үлдэгдэл</p>
          <h2 className="text-xl font-bold">Барааны удирдлага</h2>
          <p className="text-slate-400 text-sm mt-1">
            Бараа нэмэх, засах, идэвхгүй болгох. Агуулах захиалгыг олгоход үлдэгдэл хасагдана.
          </p>
        </div>
        <div className="flex gap-2">
          {canEditCatalog && (
            <button className="btn-primary" onClick={openCreate}>
              Бараа нэмэх
            </button>
          )}
          {features.enabled('PRICE_LISTS') && (
            <a className="btn-ghost" href="/print/price-list?id=retail" target="_blank" rel="noreferrer">
              Үнийн жагсаалт хэвлэх
            </a>
          )}
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      {error && !modal && <p className="text-red-400 mb-3">{error}</p>}

      {report && (
        <section className="grid gap-3 sm:grid-cols-4 mb-4">
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
            <label className="block text-xs text-slate-400">
              Агуулах / дэлгүүр
              <select className="mt-1 block min-w-[220px]" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
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

      <label className="block text-xs text-slate-400 mb-3">
        Нэр, тайлбар, SKU-гаар хайх
        <input
          className="mt-1 w-full max-w-md"
          value={query}
          autoComplete="off"
          placeholder="жишээ: суурь, цемент, CEM-42"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap gap-2 mb-4">
        {(
          [
            ['ALL', 'Бүгд'],
            ['NEGATIVE_STOCK', 'Хасах / илүү зарагдсан'],
            ['LOW_STOCK', 'Дуусч буй'],
            ['OUT_OF_STOCK', 'Дууссан'],
          ] as Array<[StockFilter, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={filter === key ? 'btn-primary text-xs px-3 py-1' : 'btn-ghost text-xs px-3 py-1'}
            onClick={() => setFilter(key)}
          >
            {label}
            {key === 'NEGATIVE_STOCK' && negativeCount > 0 ? ` (${negativeCount})` : ''}
          </button>
        ))}
      </div>

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

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3 w-16">Зураг</th>
              <th>SKU</th>
              <th>Барааны нэр</th>
              <th>Ангилал</th>
              <th className="text-right">Үнэ</th>
              <th className="text-right">Үлдэгдэл</th>
              <th>Төлөв</th>
              {canManage && <th className="pr-3 text-right">Үйлдэл</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`border-t border-slate-800 ${row.active === false ? 'opacity-60' : ''}`}>
                <td className="p-3">
                  <ProductImage src={row.imageUrl} alt={row.nameMn} className="h-12 w-12 rounded-md" />
                </td>
                <td className="font-mono text-xs">{row.sku}</td>
                <td>
                  <p className="font-medium">{row.nameMn}</p>
                  <p className="text-xs text-slate-500">{row.nameEn}</p>
                  {row.description ? <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{row.description}</p> : null}
                </td>
                <td>{CATEGORY_LABEL[row.category ?? 'General'] ?? row.category}</td>
                <td className="text-right">{tugrik(Number(row.priceMnt ?? 0))}</td>
                <td className={`text-right font-semibold ${row.stockStatus === 'NEGATIVE_STOCK' ? 'text-rose-300' : ''}`}>
                  {Number(row.stockQty)}
                  {severalWarehouses && !report?.warehouseId && row.warehouses && (
                    <p className="mt-0.5 text-[11px] font-normal text-slate-500">
                      {row.warehouses.map((w) => `${w.code}: ${w.quantity}`).join(' · ')}
                    </p>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    <Badge status={row.stockStatus} />
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        row.active === false
                          ? 'border-slate-600 text-slate-400'
                          : 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                      }`}
                    >
                      {row.active === false ? 'Идэвхгүй' : 'Идэвхтэй'}
                    </span>
                  </div>
                </td>
                {canManage && (
                  <td className="pr-3">
                    <div className="flex justify-end gap-1">
                      {canEditCatalog && (
                        <button className="btn-ghost text-xs px-3 py-1" onClick={() => openEdit(row)}>
                          Засах
                        </button>
                      )}
                      <button className="btn-ghost text-xs px-3 py-1" onClick={() => openAdjust(row)}>
                        Тохируулах
                      </button>
                      <button className="btn-ghost text-xs px-3 py-1" onClick={() => void openLedger(row)}>
                        Түүх
                      </button>
                      {canEditCatalog && row.active !== false && (
                        <button className="btn-danger text-xs px-3 py-1" onClick={() => setDeleting(row)}>
                          Идэвхгүй болгох
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Бараа уншиж байна…</p>}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={save} className="card w-full max-w-lg space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">{modal === 'create' ? 'Бараа нэмэх' : 'Бараа засах'}</h3>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex items-center gap-3">
              <ProductImage
                src={file ? URL.createObjectURL(file) : form.imageUrl}
                alt="Урьдчилан харах"
                className="h-20 w-20 rounded-lg"
              />
              <div className="flex-1 space-y-2">
                <label className="block text-xs text-slate-400">
                  Зургийн холбоос (URL)
                  <input
                    className="mt-1 w-full"
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
                <select
                  className="mt-1 w-full"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Хэмжих нэгж
                <input className="mt-1 w-full" required value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
              </label>
              <label className="text-xs text-slate-400">
                Үнэ ₮
                <input
                  type="number"
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
                  Нэг ширхэг/нэгж зарах бүрд хамт олгох зүйл. Тасалбар, бэлтгэх хуудас, баримт дээр «+ Хатаагч × 2 ш» гэж гарна.
                </p>
                {form.companions.map((c, idx) => (
                  <div key={idx} className="mb-1 flex gap-1">
                    <input
                      className="flex-1"
                      placeholder="Нэр (Хатаагч)"
                      value={c.name}
                      onChange={(e) => setForm({ ...form, companions: form.companions.map((x, j) => (j === idx ? { ...x, name: e.target.value } : x)) })}
                    />
                    <input
                      className="w-20"
                      inputMode="decimal"
                      placeholder="1 нэгжид"
                      value={c.qtyPerUnit}
                      onChange={(e) => setForm({ ...form, companions: form.companions.map((x, j) => (j === idx ? { ...x, qtyPerUnit: e.target.value } : x)) })}
                    />
                    <input
                      className="w-16"
                      placeholder="ш"
                      value={c.unit}
                      onChange={(e) => setForm({ ...form, companions: form.companions.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)) })}
                    />
                    <button type="button" className="btn-ghost px-2 text-xs" onClick={() => setForm({ ...form, companions: form.companions.filter((_, j) => j !== idx) })}>
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setForm({ ...form, companions: [...form.companions, { name: '', qtyPerUnit: '1', unit: 'ш' }] })}
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
                  className="mt-1 w-full"
                  value={form.stockQty}
                  disabled={modal === 'edit' && severalWarehouses}
                  onChange={(e) => setForm({ ...form, stockQty: Number(e.target.value) })}
                />
                {modal === 'edit' && severalWarehouses && (
                  <span className="mt-1 block text-[11px] text-slate-500">Агуулах бүрийн үлдэгдлийг «Тохируулах» товчоор өөрчилнө.</span>
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
                  className="mt-1 w-full"
                  value={form.minStockLevel}
                  onChange={(e) => setForm({ ...form, minStockLevel: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs text-slate-400">
                Жин (кг)
                <input
                  type="number"
                  step="0.001"
                  className="mt-1 w-full"
                  value={form.weightKg}
                  onChange={(e) => setForm({ ...form, weightKg: Number(e.target.value) })}
                />
              </label>
              {modal === 'edit' && (
                <label className="text-xs text-slate-400 flex items-center gap-2 mt-5">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  />
                  Идэвхтэй (POS-д харагдана)
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {adjusting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submitAdjust} className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">Үлдэгдэл тохируулах</h3>
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
                type="number"
                step="0.001"
                min={0}
                required
                className="mt-1 w-full"
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
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setAdjusting(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Тохируулах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {ledger && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="card w-full max-w-3xl space-y-3 max-h-[85vh] overflow-auto">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-lg">
                Хөдөлгөөний түүх — {ledger.product.nameMn} ({ledger.product.sku})
              </h3>
              <button className="btn-ghost text-xs" onClick={() => setLedger(null)}>
                Хаах
              </button>
            </div>
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
            {ledger.rows.length === 0 && <p className="text-slate-500 text-sm">Түүх алга.</p>}
          </div>
        </div>
      )}

      {deleting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">Бараа идэвхгүй болгох</h3>
            <p className="text-sm text-slate-300">
              <span className="font-semibold text-white">{deleting.nameMn}</span> ({deleting.sku})-г POS-оос хасах уу?
              Өмнөх захиалгууд хэвээр үлдэнэ. Дараа нь «Засах»-аас дахин идэвхжүүлж болно.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
                Болих
              </button>
              <button className="btn-danger" disabled={saving} onClick={() => void confirmDelete()}>
                {saving ? 'Түр хүлээнэ үү…' : 'Идэвхгүй болгох'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg ${
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
