'use client';

import { matchesSearch } from '@/lib/translit';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { categoryLabel, unitLabel } from '@/lib/catalog';
import { can, useCan } from '@/lib/permissions';
import { POS_ROLES, hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser, PriceList, Product } from '@/lib/types';

type Row = {
  productId: string;
  sku: string;
  nameMn: string;
  unit: string;
  category: string;
  retailMnt: number;
  lastCostMnt: number | null;
  listPriceMnt: number | null;
};
type Detail = {
  id: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  validUntil: string | null;
  /** Links that work now (the whole-list one and any limited ones). */
  shareCount?: number;
  products: Row[];
};

/** A link sent to a customer, as GET /price-lists/shares lists it. */
type Share = {
  id: string;
  token: string;
  publicPath: string;
  label: string | null;
  priceListId: string | null;
  productIds: string[];
  categories: string[];
  includeUnlisted: boolean;
  expiresAt: string | null;
  createdAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  productCount: number;
  categoryCount: number;
  itemCount?: number;
  createdBy?: string | null;
};

/** The shelf prices, shown like a list (no list price of their own). */
const RETAIL = 'retail';
/** The printed sheet and a link take at most this many hand-picked products (same limit as the API). */
const MAX_PICK = 200;

const todayUb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
const day = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** "12 сонгосон бараа + Цемент" — what a link shows. */
function scopeText(s: Share) {
  const parts: string[] = [];
  if (s.productCount) parts.push(`${s.productCount} сонгосон бараа`);
  if (s.categoryCount) parts.push(s.categories.map((c) => categoryLabel(c)).join(', '));
  if (!parts.length) parts.push(s.includeUnlisted ? 'Бүх бараа' : 'Бүх жагсаалт');
  return parts.join(' + ');
}

const STATUS: Record<Share['status'], { text: string; cls: string }> = {
  ACTIVE: { text: 'Ажиллаж байна', cls: 'border-emerald-700 bg-emerald-950/50 text-emerald-200' },
  EXPIRED: { text: 'Хугацаа дууссан', cls: 'border-amber-700 bg-amber-950/50 text-amber-200' },
  REVOKED: { text: 'Хаасан', cls: 'border-slate-600 text-slate-400' },
};

/**
 * Price lists (өртгийн үнэ, бартерын үнэ, бөөний үнэ ...): a price per product. A customer on a list buys
 * listed products at the list price and everything else at retail. The shelf prices ("Жижиглэн үнэ") can be
 * printed and sent the same way.
 */
export default function PriceListsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  /** The lists have been read once (the «Эхлэх» help shows only when there really are none). */
  const [listsLoaded, setListsLoaded] = useState(false);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [retailRows, setRetailRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [onlyListed, setOnlyListed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Prices are shared by every shop: admin and the general manager by default, or whoever the admin allows.
  const canEdit = useCan()('PRICE_LIST_WRITE');
  const [pct, setPct] = useState('10');
  const [sendOpen, setSendOpen] = useState(false);
  /** Working links per list (and for retail), as the share panel last counted them. */
  const [shareCounts, setShareCounts] = useState<Record<string, number>>({});

  const isRetail = selected === RETAIL;
  // Shelf prices are public, so the till staff may send those too; a list needs the price-list right.
  const canSend = isRetail ? canEdit || hasRole(me?.role, POS_ROLES) : canEdit;

  const loadLists = useCallback(async () => {
    const rows = await api<PriceList[]>('/price-lists?all=true');
    setLists(rows);
    return rows;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api<Detail>(`/price-lists/${id}/prices`);
    setDetail(d);
    setDraft(Object.fromEntries(d.products.map((p) => [p.productId, p.listPriceMnt === null ? '' : String(p.listPriceMnt)])));
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const user = JSON.parse(raw) as AuthUser;
    // Same rule as the API: managers see the lists; changing them needs the price-list right.
    if (!hasRole(user.role, OVERSIGHT_ROLES) && !can(user, 'PRICE_LIST_WRITE')) {
      router.replace(homeForRole(user.role));
      return;
    }
    setMe(user);
    setReady(true);
    void loadLists()
      .then((rows) => {
        setListsLoaded(true);
        // Keep «Жижиглэн үнэ» if it was opened while the lists were loading.
        if (rows[0]) setSelected((cur) => cur || rows[0].id);
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, [router, loadLists]);

  useEffect(() => {
    if (!ready || !selected) return;
    setPicked([]);
    setSendOpen(false);
    if (selected !== RETAIL) void loadDetail(selected).catch(() => setDetail(null));
  }, [ready, selected, loadDetail]);

  // The shelf prices: every active product, loaded the first time «Жижиглэн үнэ» is opened.
  useEffect(() => {
    if (!ready || selected !== RETAIL || retailRows) return;
    api<Array<Product & { lastCostMnt?: number | null }>>('/products')
      .then((products) =>
        setRetailRows(
          products
            .map((p) => ({
              productId: p.id,
              sku: p.sku,
              nameMn: p.nameMn,
              unit: p.unit,
              category: p.category ?? 'General',
              retailMnt: Number(p.priceMnt),
              lastCostMnt: p.lastCostMnt ?? null,
              listPriceMnt: null,
            }))
            .sort((a, b) => a.sku.localeCompare(b.sku)),
        ),
      )
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Бараа ачаалж чадсангүй' }));
  }, [ready, selected, retailRows]);

  /** What the table shows: the open list, or the shelf prices. */
  const view: Detail | null = useMemo(
    () =>
      isRetail
        ? retailRows && { id: RETAIL, name: 'Жижиглэн үнэ', notes: null, isActive: true, validUntil: null, products: retailRows }
        : detail,
    [isRetail, retailRows, detail],
  );
  const shareCount = view ? (shareCounts[view.id] ?? view.shareCount) : undefined;

  const categories = useMemo(
    () => [...new Set((view?.products ?? []).map((p) => p.category || 'General'))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), 'mn')),
    [view],
  );

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    // The category matches by its key ("Cement") and by its Mongolian name ("Цемент").
    return (view?.products ?? []).filter(
      (p) =>
        (!term || matchesSearch(`${p.sku} ${p.nameMn} ${p.category} ${categoryLabel(p.category)}`, term)) &&
        (!catFilter || (p.category || 'General') === catFilter) &&
        (!onlyListed || isRetail || p.listPriceMnt !== null),
    );
  }, [view, q, catFilter, onlyListed, isRetail]);

  const changes = useMemo(() => {
    if (!detail || isRetail) return [];
    return detail.products
      .map((p) => {
        const raw = (draft[p.productId] ?? '').trim();
        const next = raw === '' ? null : Math.round(Number(raw));
        return { productId: p.productId, priceMnt: next, before: p.listPriceMnt };
      })
      .filter((c) => c.priceMnt !== c.before && (c.priceMnt === null || (Number.isFinite(c.priceMnt) && c.priceMnt >= 0)));
  }, [detail, draft, isRetail]);

  // Selection: picks stay while filtering; "all visible" works on what is shown.
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const visiblePicked = rows.filter((r) => pickedSet.has(r.productId)).length;
  const allVisiblePicked = rows.length > 0 && visiblePicked === rows.length;
  const toggleOne = (id: string, on: boolean) => setPicked((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  function toggleAllVisible() {
    const visible = rows.map((r) => r.productId);
    if (allVisiblePicked) {
      const hide = new Set(visible);
      setPicked((prev) => prev.filter((id) => !hide.has(id)));
    } else {
      setPicked((prev) => [...prev, ...visible.filter((id) => !prev.includes(id))]);
    }
  }

  /**
   * Print links. For a list, chosen or filtered products print with `all=1` so a product without a list price
   * still shows (at retail); «Зөвхөн үнэ оруулсан» keeps to the list's own products.
   */
  const printBase = `/print/price-list?id=${encodeURIComponent(view?.id ?? RETAIL)}`;
  const withAll = !isRetail && !onlyListed ? '&all=1' : '';
  const pickedHref = `${printBase}&ids=${picked.join(',')}${isRetail ? '' : '&all=1'}`;
  const filtered = Boolean(q.trim() || catFilter || onlyListed);
  // Nothing visible (a search that matches nothing) prints nothing — never the whole catalog.
  const visibleHref = rows.length === 0
    ? null
    : !q.trim() && catFilter
    ? `${printBase}&cat=${encodeURIComponent(catFilter)}${withAll}`
    : !q.trim() && !catFilter
      ? `${printBase}${withAll}`
      : rows.length <= MAX_PICK
        ? `${printBase}&ids=${rows.map((r) => r.productId).join(',')}${isRetail ? '' : '&all=1'}`
        : null;

  /**
   * Ready-made lists so the feature works on day one: the list is created and its prices filled in one go
   * (wholesale = retail − 10%, cost = last purchase price where known, barter = retail). Prices can be changed
   * afterwards like any other list.
   */
  async function quickStart(kind: 'wholesale' | 'cost' | 'barter') {
    const names = { wholesale: 'Бөөний үнэ', cost: 'Өртгийн үнэ', barter: 'Бартерын үнэ' } as const;
    setBusy(true);
    setMessage(null);
    try {
      const created = await api<PriceList>('/price-lists', { method: 'POST', body: JSON.stringify({ name: names[kind] }) });
      const d = await api<Detail>(`/price-lists/${created.id}/prices`);
      const prices = d.products
        .map((p) => ({
          productId: p.productId,
          priceMnt: kind === 'wholesale' ? Math.round(p.retailMnt * 0.9) : kind === 'cost' ? p.lastCostMnt : p.retailMnt,
        }))
        .filter((p): p is { productId: string; priceMnt: number } => p.priceMnt !== null && p.priceMnt >= 0);
      if (prices.length) await api(`/price-lists/${created.id}/prices`, { method: 'PUT', body: JSON.stringify({ prices }) });
      await loadLists();
      setSelected(created.id);
      setMessage({
        ok: true,
        text: `«${names[kind]}» үүслээ (${prices.length} барааны үнэ). Харилцагчид оноохдоо: Харилцагчид → засах → «Үнийн жагсаалт».`,
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Үүсгэж чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  async function createList(e: FormEvent) {
    e.preventDefault();
    if (newName.trim().length < 2) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await api<PriceList>('/price-lists', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
      setNewName('');
      await loadLists();
      setSelected(created.id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Үүсгэж чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!detail) return;
    try {
      await api(`/price-lists/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !detail.isActive }) });
      await loadLists();
      await loadDetail(detail.id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    }
  }

  async function save() {
    if (!detail || changes.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/price-lists/${detail.id}/prices`, {
        method: 'PUT',
        body: JSON.stringify({ prices: changes.map(({ productId, priceMnt }) => ({ productId, priceMnt })) }),
      });
      await loadDetail(detail.id);
      await loadLists();
      setMessage({ ok: true, text: `${changes.length} үнэ хадгалагдлаа` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  /** Fills every empty price in the visible rows with the product's last known cost. */
  function fillFromCost() {
    const next = { ...draft };
    for (const r of rows) if (!(next[r.productId] ?? '').trim() && r.lastCostMnt !== null) next[r.productId] = String(r.lastCostMnt);
    setDraft(next);
  }

  /** Fills the visible rows with retail minus a percentage (only empty ones, or all with `overwrite`). */
  function fillFromRetail(overwrite: boolean) {
    const p = Number(pct.replace(',', '.'));
    if (!Number.isFinite(p) || p < 0 || p >= 100) return setMessage({ ok: false, text: 'Хувь 0–99 байна' });
    const next = { ...draft };
    for (const r of rows) {
      if (!overwrite && (next[r.productId] ?? '').trim()) continue;
      next[r.productId] = String(Math.round((r.retailMnt * (100 - p)) / 100));
    }
    setDraft(next);
  }

  async function setValidUntil(value: string) {
    if (!detail) return;
    try {
      await api(`/price-lists/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ validUntil: value || null }) });
      await loadDetail(detail.id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    }
  }

  /** The list-price box of one product (table and phone card). */
  const priceInput = (r: Row, cls: string) => {
    const value = draft[r.productId] ?? '';
    const changed = value.trim() !== (r.listPriceMnt === null ? '' : String(r.listPriceMnt));
    return (
      <input
        className={`${cls} text-right ${changed ? 'border-amber-500' : ''}`}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        placeholder="жижиглэн"
        aria-label={`${r.nameMn}: энэ жагсаалтын үнэ`}
        readOnly={!canEdit}
        value={value}
        onChange={(e) => setDraft({ ...draft, [r.productId]: e.target.value })}
      />
    );
  };

  const tooManyPicked = picked.length > MAX_PICK;

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Борлуулалт</p>
        <h2 className="text-xl font-bold">Үнийн жагсаалт</h2>
        <p className="text-slate-400 text-sm mt-1">
          Өртгийн үнэ, бартерын үнэ г.м. Харилцагчид жагсаалт оноовол ПОС тэр үнээр тооцно. Жагсаалтад үнэ оруулаагүй бараа жижиглэн үнээр зарагдана.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex flex-wrap gap-1">
          <button
            className={`rounded-md px-3 py-1.5 text-sm min-h-[40px] md:min-h-0 ${isRetail ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
            onClick={() => setSelected(RETAIL)}
          >
            Жижиглэн үнэ
            <span className="ml-1 text-[11px] opacity-70">дэлгүүрийн үнэ</span>
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              className={`rounded-md px-3 py-1.5 text-sm min-h-[40px] md:min-h-0 ${selected === l.id ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'} ${l.isActive ? '' : 'opacity-50'}`}
              onClick={() => setSelected(l.id)}
            >
              {l.name}
              <span className="ml-1 text-[11px] opacity-70">
                {l.productCount ?? 0} бараа · {l.customerCount ?? 0} харилцагч
              </span>
            </button>
          ))}
        </div>
        {canEdit && (
          <form onSubmit={createList} className="flex w-full gap-1 sm:ml-auto sm:w-auto">
            <input
              className="min-w-0 flex-1 sm:w-48 sm:flex-none"
              placeholder="Шинэ жагсаалтын нэр"
              aria-label="Шинэ жагсаалтын нэр"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn-primary text-sm" disabled={busy || newName.trim().length < 2}>
              Нэмэх
            </button>
          </form>
        )}
      </div>

      {message && <p className={`text-sm mb-3 ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}

      {isRetail && !view && <p className="mb-3 text-sm text-slate-500">Бараа уншиж байна…</p>}

      {view && (
        <div className="card p-0">
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-800">
            <h3 className="font-semibold mr-2">{view.name}</h3>
            {isRetail && <span className="text-xs text-slate-400">Бараа бүрийн дэлгүүрийн үнэ. Үнийг «Бараа» хуудсанд засна.</span>}
            {!isRetail && !view.isActive && <span className="text-xs text-slate-400">(идэвхгүй — харилцагчид жижиглэн үнээр авна)</span>}
            {!isRetail && canEdit && (
              <>
                <button className="btn-ghost text-xs px-3 py-1" onClick={() => void toggleActive()}>
                  {view.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}
                </button>
                <button className="btn-primary text-sm sm:ml-auto" disabled={busy || changes.length === 0} onClick={() => void save()}>
                  {busy ? 'Хадгалж байна…' : `Хадгалах${changes.length ? ` (${changes.length})` : ''}`}
                </button>
              </>
            )}
            {!isRetail && !canEdit && <span className="text-xs text-slate-500 sm:ml-auto">Үнэ засах эрхгүй — зөвхөн харна.</span>}
          </div>

          {!isRetail && canEdit && (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3 text-xs text-slate-400">
              <span className="w-full sm:w-auto">Харагдаж буй мөрүүдийг бөглөх:</span>
              <button className="btn-ghost text-xs px-3 py-1" onClick={fillFromCost}>
                Хоосныг сүүлийн өртгөөр
              </button>
              <span className="flex flex-wrap items-center gap-1">
                Жижиглэнгээс −
                <input className="w-16 text-right" inputMode="decimal" aria-label="Хямдрах хувь" value={pct} onChange={(e) => setPct(e.target.value)} />%
                <button className="btn-ghost text-xs px-2 py-1" onClick={() => fillFromRetail(false)}>
                  Хоосныг бөглөх
                </button>
                <button className="btn-ghost text-xs px-2 py-1" onClick={() => fillFromRetail(true)}>
                  Бүгдийг дарж бичих
                </button>
              </span>
              <span className="w-full text-[11px] text-slate-500">Бөглөсний дараа «Хадгалах» дарна.</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3 text-xs">
            <span className="w-full text-slate-400 sm:w-auto">Хэвлэх / илгээх:</span>
            {isRetail ? (
              <a className="btn-ghost text-xs px-3 py-1" href={printBase} target="_blank" rel="noreferrer">
                Бүгдийг хэвлэх
              </a>
            ) : (
              <>
                <a className="btn-ghost text-xs px-3 py-1" href={printBase} target="_blank" rel="noreferrer">
                  Жагсаалтын барааг хэвлэх
                </a>
                <a className="btn-ghost text-xs px-3 py-1" href={`${printBase}&all=1`} target="_blank" rel="noreferrer">
                  Бүх барааг хэвлэх
                </a>
              </>
            )}
            {filtered &&
              (visibleHref ? (
                <a className="btn-ghost text-xs px-3 py-1" href={visibleHref} target="_blank" rel="noreferrer">
                  Харагдаж буйг хэвлэх ({rows.length})
                </a>
              ) : (
                <button className="btn-ghost text-xs px-3 py-1" disabled>
                  Харагдаж буйг хэвлэх ({rows.length})
                </button>
              ))}
            {picked.length > 0 &&
              (tooManyPicked ? (
                <button className="btn-ghost text-xs px-3 py-1" disabled>
                  Сонгосныг хэвлэх ({picked.length})
                </button>
              ) : (
                <a className="btn-primary text-xs px-3 py-1" href={pickedHref} target="_blank" rel="noreferrer">
                  Сонгосныг хэвлэх ({picked.length})
                </a>
              ))}
            {canSend && (
              <button className={`${sendOpen ? 'btn-primary' : 'btn-ghost'} text-xs px-3 py-1`} onClick={() => setSendOpen((v) => !v)}>
                Холбоос илгээх{shareCount ? ` (${shareCount} ажиллаж байна)` : ''}
              </button>
            )}
            {!isRetail && (
              <label className="flex w-full items-center gap-2 text-slate-400 sm:ml-auto sm:w-auto">
                Хүчинтэй хугацаа
                <input type="date" disabled={!canEdit} value={view.validUntil ?? ''} onChange={(e) => void setValidUntil(e.target.value)} />
              </label>
            )}
            {(tooManyPicked || (filtered && rows.length > 0 && !visibleHref)) && (
              <span className="w-full text-amber-300">
                Нэг удаад {MAX_PICK} хүртэл бараа хэвлэнэ / илгээнэ. Ангиллаар шүүвэл тухайн ангиллыг бүхэлд нь хэвлэж болно.
              </span>
            )}
            {changes.length > 0 && <span className="w-full text-amber-300">Хадгалаагүй үнэ хэвлэгдэхгүй — эхлээд «Хадгалах» дарна уу.</span>}
          </div>

          {sendOpen && canSend && (
            <SharePanel
              key={view.id}
              priceListId={isRetail ? null : view.id}
              listName={view.name}
              isActive={view.isActive}
              validUntil={view.validUntil}
              pickedIds={picked}
              categories={categories}
              currentCategory={catFilter}
              onCount={(n) => setShareCounts((prev) => (prev[view.id] === n ? prev : { ...prev, [view.id]: n }))}
            />
          )}

          <div className="flex flex-wrap items-end gap-2 border-b border-slate-800 p-3">
            <input
              className="w-full sm:w-64"
              type="search"
              placeholder="Бараа шүүх (нэр, код)…"
              aria-label="Бараа шүүх"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="w-full sm:w-auto" aria-label="Ангилал" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">Бүх ангилал</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
            {!isRetail && (
              <label className="flex min-h-[40px] items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" className="h-5 w-5" checked={onlyListed} onChange={(e) => setOnlyListed(e.target.checked)} />
                Зөвхөн үнэ оруулсан бараа
              </label>
            )}
            <label className="flex min-h-[40px] items-center gap-2 text-sm text-slate-300 sm:ml-auto">
              <SelectAllBox all={allVisiblePicked} some={visiblePicked > 0} onChange={toggleAllVisible} />
              Харагдаж буй {rows.length}-г сонгох
            </label>
            {picked.length > 0 && (
              <button className="btn-ghost text-xs px-3 py-1" onClick={() => setPicked([])}>
                Сонголт цуцлах ({picked.length})
              </button>
            )}
          </div>

          {/* Phones: one card per product. */}
          <div className="divide-y divide-slate-800 md:hidden">
            {rows.map((r) => (
              <div key={r.productId} className={`flex gap-3 p-3 ${pickedSet.has(r.productId) ? 'bg-amber-950/20' : ''}`}>
                <label className="flex w-8 shrink-0 cursor-pointer justify-center pt-0.5">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={pickedSet.has(r.productId)}
                    onChange={(e) => toggleOne(r.productId, e.target.checked)}
                    aria-label={`${r.nameMn} сонгох`}
                  />
                </label>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium leading-snug">
                    {r.nameMn} <span className="text-xs font-normal text-slate-500">{unitLabel(r.unit)}</span>
                  </p>
                  <p className="font-mono text-[11px] text-slate-500">
                    {r.sku} · {categoryLabel(r.category)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Жижиглэн <span className="text-slate-200">{tugrik(r.retailMnt)}</span>
                    {r.lastCostMnt !== null && <> · өртөг {tugrik(r.lastCostMnt)}</>}
                  </p>
                  {!isRetail && (
                    <label className="mt-2 block text-xs text-slate-400">
                      Энэ жагсаалтын үнэ ₮
                      <span className="mt-1 block">{priceInput(r, 'w-full')}</span>
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="table-scroll hidden md:block">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-left text-xs text-slate-400">
                <tr>
                  <th className="w-10 p-2">
                    <SelectAllBox all={allVisiblePicked} some={visiblePicked > 0} onChange={toggleAllVisible} />
                  </th>
                  <th className="py-2">Код</th>
                  <th>Бараа</th>
                  <th>Ангилал</th>
                  <th className="text-right">Жижиглэн</th>
                  <th className={`text-right ${isRetail ? 'pr-3' : ''}`}>Сүүлийн өртөг</th>
                  {!isRetail && <th className="text-right pr-3">Энэ жагсаалтын үнэ</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId} className={`border-t border-slate-800 ${pickedSet.has(r.productId) ? 'bg-amber-950/20' : ''}`}>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        className="h-5 w-5 cursor-pointer"
                        checked={pickedSet.has(r.productId)}
                        onChange={(e) => toggleOne(r.productId, e.target.checked)}
                        aria-label={`${r.nameMn} сонгох`}
                      />
                    </td>
                    <td className="py-2 font-mono text-[11px] text-slate-400">{r.sku}</td>
                    <td>
                      {r.nameMn} <span className="text-xs text-slate-500">{unitLabel(r.unit)}</span>
                    </td>
                    <td className="text-xs text-slate-400">{categoryLabel(r.category)}</td>
                    <td className="text-right">{tugrik(r.retailMnt)}</td>
                    <td className={`text-right text-slate-400 ${isRetail ? 'pr-3' : ''}`}>{r.lastCostMnt === null ? '—' : tugrik(r.lastCostMnt)}</td>
                    {!isRetail && <td className="text-right pr-3 py-1">{priceInput(r, 'w-32')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p className="p-3 text-sm text-slate-500">Шүүлтэд тохирох бараа алга.</p>}
        </div>
      )}
      {listsLoaded && lists.length === 0 && (
        <div className="card mt-4 max-w-3xl space-y-3">
          <p className="font-semibold">Эхлэх</p>
          <p className="text-sm text-slate-400">
            Үнийн жагсаалт нь тодорхой харилцагчдад өөр үнээр зарахад хэрэглэгдэнэ. Доорхоос бэлэн загвар сонгоход үнэ нь автоматаар бөглөгдөнө —
            дараа нь бараа тус бүрийн үнийг засаж болно.
          </p>
          {canEdit ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ['wholesale', 'Бөөний үнэ', 'Жижиглэн үнээс 10% хямд'],
                  ['cost', 'Өртгийн үнэ', 'Сүүлд авсан өртгөөр (өртөгтэй бараа)'],
                  ['barter', 'Бартерын үнэ', 'Жижиглэн үнээр эхэлнэ, дараа нь засна'],
                ] as const
              ).map(([k, title, hint]) => (
                <button key={k} type="button" className="rounded-lg border border-slate-700 p-3 text-left hover:border-amber-500" disabled={busy} onClick={() => void quickStart(k)}>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-xs text-slate-400">{hint}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Үнийн жагсаалтыг админ эсвэл ерөнхий менежер үүсгэнэ.</p>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>Жагсаалт үүсгэж үнийг тохируулна.</li>
            <li>«Харилцагчид» → харилцагч засах → «Үнийн жагсаалт»-аас сонгоно.</li>
            <li>Касс дээр тэр харилцагчийг сонгоход сагсны үнэ автоматаар жагсаалтын үнээр бодогдоно (жагсаалтад байхгүй бараа жижиглэн үнээр).</li>
          </ol>
        </div>
      )}
    </Shell>
  );
}

/** A checkbox that can also show "some are chosen" (the dash), for "select all visible". */
function SelectAllBox({ all, some, onChange }: { all: boolean; some: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !all;
  }, [all, some]);
  return <input ref={ref} type="checkbox" className="h-5 w-5 cursor-pointer" checked={all} onChange={onChange} aria-label="Харагдаж буй бүх барааг сонгох" />;
}

type Scope = 'all' | 'picked' | 'category';

/**
 * «Холбоос илгээх»: a link the customer opens without logging in (prices only, never costs). It can show the
 * whole list, the chosen products or one category, can carry who it is for and stop working after a day.
 * Below it, the links already sent — copy, open, share or close each one.
 */
function SharePanel({
  priceListId,
  listName,
  isActive,
  validUntil,
  pickedIds,
  categories,
  currentCategory,
  onCount,
}: {
  priceListId: string | null;
  listName: string;
  isActive: boolean;
  validUntil: string | null;
  pickedIds: string[];
  categories: string[];
  currentCategory: string;
  /** How many links work now (for the button above). */
  onCount: (active: number) => void;
}) {
  const today = todayUb();
  const [scope, setScope] = useState<Scope>(pickedIds.length ? 'picked' : currentCategory ? 'category' : 'all');
  const [cat, setCat] = useState(currentCategory || categories[0] || '');
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState(validUntil && validUntil >= today ? validUntil : '');
  const [includeUnlisted, setIncludeUnlisted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [created, setCreated] = useState<Share | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [canShare, setCanShare] = useState(false);

  const load = useCallback(async () => {
    try {
      setShares(await api<Share[]>(`/price-lists/shares?priceListId=${encodeURIComponent(priceListId ?? RETAIL)}`));
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Холбоосуудыг ачаалж чадсангүй' });
      setShares([]);
    }
  }, [priceListId]);

  useEffect(() => {
    void load();
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, [load]);

  // The page shows how many links work now on the «Холбоос илгээх» button.
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;
  useEffect(() => {
    if (shares) onCountRef.current(shares.filter((s) => s.status === 'ACTIVE').length);
  }, [shares]);

  // The chosen products went away (selection cleared): fall back to the whole list.
  useEffect(() => {
    if (scope === 'picked' && pickedIds.length === 0) setScope('all');
  }, [scope, pickedIds.length]);

  const urlOf = (s: Share) => `${window.location.origin}${s.publicPath}`;
  const textOf = (s: Share) => `${listName} үнийн жагсаалт${s.label ? ` (${s.label})` : ''}: ${urlOf(s)}`;

  async function copy(s: Share) {
    try {
      await navigator.clipboard.writeText(textOf(s));
      setMessage({ ok: true, text: 'Холбоос хуулагдлаа — Viber, Messenger, SMS-д буулгаж илгээнэ үү.' });
    } catch {
      window.prompt('Холбоосыг хуулна уу:', urlOf(s));
    }
  }

  async function share(s: Share) {
    try {
      await navigator.share({ title: `${listName} үнийн жагсаалт`, text: textOf(s), url: urlOf(s) });
    } catch {
      // closed the share sheet
    }
  }

  function mailHref(s: Share) {
    const subject = `Үнийн жагсаалт — ${listName}`;
    const body = `Сайн байна уу,\n\nТаны үнийн жагсаалт:\n${urlOf(s)}\n\nХолбоосоор нээж хэвлэх, Excel-ээр татах боломжтой.${
      s.expiresAt ? `\nХолбоос ${s.expiresAt} хүртэл ажиллана.` : ''
    }`;
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (scope === 'picked' && (pickedIds.length === 0 || pickedIds.length > MAX_PICK)) {
      return setMessage({ ok: false, text: `1–${MAX_PICK} бараа сонгоно уу` });
    }
    if (scope === 'category' && !cat) return setMessage({ ok: false, text: 'Ангиллаа сонгоно уу' });
    if (expiresAt && expiresAt < today) return setMessage({ ok: false, text: 'Дуусах өдөр өнгөрсөн байна' });
    setBusy(true);
    setMessage(null);
    try {
      const plain = priceListId && scope === 'all' && !label.trim() && !expiresAt && !includeUnlisted;
      const link = plain
        ? // The list's own whole-list link is reused instead of making another one.
          await api<Share>(`/price-lists/${priceListId}/share`, { method: 'POST', body: '{}' })
        : await api<Share>('/price-lists/shares', {
            method: 'POST',
            body: JSON.stringify({
              priceListId,
              label: label.trim() || undefined,
              productIds: scope === 'picked' ? pickedIds : undefined,
              categories: scope === 'category' ? [cat] : undefined,
              // Chosen products always show, at retail when the list has no price for them.
              includeUnlisted: priceListId ? scope === 'picked' || includeUnlisted : undefined,
              expiresAt: expiresAt || undefined,
            }),
          });
      setCreated(link);
      setLabel('');
      setMessage({ ok: true, text: 'Холбоос бэлэн. Хуулж эсвэл «Хуваалцах»-аар харилцагч руу илгээнэ үү.' });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Холбоос үүсгэж чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  async function close(s: Share) {
    if (!window.confirm(`«${s.label || scopeText(s)}» холбоосыг хаах уу? Харилцагч нээхэд «хаасан» гэж гарна.`)) return;
    try {
      await api(`/price-lists/shares/${s.id}`, { method: 'DELETE' });
      if (created?.id === s.id) setCreated(null);
      setMessage({ ok: true, text: 'Холбоос хаагдлаа' });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хааж чадсангүй' });
    }
  }

  const linkButtons = (s: Share) => (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => void copy(s)}>
        Хуулах
      </button>
      <a className="btn-ghost text-xs px-3 py-1" href={s.publicPath} target="_blank" rel="noreferrer">
        Нээж харах
      </a>
      {canShare && (
        <button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => void share(s)}>
          Хуваалцах
        </button>
      )}
      <a className="btn-ghost text-xs px-3 py-1" href={mailHref(s)}>
        И-мэйл
      </a>
      {s.status === 'ACTIVE' && (
        <button type="button" className="btn-ghost text-xs px-3 py-1 text-red-300" onClick={() => void close(s)}>
          Хаах
        </button>
      )}
    </div>
  );

  const active = (shares ?? []).filter((s) => s.status === 'ACTIVE');
  const closed = (shares ?? []).filter((s) => s.status !== 'ACTIVE');
  const listedShares = showClosed ? (shares ?? []) : active;

  return (
    <div className="space-y-3 border-b border-slate-800 bg-steel-900/60 p-3 text-sm">
      <div>
        <h4 className="font-semibold">Холбоос илгээх</h4>
        <p className="text-xs text-slate-400">
          Харилцагч нэвтрэхгүйгээр утсан дээрээ нээж, хэвлэж, Excel татна. Зөвхөн үнэ харагдана, өртөг харагдахгүй. Үнэ өөрчлөгдөхөд холбоос дээр шууд
          шинэчлэгдэнэ.
        </p>
      </div>

      {!isActive ? (
        <p className="text-xs text-amber-300">Идэвхгүй жагсаалтыг илгээхгүй. Эхлээд «Идэвхжүүлэх» дарна уу.</p>
      ) : (
        <form onSubmit={create} className="space-y-3 rounded-lg border border-slate-700 p-3">
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs text-slate-400">Юуг илгээх</legend>
            <label className="flex min-h-[36px] items-center gap-2">
              <input type="radio" className="h-5 w-5" name="share-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              {priceListId ? 'Бүх жагсаалт' : 'Бүх бараа'}
            </label>
            <label className={`flex min-h-[36px] items-center gap-2 ${pickedIds.length ? '' : 'opacity-50'}`}>
              <input
                type="radio"
                className="h-5 w-5"
                name="share-scope"
                disabled={!pickedIds.length}
                checked={scope === 'picked'}
                onChange={() => setScope('picked')}
              />
              Сонгосон {pickedIds.length} бараа
              {!pickedIds.length && <span className="text-xs text-slate-500">(доорх жагсаалтаас сонгоно)</span>}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-[36px] items-center gap-2">
                <input type="radio" className="h-5 w-5" name="share-scope" checked={scope === 'category'} onChange={() => setScope('category')} />
                Ангилал
              </label>
              <select
                className="w-full sm:w-auto"
                aria-label="Илгээх ангилал"
                value={cat}
                onChange={(e) => {
                  setCat(e.target.value);
                  setScope('category');
                }}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            {priceListId && scope !== 'picked' && (
              <label className="flex min-h-[36px] items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" className="h-5 w-5" checked={includeUnlisted} onChange={(e) => setIncludeUnlisted(e.target.checked)} />
                Жагсаалтад үнэ оруулаагүй барааг ч жижиглэн үнээр харуулах
              </label>
            )}
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Хэнд (заавал биш)
              <input
                className="mt-1 w-full"
                maxLength={80}
                placeholder="жишээ: Бат-Эрдэнэ ХХК"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-slate-500">Аль холбоосыг хэнд явуулснаа доорх жагсаалтаас танина.</span>
            </label>
            <label className="block text-xs text-slate-400">
              Хэдий хүртэл ажиллах (заавал биш)
              <input type="date" className="mt-1 w-full" min={today} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <span className="mt-1 block text-[11px] text-slate-500">Энэ өдрийн дараа холбоос нээгдэхгүй. Хоосон бол хаах хүртэл ажиллана.</span>
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn-primary" disabled={busy || (scope === 'picked' && pickedIds.length > MAX_PICK)}>
              {busy ? 'Үүсгэж байна…' : 'Холбоос үүсгэх'}
            </button>
          </div>
        </form>
      )}

      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}

      {created && (
        <div className="space-y-2 rounded-lg border border-emerald-700 bg-emerald-950/30 p-3">
          <p className="text-xs text-emerald-200">
            Шинэ холбоос: {scopeText(created)}
            {created.label ? ` · ${created.label}` : ''}
          </p>
          <input className="w-full font-mono text-xs" readOnly value={urlOf(created)} onFocus={(e) => e.target.select()} aria-label="Холбоос" />
          {linkButtons(created)}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-400">
            Илгээсэн холбоосууд: {active.length} ажиллаж байна
            {closed.length ? `, ${closed.length} хаагдсан / хугацаа дууссан` : ''}
          </p>
          {closed.length > 0 && (
            <button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? 'Зөвхөн ажиллаж буйг' : 'Хаагдсаныг ч харуулах'}
            </button>
          )}
        </div>
        {shares === null && <p className="text-xs text-slate-500">Уншиж байна…</p>}
        {shares !== null && listedShares.length === 0 && <p className="text-xs text-slate-500">Ажиллаж буй холбоос алга.</p>}
        <ul className="space-y-2">
          {listedShares.map((s) => (
            <li key={s.id} className={`space-y-2 rounded-lg border border-slate-800 p-2 ${s.status === 'ACTIVE' ? '' : 'opacity-70'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS[s.status].cls}`}>{STATUS[s.status].text}</span>
                <span className="font-medium">{s.label || 'Нэргүй'}</span>
                <span className="text-xs text-slate-400">
                  {scopeText(s)}
                  {s.itemCount !== undefined ? ` · одоо ${s.itemCount} бараа` : ''}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                {s.expiresAt ? `${s.expiresAt} хүртэл` : 'Хугацаагүй'} · үүсгэсэн {day(s.createdAt)}
                {s.createdBy ? `, ${s.createdBy}` : ''}
              </p>
              {s.status === 'ACTIVE' && linkButtons(s)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
