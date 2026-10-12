'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES, POS_ROLES } from '@/lib/rbac';
import { AccountPanel } from '@/components/account-panel';
import { useFeatures } from '@/lib/features';
import { AuthUser, Customer, CustomerDetail, CustomerType, PriceList } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };

const TYPE_LABEL: Record<CustomerType, string> = { INDIVIDUAL: 'Хувь хүн', COMPANY: 'Байгууллага' };
const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Төлбөр хүлээж буй',
  READY_FOR_LOADING: 'Ачихад бэлэн',
  COMPLETED: 'Дууссан',
  CANCELLED: 'Цуцалсан',
};

const emptyForm = {
  type: 'INDIVIDUAL' as CustomerType,
  name: '',
  phone: '',
  regNumber: '',
  email: '',
  address: '',
  notes: '',
  priceListId: '',
  buysFromUs: true,
  creditAllowed: false,
  sellsToUs: false,
  barterContract: '',
};

export default function CustomersPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const isOversight = hasRole(me?.role, OVERSIGHT_ROLES);
  const features = useFeatures();
  const pricing = features.enabled('PRICE_LISTS');
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);

  useEffect(() => {
    if (me && pricing) void api<PriceList[]>('/price-lists').then(setPriceLists).catch(() => setPriceLists([]));
  }, [me, pricing]);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (showInactive) params.set('all', 'true');
      setRows(await api<Customer[]>(`/customers?${params}`));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, [q, showInactive, flash]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const user = JSON.parse(raw) as AuthUser;
    if (!hasRole(user.role, POS_ROLES)) {
      router.replace(homeForRole(user.role));
      return;
    }
    setMe(user);
  }, [router]);

  useEffect(() => {
    if (!me) return;
    const handle = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(handle);
  }, [me, load]);

  // Opened from a report (?focus=<id>): show that customer straight away.
  useEffect(() => {
    if (!me) return;
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (focus) void api<CustomerDetail>(`/customers/${focus}`).then(setDetail).catch(() => undefined);
  }, [me]);

  async function openDetail(c: Customer) {
    try {
      setDetail(await api<CustomerDetail>(`/customers/${c.id}`));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    }
  }

  function openCreate() {
    setForm(emptyForm);
    setFormError('');
    setModal('create');
  }

  function openEdit(c: Customer) {
    setForm({
      type: c.type,
      name: c.name,
      phone: c.phone,
      regNumber: c.regNumber ?? '',
      email: c.email ?? '',
      address: c.address ?? '',
      notes: c.notes ?? '',
      priceListId: c.priceListId ?? '',
      buysFromUs: c.buysFromUs ?? true,
      creditAllowed: c.creditAllowed ?? false,
      sellsToUs: c.sellsToUs ?? false,
      barterContract: c.barterContract ?? '',
    });
    setFormError('');
    setModal('edit');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    // On edit an emptied field is sent as null so it is cleared; on create it is simply left out.
    const empty = modal === 'edit' ? null : undefined;
    const body = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      regNumber: form.regNumber.trim() || empty,
      email: form.email.trim() || empty,
      address: form.address.trim() || empty,
      notes: form.notes.trim() || empty,
      // Only managers/admin decide who buys at cost or barter prices.
      ...(isOversight && pricing ? { priceListId: form.priceListId || empty } : {}),
      // What the partner is to us: managers/admin only.
      ...(isOversight
        ? {
            buysFromUs: form.buysFromUs,
            creditAllowed: form.creditAllowed,
            sellsToUs: form.sellsToUs,
            barterContract: form.barterContract.trim() || empty,
          }
        : {}),
    };
    try {
      if (modal === 'create') {
        await api('/customers', { method: 'POST', body: JSON.stringify({ type: form.type, ...body }) });
        flash('ok', `${body.name} бүртгэгдлээ`);
      } else if (detail) {
        const updated = await api<Customer>(`/customers/${detail.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setDetail({ ...detail, ...updated });
        flash('ok', 'Хадгалагдлаа');
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c: CustomerDetail) {
    try {
      const updated = await api<Customer>(`/customers/${c.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !c.isActive }) });
      setDetail({ ...c, ...updated });
      flash('ok', updated.isActive ? 'Идэвхжлээ' : 'Идэвхгүй боллоо');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    }
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Борлуулалт</p>
          <h2 className="text-xl font-bold">Харилцагчид</h2>
          <p className="text-slate-400 text-sm mt-1">Хувь хүн болон байгууллага. ПОС дээр захиалгад холбож болно.</p>
        </div>
        <button className="btn-primary" onClick={openCreate}>
          Харилцагч нэмэх
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input className="w-80" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Нэр, утас, РД-ээр хайх…" />
        <label className="text-sm text-slate-400 flex items-center gap-2">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Идэвхгүйг харуулах
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="card overflow-auto p-0">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="text-left text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-3">Нэр</th>
                <th>Төрөл</th>
                <th>Утас</th>
                <th>РД</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-slate-800 cursor-pointer hover:bg-steel-800 ${detail?.id === c.id ? 'bg-steel-800' : ''} ${c.isActive ? '' : 'opacity-60'}`}
                  onClick={() => void openDetail(c)}
                >
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="text-slate-300">{TYPE_LABEL[c.type]}</td>
                  <td className="text-slate-300">{c.phone}</td>
                  <td className="font-mono text-xs text-slate-400">{c.regNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
          {!loading && rows.length === 0 && <p className="p-3 text-slate-500">Харилцагч олдсонгүй.</p>}
        </div>

        <aside className="card h-fit">
          {!detail ? (
            <p className="text-slate-500 text-sm">Дэлгэрэнгүйг харахын тулд харилцагч сонгоно уу.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-slate-400">{TYPE_LABEL[detail.type]}</p>
                <h3 className="text-lg font-semibold">{detail.name}</h3>
                <p className="text-sm text-slate-300">
                  {detail.phone}
                  {detail.regNumber && <span className="font-mono text-xs text-slate-400"> · РД {detail.regNumber}</span>}
                </p>
                {detail.email && <p className="text-sm text-slate-400">{detail.email}</p>}
                {detail.address && <p className="text-sm text-slate-400">{detail.address}</p>}
                {detail.notes && <p className="text-xs text-slate-500 mt-1">{detail.notes}</p>}
                <div className="flex flex-wrap gap-1 mt-1">
                  {detail.buysFromUs !== false && <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px]">Бараа авдаг</span>}
                  {detail.creditAllowed && <span className="rounded-full border border-amber-600 px-2 py-0.5 text-[11px] text-amber-200">Зарлагаар авах эрхтэй</span>}
                  {detail.sellsToUs && <span className="rounded-full border border-sky-600 px-2 py-0.5 text-[11px] text-sky-200">Нийлүүлэгч</span>}
                  {detail.barterContract && <span className="rounded-full border border-emerald-600 px-2 py-0.5 text-[11px] text-emerald-200">Бартер: {detail.barterContract}</span>}
                </div>
                {pricing && (
                  <p className="text-xs mt-1">
                    Үнэ: <span className="text-emerald-300">{detail.priceList?.name ?? 'Жижиглэн үнэ'}</span>
                  </p>
                )}
              </div>
              {detail.credit && detail.credit.owedMnt > 0 && (
                <div className="rounded-lg border border-amber-700/60 p-3">
                  <p className="text-[10px] uppercase text-slate-400">Өр (зарлагаар олгосон)</p>
                  <p className="text-lg font-bold text-amber-300">{tugrik(detail.credit.owedMnt)}</p>
                  <ul className="mt-1 text-sm divide-y divide-slate-800">
                    {detail.credit.orders.map((o) => (
                      <li key={o.orderId} className="py-1 flex justify-between gap-2">
                        <Link href={`/orders/${o.orderId}`} className="font-mono text-xs text-amber-300 hover:underline">
                          {o.orderNumber}
                        </Link>
                        <span className="text-xs text-slate-400">{new Date(o.createdAt).toLocaleDateString('mn-MN')}</span>
                        <span className="font-medium">{tugrik(o.owedMnt)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-slate-500 mt-1">Төлбөрийг захиалгын хуудаснаас бүртгэнэ.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <article className="rounded-lg border border-slate-700 p-3">
                  <p className="text-[10px] uppercase text-slate-400">Дууссан захиалга</p>
                  <p className="text-lg font-bold">{detail.stats.completedOrders}</p>
                </article>
                <article className="rounded-lg border border-slate-700 p-3">
                  <p className="text-[10px] uppercase text-slate-400">Нийт худалдан авалт</p>
                  <p className="text-lg font-bold text-amber-brand">{tugrik(detail.stats.completedTotalMnt)}</p>
                </article>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Сүүлийн захиалгууд</p>
                {detail.recentOrders.length === 0 ? (
                  <p className="text-sm text-slate-500">Захиалга алга.</p>
                ) : (
                  <ul className="divide-y divide-slate-800 text-sm">
                    {detail.recentOrders.map((o) => (
                      <li key={o.id} className="py-1.5 flex justify-between gap-2">
                        <Link href={`/orders/${o.id}`} className="font-mono text-xs text-amber-300 hover:underline">
                          {o.orderNumber}
                        </Link>
                        <span className="text-xs text-slate-400">{STATUS_LABEL[o.status] ?? o.status}</span>
                        <span className="font-medium">{tugrik(o.totalMnt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <button className="btn-ghost text-xs px-3 py-1" onClick={() => openEdit(detail)}>
                  Засах
                </button>
                {isOversight && (
                  <button
                    className={`${detail.isActive ? 'btn-danger' : 'btn-ghost'} text-xs px-3 py-1`}
                    onClick={() => void toggleActive(detail)}
                  >
                    {detail.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}
                  </button>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {detail && features.enabled('PARTNER_ACCOUNTS') && (
        <div className="mt-4">
          <AccountPanel key={detail.id} customerId={detail.id} canManage={isOversight} />
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={save} className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">{modal === 'create' ? 'Харилцагч нэмэх' : 'Харилцагч засах'}</h3>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            {modal === 'create' && (
              <div className="flex gap-2">
                {(['INDIVIDUAL', 'COMPANY'] as CustomerType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm ${form.type === t ? 'bg-amber-brand text-steel-950 font-semibold' : 'btn-ghost'}`}
                    onClick={() => setForm({ ...form, type: t })}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            )}
            <label className="block text-xs text-slate-400">
              {form.type === 'COMPANY' ? 'Байгууллагын нэр' : 'Овог нэр'}
              <input className="mt-1 w-full" required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block text-xs text-slate-400">
              Утас
              <input className="mt-1 w-full" required pattern="[0-9+\-\s]{8,15}" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <label className="block text-xs text-slate-400">
              {form.type === 'COMPANY' ? 'РД (заавал, 7 оронтой)' : 'Регистрийн дугаар (заавал биш, жишээ нь УБ12345678)'}
              <input
                className="mt-1 w-full font-mono"
                required={form.type === 'COMPANY'}
                value={form.regNumber}
                onChange={(e) => setForm({ ...form, regNumber: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Имэйл
              <input className="mt-1 w-full" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label className="block text-xs text-slate-400">
              Хаяг
              <input className="mt-1 w-full" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </label>
            {isOversight && (
              <fieldset className="rounded-lg border border-slate-700 p-2 space-y-1 text-sm">
                <legend className="px-1 text-xs text-slate-400">Харилцагчийн төрөл (менежер)</legend>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.buysFromUs} onChange={(e) => setForm({ ...form, buysFromUs: e.target.checked })} />
                  Манайхаас бараа авдаг
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.creditAllowed} onChange={(e) => setForm({ ...form, creditAllowed: e.target.checked })} />
                  Зарлагаар (дараа төлөхөөр) авах эрхтэй
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.sellsToUs} onChange={(e) => setForm({ ...form, sellsToUs: e.target.checked })} />
                  Манайх түүнээс бараа авдаг (нийлүүлэгч)
                </label>
                <label className="block text-xs text-slate-400">
                  Бартерын гэрээ (дугаар / тайлбар, хоосон бол бартергүй)
                  <input className="mt-1 w-full" value={form.barterContract} onChange={(e) => setForm({ ...form, barterContract: e.target.value })} />
                </label>
              </fieldset>
            )}
            {isOversight && pricing && (
              <label className="block text-xs text-slate-400">
                Үнийн жагсаалт
                <select className="mt-1 w-full" value={form.priceListId} onChange={(e) => setForm({ ...form, priceListId: e.target.value })}>
                  <option value="">Жижиглэн үнэ (энгийн)</option>
                  {priceLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs text-slate-400">
              Тэмдэглэл
              <textarea className="mt-1 w-full" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
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
