'use client';

import { matchesSearch } from '@/lib/translit';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
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
type Detail = { id: string; name: string; notes: string | null; isActive: boolean; products: Row[] };

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
        <form onSubmit={createList} className="flex gap-1 ml-auto">
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
            <button className="btn-ghost text-xs px-3 py-1" onClick={() => void toggleActive()}>
              {detail.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}
            </button>
            <button className="btn-primary text-sm ml-auto" disabled={busy || changes.length === 0} onClick={() => void save()}>
              {busy ? 'Хадгалж байна…' : `Хадгалах${changes.length ? ` (${changes.length})` : ''}`}
            </button>
          </div>
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
      {ready && lists.length === 0 && <p className="text-slate-500">Үнийн жагсаалт алга. Дээрээс нэр өгч үүсгэнэ үү (жишээ нь «Өртгийн үнэ», «Бартерын үнэ»).</p>}
    </Shell>
  );
}
