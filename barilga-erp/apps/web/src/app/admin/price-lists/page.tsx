'use client';

import { matchesSearch } from '@/lib/translit';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES, TOP_ROLES } from '@/lib/rbac';
import { AuthUser, PriceList } from '@/lib/types';

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
  shared: boolean;
  publicPath: string | null;
  products: Row[];
};

/**
 * Price lists (өртгийн үнэ, бартерын үнэ, бөөний үнэ ...): a price per product. A customer on a list buys
 * listed products at the list price and everything else at retail.
 */
export default function PriceListsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [pct, setPct] = useState('10');
  const [sendOpen, setSendOpen] = useState(false);
  const [email, setEmail] = useState('');

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
    const me = JSON.parse(raw) as AuthUser;
    if (!hasRole(me.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(me.role));
      return;
    }
    setReady(true);
    setCanEdit(hasRole(me.role, TOP_ROLES));
    void loadLists()
      .then((rows) => rows[0] && setSelected(rows[0].id))
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, [router, loadLists]);

  useEffect(() => {
    if (ready && selected) void loadDetail(selected).catch(() => setDetail(null));
  }, [ready, selected, loadDetail]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (detail?.products ?? []).filter(
      (p) => !term || matchesSearch(`${p.sku} ${p.nameMn} ${p.category}`, term),
    );
  }, [detail, q]);

  const changes = useMemo(() => {
    if (!detail) return [];
    return detail.products
      .map((p) => {
        const raw = (draft[p.productId] ?? '').trim();
        const next = raw === '' ? null : Math.round(Number(raw));
        return { productId: p.productId, priceMnt: next, before: p.listPriceMnt };
      })
      .filter((c) => c.priceMnt !== c.before && (c.priceMnt === null || (Number.isFinite(c.priceMnt) && c.priceMnt >= 0)));
  }, [detail, draft]);

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
    await api(`/price-lists/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !detail.isActive }) });
    await loadLists();
    await loadDetail(detail.id);
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
    const p = Number(pct);
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

  const shareUrl = detail?.publicPath ? `${typeof window === 'undefined' ? '' : window.location.origin}${detail.publicPath}` : '';

  async function makeLink() {
    if (!detail) return;
    try {
      await api(`/price-lists/${detail.id}/share`, { method: 'POST', body: '{}' });
      await loadDetail(detail.id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Холбоос үүсгэж чадсангүй' });
    }
  }

  async function revokeLink() {
    if (!detail || !window.confirm('Холбоосыг хаах уу? Өмнө илгээсэн холбоос ажиллахаа болино.')) return;
    await api(`/price-lists/${detail.id}/share`, { method: 'DELETE' });
    await loadDetail(detail.id);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${detail?.name} үнийн жагсаалт: ${shareUrl}`);
      setMessage({ ok: true, text: 'Холбоос хуулагдлаа — Viber, Messenger, SMS-ээр илгээнэ үү' });
    } catch {
      window.prompt('Холбоосыг хуулна уу:', shareUrl);
    }
  }

  function emailLink() {
    if (!detail) return;
    const subject = `Үнийн жагсаалт — ${detail.name}`;
    const body = `Сайн байна уу,\n\nТаны үнийн жагсаалт:\n${shareUrl}\n\nХолбоосоор нээж хэвлэх, Excel-ээр татах боломжтой.${
      detail.validUntil ? `\nҮнэ ${detail.validUntil} хүртэл хүчинтэй.` : ''
    }`;
    window.location.href = `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Борлуулалт</p>
        <h2 className="text-xl font-bold">Үнийн жагсаалт</h2>
        <p className="text-slate-400 text-sm mt-1">
          Өртгийн үнэ, бартерын үнэ г.м. Харилцагчид жагсаалт оноовол ПОС тэр үнээр тооцно. Жагсаалтад үнэгүй бараа жижиглэн үнээр зарагдана.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex flex-wrap gap-1">
          {lists.map((l) => (
            <button
              key={l.id}
              className={`rounded-md px-3 py-1.5 text-sm ${selected === l.id ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'} ${l.isActive ? '' : 'opacity-50'}`}
              onClick={() => setSelected(l.id)}
            >
              {l.name}
              <span className="ml-1 text-[11px] opacity-70">
                {l.productCount ?? 0} бараа · {l.customerCount ?? 0} харилцагч
              </span>
            </button>
          ))}
        </div>
        <a className="btn-ghost text-sm ml-auto" href="/print/price-list?id=retail" target="_blank" rel="noreferrer">
          Жижиглэн үнийн жагсаалт хэвлэх
        </a>
        <form onSubmit={createList} className="flex gap-1">
          <input className="w-48" placeholder="Шинэ жагсаалтын нэр" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn-primary text-sm" disabled={busy || newName.trim().length < 2}>
            Нэмэх
          </button>
        </form>
      </div>

      {message && <p className={`text-sm mb-3 ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}

      {detail && (
        <div className="card p-0 overflow-auto">
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-800">
            <h3 className="font-semibold mr-2">{detail.name}</h3>
            {!detail.isActive && <span className="text-xs text-slate-400">(идэвхгүй — харилцагчид жижиглэн үнээр авна)</span>}
            <input className="w-56" placeholder="Бараа шүүх…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-ghost text-xs px-3 py-1" onClick={fillFromCost}>
              Хоосныг өртгөөр бөглөх
            </button>
            <span className="flex items-center gap-1 text-xs text-slate-400">
              Жижиглэнгээс −
              <input className="w-14 text-right" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />%
              <button className="btn-ghost text-xs px-2 py-1" onClick={() => fillFromRetail(false)} title="Зөвхөн хоосон мөрийг">
                хоосныг
              </button>
              <button className="btn-ghost text-xs px-2 py-1" onClick={() => fillFromRetail(true)} title="Харагдаж буй бүх мөрийг дарж бичнэ">
                бүгдийг
              </button>
            </span>
            <button className="btn-ghost text-xs px-3 py-1" onClick={() => void toggleActive()}>
              {detail.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}
            </button>
            <button className="btn-primary text-sm ml-auto" disabled={busy || changes.length === 0} onClick={() => void save()}>
              {busy ? 'Хадгалж байна…' : `Хадгалах${changes.length ? ` (${changes.length})` : ''}`}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3 text-xs">
            <span className="text-slate-400">Хэвлэх / илгээх:</span>
            <a className="btn-ghost text-xs px-3 py-1" href={`/print/price-list?id=${detail.id}`} target="_blank" rel="noreferrer">
              Хэвлэх (жагсаалтын бараа)
            </a>
            <a className="btn-ghost text-xs px-3 py-1" href={`/print/price-list?id=${detail.id}&all=1`} target="_blank" rel="noreferrer">
              Хэвлэх (бүх бараа)
            </a>
            {canEdit && (
              <button className="btn-primary text-xs px-3 py-1" onClick={() => setSendOpen((v) => !v)}>
                Харилцагч руу илгээх
              </button>
            )}
            <label className="ml-auto flex items-center gap-1 text-slate-400">
              Хүчинтэй хугацаа
              <input type="date" disabled={!canEdit} value={detail.validUntil ?? ''} onChange={(e) => void setValidUntil(e.target.value)} />
            </label>
          </div>
          {sendOpen && canEdit && (
            <div className="space-y-2 border-b border-slate-800 bg-steel-900/60 p-3 text-xs">
              {!detail.shared ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-300">Харилцагч нэвтрэхгүйгээр нээж, хэвлэж, Excel татах холбоос үүсгэнэ. Өртөг харагдахгүй.</span>
                  <button className="btn-primary text-xs px-3 py-1" disabled={!detail.isActive} onClick={() => void makeLink()}>
                    Холбоос үүсгэх
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="flex-1 min-w-[260px] font-mono" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                    <button className="btn-ghost text-xs px-3 py-1" onClick={() => void copyLink()}>
                      Хуулах (Viber / SMS)
                    </button>
                    <a className="btn-ghost text-xs px-3 py-1" href={detail.publicPath ?? '#'} target="_blank" rel="noreferrer">
                      Нээж харах
                    </a>
                    <button className="btn-ghost text-xs px-3 py-1 text-red-300" onClick={() => void revokeLink()}>
                      Холбоосыг хаах
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="w-64" type="email" placeholder="харилцагчийн и-мэйл" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <button className="btn-ghost text-xs px-3 py-1" disabled={!email.includes('@')} onClick={emailLink}>
                      И-мэйлээр илгээх
                    </button>
                    <span className="text-slate-500">Үнэ өөрчлөхөд холбоос дээр шууд шинэчлэгдэнэ.</span>
                  </div>
                </>
              )}
            </div>
          )}
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <th className="p-2">Код</th>
                <th>Бараа</th>
                <th className="text-right">Жижиглэн</th>
                <th className="text-right">Сүүлийн өртөг</th>
                <th className="text-right pr-3">Энэ жагсаалтын үнэ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const value = draft[r.productId] ?? '';
                const changed = value.trim() !== (r.listPriceMnt === null ? '' : String(r.listPriceMnt));
                return (
                  <tr key={r.productId} className="border-t border-slate-800">
                    <td className="p-2 font-mono text-[11px] text-slate-400">{r.sku}</td>
                    <td>
                      {r.nameMn} <span className="text-xs text-slate-500">{r.unit}</span>
                    </td>
                    <td className="text-right">{tugrik(r.retailMnt)}</td>
                    <td className="text-right text-slate-400">{r.lastCostMnt === null ? '—' : tugrik(r.lastCostMnt)}</td>
                    <td className="text-right pr-3">
                      <input
                        className={`w-32 text-right ${changed ? 'border-amber-500' : ''}`}
                        type="number"
                        min={0}
                        step={1}
                        placeholder="жижиглэн"
                        value={value}
                        onChange={(e) => setDraft({ ...draft, [r.productId]: e.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {ready && lists.length === 0 && (
        <div className="card max-w-3xl space-y-3">
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
