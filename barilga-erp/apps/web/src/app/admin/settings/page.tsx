'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, apiUpload, mediaUrl } from '@/lib/api';
import { CATEGORY_MAX_LENGTH, UNIT_MAX_LENGTH, categoryLabel, categoryProblem, saveCategories, saveUnits, unitLabel } from '@/lib/catalog';
import { homeForRole } from '@/lib/rbac';
import { AuthUser, CompanySettings } from '@/lib/types';

type Bank = CompanySettings['bankAccounts'][number];

const EMPTY: Omit<CompanySettings, 'configured'> = {
  name: '',
  regNumber: '',
  address: '',
  phone: '',
  email: '',
  bankAccounts: [],
  invoiceNote: '',
  receiptFooter: '',
  logoUrl: '',
  watermark: true,
};

export default function AdminSettingsPage() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (me.role !== 'ADMIN') {
      router.replace(homeForRole(me.role));
      return;
    }
    api<CompanySettings>('/settings/company')
      .then(({ configured: _configured, ...rest }) => setForm(rest))
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }))
      .finally(() => setLoading(false));
  }, [router]);

  const setBank = (idx: number, patch: Partial<Bank>) =>
    setForm({ ...form, bankAccounts: form.bankAccounts.map((b, i) => (i === idx ? { ...b, ...patch } : b)) });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<CompanySettings>('/settings/company', {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          logoUrl: undefined, // changed only by the upload below
          bankAccounts: form.bankAccounts
            .filter((b) => b.bankName.trim() || b.accountNumber.trim())
            .map((b) => ({ ...b, accountName: b.accountName || undefined })),
        }),
      });
      const { configured: _configured, ...rest } = saved;
      setForm(rest);
      setMessage({ ok: true, text: 'Хадгалагдлаа. Нэхэмжлэх, баримт дээр шууд гарна.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    try {
      const { configured: _c, ...rest } = await apiUpload<CompanySettings>('/settings/company/logo', file);
      setForm(rest);
      setMessage({ ok: true, text: 'Лого хадгалагдлаа. Нэхэмжлэх, баримтын ард усан тэмдэг болж гарна.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Лого оруулж чадсангүй' });
    }
  }

  async function removeLogo() {
    try {
      const { configured: _c, ...rest } = await api<CompanySettings>('/settings/company/logo', { method: 'DELETE' });
      setForm(rest);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Устгаж чадсангүй' });
    }
  }

  const field = (key: 'name' | 'regNumber' | 'address' | 'phone' | 'email', label: string, required = false) => (
    <label className="block text-xs text-slate-400">
      {label}
      <input
        className="mt-1 w-full"
        type={key === 'phone' ? 'tel' : key === 'email' ? 'email' : 'text'}
        inputMode={key === 'regNumber' ? 'numeric' : undefined}
        required={required}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Админ</p>
        <h2 className="text-xl font-bold">Компанийн мэдээлэл</h2>
        <p className="text-slate-400 text-sm mt-1">Нэхэмжлэх болон борлуулалтын баримт дээр хэвлэгдэнэ.</p>
      </div>
      {loading ? (
        <p className="text-slate-500">Уншиж байна…</p>
      ) : (
        <form onSubmit={save} className="card max-w-2xl space-y-3">
          {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', 'Компанийн нэр', true)}
            {field('regNumber', 'Регистрийн дугаар (РД)')}
            {field('phone', 'Утас')}
            {field('email', 'Имэйл')}
          </div>
          {field('address', 'Хаяг')}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400">Банкны данс (нэхэмжлэх дээр)</p>
              <button
                type="button"
                className="btn-ghost text-xs px-2 py-1"
                disabled={form.bankAccounts.length >= 6}
                onClick={() => setForm({ ...form, bankAccounts: [...form.bankAccounts, { bankName: '', accountNumber: '', accountName: '' }] })}
              >
                + Данс нэмэх
              </button>
            </div>
            {form.bankAccounts.map((b, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_auto] gap-2 rounded border border-slate-800 p-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:border-0 sm:p-0"
              >
                <input placeholder="Банк" aria-label="Банк" value={b.bankName} onChange={(e) => setBank(idx, { bankName: e.target.value })} />
                <button
                  type="button"
                  className="btn-ghost h-10 w-10 p-0 text-xs sm:order-last"
                  aria-label="Дансыг хасах"
                  onClick={() => setForm({ ...form, bankAccounts: form.bankAccounts.filter((_, i) => i !== idx) })}
                >
                  ✕
                </button>
                <input
                  placeholder="Дансны дугаар"
                  aria-label="Дансны дугаар"
                  className="col-span-2 font-mono sm:col-span-1"
                  inputMode="numeric"
                  value={b.accountNumber}
                  onChange={(e) => setBank(idx, { accountNumber: e.target.value })}
                />
                <input
                  placeholder="Эзэмшигч"
                  aria-label="Эзэмшигч"
                  className="col-span-2 sm:col-span-1"
                  value={b.accountName}
                  onChange={(e) => setBank(idx, { accountName: e.target.value })}
                />
              </div>
            ))}
          </div>

          <label className="block text-xs text-slate-400">
            Нэхэмжлэхийн доод тэмдэглэл (төлбөрийн нөхцөл г.м.)
            <textarea className="mt-1 w-full" rows={3} value={form.invoiceNote} onChange={(e) => setForm({ ...form, invoiceNote: e.target.value })} />
          </label>
          <fieldset className="rounded border border-slate-700 p-3 text-xs text-slate-400">
            <legend className="px-1">Компанийн лого</legend>
            <div className="flex flex-wrap items-center gap-4">
              {form.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl(form.logoUrl) ?? ''} alt="Лого" className="h-16 w-auto rounded bg-white p-1" />
              ) : (
                <span className="text-slate-500">Лого оруулаагүй</span>
              )}
              <label className="btn-ghost cursor-pointer text-xs">
                {form.logoUrl ? 'Солих' : 'Лого оруулах'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void uploadLogo(e.target.files?.[0])} />
              </label>
              {form.logoUrl && (
                <button type="button" className="btn-ghost text-xs" onClick={() => void removeLogo()}>
                  Устгах
                </button>
              )}
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={form.watermark !== false} onChange={(e) => setForm({ ...form, watermark: e.target.checked })} />
              Нэхэмжлэх, баримтын ард усан тэмдэг (watermark) болгож хэвлэх
            </label>
            <p className="mt-1 text-[11px] text-slate-500">Тунгалаг дэвсгэртэй PNG хамгийн гоё харагдана (2MB хүртэл). Тохиргоог «Хадгалах» дарж хадгална.</p>
          </fieldset>
          <label className="block text-xs text-slate-400">
            Баримтын доод бичиг (буцаалтын нөхцөл г.м.)
            <textarea className="mt-1 w-full" rows={2} value={form.receiptFooter} onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })} />
          </label>
          <div className="flex justify-end">
            <button className="btn-primary" disabled={saving}>
              {saving ? 'Хадгалж байна…' : 'Хадгалах'}
            </button>
          </div>
        </form>
      )}
      <PrintSettingsForm />
      <UnitsForm />
      <CategoriesForm />
      <p className="mt-6 max-w-2xl text-sm text-slate-400">
        Баримтын гарчиг, нэмэлт текст, гарын үсгийг <a className="text-amber-brand hover:underline" href="/admin/documents">«Баримтын загвар»</a> хуудсанд тохируулна.
      </p>
    </Shell>
  );
}

type Layout = { paper: 'A4' | 'A5' | '80MM'; orientation: 'portrait' | 'landscape'; copies: number };
type PrintDoc = 'invoice' | 'receipt' | 'issueNote' | 'picklist';
const PRINT_DOCS: Array<[PrintDoc, string]> = [
  ['invoice', 'Нэхэмжлэх'],
  ['receipt', 'Борлуулалтын баримт'],
  ['issueNote', 'Зарлагын баримт'],
  ['picklist', 'Бэлтгэх хуудас'],
];

/** Paper size, orientation and copies per document — set once, used by every print button. */
function PrintSettingsForm() {
  const [layouts, setLayouts] = useState<Record<PrintDoc, Layout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Record<PrintDoc, Layout>>('/settings/print')
      .then(setLayouts)
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, []);

  const set = (doc: PrintDoc, patch: Partial<Layout>) => layouts && setLayouts({ ...layouts, [doc]: { ...layouts[doc], ...patch } });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      setLayouts(await api<Record<PrintDoc, Layout>>('/settings/print', { method: 'PUT', body: JSON.stringify(layouts) }));
      setMessage({ ok: true, text: 'Хадгалагдлаа. Хэвлэх бүрт дахин сонгох шаардлагагүй.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  if (!layouts) return null;
  return (
    <form onSubmit={save} className="card max-w-2xl space-y-3 mt-6">
      <div>
        <h3 className="font-semibold">Хэвлэх тохиргоо</h3>
        <p className="text-xs text-slate-400">
          Баримт бүрийн цаасны хэмжээ, чиглэл, хувь тоо. 3 давхар (хуулбартай) цаасанд хэвлэх бол 1 хувь сонгоно.
        </p>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
      <div className="table-scroll">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <th className="py-1">Баримт</th>
              <th>Цаас</th>
              <th>Чиглэл</th>
              <th>Хувь</th>
            </tr>
          </thead>
          <tbody>
            {PRINT_DOCS.map(([doc, label]) => (
              <tr key={doc} className="border-t border-slate-800">
                <td className="py-2">{label}</td>
                <td>
                  <select value={layouts[doc].paper} onChange={(e) => set(doc, { paper: e.target.value as Layout['paper'] })}>
                    <option value="A4">A4</option>
                    <option value="A5">A5</option>
                    <option value="80MM">80мм (касс)</option>
                  </select>
                </td>
                <td>
                  <select
                    value={layouts[doc].orientation}
                    disabled={layouts[doc].paper === '80MM'}
                    onChange={(e) => set(doc, { orientation: e.target.value as Layout['orientation'] })}
                  >
                    <option value="portrait">Босоо</option>
                    <option value="landscape">Хэвтээ</option>
                  </select>
                </td>
                <td>
                  <select value={layouts[doc].copies} onChange={(e) => set(doc, { copies: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={saving}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </form>
  );
}

/**
 * Хэмжих нэгж: the units offered in the product form, in the order shown there. Removing one only takes it
 * out of the choices — products keep the unit they were saved with (and such a unit stays at the end).
 */
function UnitsForm() {
  const [units, setUnits] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  // Written on products but not on the list (older English units): still offered in the product form.
  const [inUse, setInUse] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ units: string[]; inUse?: string[] }>('/settings/units')
      .then((r) => {
        setUnits(r.units);
        setSaved(r.units);
        setInUse(r.inUse ?? []);
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, []);

  if (!units) return message ? <p className="mt-6 max-w-2xl text-sm text-red-400">{message.text}</p> : null;

  const changed = JSON.stringify(units) !== JSON.stringify(saved);

  function add(e: FormEvent) {
    e.preventDefault();
    if (!units) return;
    const unit = draft.trim();
    if (!unit) return;
    if (unit.length > UNIT_MAX_LENGTH) return setMessage({ ok: false, text: `Нэгж ${UNIT_MAX_LENGTH} тэмдэгтээс ихгүй байна` });
    if (units.some((u) => u.toLowerCase() === unit.toLowerCase())) return setMessage({ ok: false, text: `«${unit}» жагсаалтад байна` });
    setUnits([...units, unit]);
    setDraft('');
    setMessage(null);
  }

  function move(idx: number, by: -1 | 1) {
    if (!units) return;
    const to = idx + by;
    if (to < 0 || to >= units.length) return;
    const next = [...units];
    [next[idx], next[to]] = [next[to], next[idx]];
    setUnits(next);
  }

  async function save() {
    if (!units) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await saveUnits(units);
      // A unit removed from the list that products still carry stays offered in the product form.
      const kept = res.inUse.filter((u) => saved.includes(u) && !res.units.includes(u));
      setUnits(res.units);
      setSaved(res.units);
      setInUse(res.inUse);
      setMessage({
        ok: true,
        text: kept.length
          ? `Хадгалагдлаа. ${kept.join(', ')} нэгжтэй бараа байгаа тул бараа бүртгэх цонхонд сонголт хэвээр харагдана.`
          : 'Хадгалагдлаа. Бараа бүртгэх цонхонд шууд харагдана.',
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card mt-6 max-w-2xl space-y-3">
      <div>
        <h3 className="font-semibold">Хэмжих нэгж</h3>
        <p className="text-xs text-slate-400">
          Бараа бүртгэх, орлого авах цонхны «Хэмжих нэгж» сонголт. Дээрээс доош энэ дарааллаар харагдана (↑ ↓-аар зөөнө).
        </p>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
      <ol className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {units.map((u, idx) => (
          <li key={u} className="flex items-center gap-2 px-2 py-1">
            <span className="w-6 text-right text-xs text-slate-500">{idx + 1}.</span>
            <span className="min-w-0 flex-1 break-words">
              {u}
              {unitLabel(u) !== u && <span className="ml-1 text-xs text-slate-500">= {unitLabel(u)}</span>}
            </span>
            <button type="button" className="btn-ghost h-9 w-9 p-0" aria-label={`${u}: дээш`} disabled={idx === 0} onClick={() => move(idx, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="btn-ghost h-9 w-9 p-0"
              aria-label={`${u}: доош`}
              disabled={idx === units.length - 1}
              onClick={() => move(idx, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn-ghost h-9 w-9 p-0 text-red-300"
              aria-label={`${u}: хасах`}
              onClick={() => setUnits(units.filter((_, i) => i !== idx))}
            >
              ✕
            </button>
          </li>
        ))}
        {units.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Жагсаалт хоосон.</li>}
      </ol>
      {inUse.length > 0 && (
        <p className="text-xs text-slate-500">
          Жагсаалтад байхгүй ч бараанд бичигдсэн: {inUse.map((u) => (unitLabel(u) !== u ? `${u} (${unitLabel(u)})` : u)).join(', ')} — бараа бүртгэх цонхонд сонголт хэвээр харагдана.
        </p>
      )}
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1"
          placeholder="Шинэ нэгж (жишээ: рулон, боодол)"
          aria-label="Шинэ нэгж"
          maxLength={UNIT_MAX_LENGTH}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn-ghost" disabled={!draft.trim()}>
          + Нэмэх
        </button>
      </form>
      <p className="text-[11px] text-slate-500">
        Нэгжийг хассан ч одоо байгаа бараанд бичигдсэн нэгж өөрчлөгдөхгүй; бараа бүртгэх цонхонд сонголт хэвээр харагдана.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {changed && <span className="mr-auto text-xs text-amber-300">Хадгалаагүй өөрчлөлт байна</span>}
        {changed && (
          <button type="button" className="btn-ghost" disabled={saving} onClick={() => setUnits(saved)}>
            Буцаах
          </button>
        )}
        <button type="button" className="btn-primary" disabled={saving || !changed || units.length === 0} onClick={() => void save()}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </section>
  );
}

/**
 * Барааны ангилал: the categories offered in the product form, in the order shown there. Removing one only takes
 * it out of the choices — products keep the category they were saved with (and such a category stays at the end).
 */
function CategoriesForm() {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  // Written on products but not on the list: still offered in the product form, not part of this list.
  const [inUse, setInUse] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ categories: string[]; inUse?: string[] }>('/settings/categories')
      .then((r) => {
        setCategories(r.categories);
        setSaved(r.categories);
        setInUse(r.inUse ?? []);
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, []);

  if (!categories) return message ? <p className="mt-6 max-w-2xl text-sm text-red-400">{message.text}</p> : null;

  const changed = JSON.stringify(categories) !== JSON.stringify(saved);

  function add(e: FormEvent) {
    e.preventDefault();
    if (!categories) return;
    const name = draft.trim();
    if (!name) return;
    const problem = categoryProblem(name);
    if (problem) return setMessage({ ok: false, text: problem });
    if (categories.some((c) => c.toLowerCase() === name.toLowerCase() || categoryLabel(c).toLowerCase() === name.toLowerCase())) {
      return setMessage({ ok: false, text: `«${name}» жагсаалтад байна` });
    }
    setCategories([...categories, name]);
    setDraft('');
    setMessage(null);
  }

  function move(idx: number, by: -1 | 1) {
    if (!categories) return;
    const to = idx + by;
    if (to < 0 || to >= categories.length) return;
    const next = [...categories];
    [next[idx], next[to]] = [next[to], next[idx]];
    setCategories(next);
  }

  async function save() {
    if (!categories) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await saveCategories(categories);
      // A category removed from the list that products still carry stays offered in the product form.
      const kept = res.inUse.filter((c) => saved.includes(c) && !res.categories.includes(c));
      setCategories(res.categories);
      setSaved(res.categories);
      setInUse(res.inUse);
      setMessage({
        ok: true,
        text: kept.length
          ? `Хадгалагдлаа. ${kept.map((c) => categoryLabel(c)).join(', ')} ангилалтай бараа байгаа тул бараа бүртгэх цонхонд сонголт хэвээр харагдана.`
          : 'Хадгалагдлаа. Бараа бүртгэх цонхонд шууд харагдана.',
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card mt-6 max-w-2xl space-y-3">
      <div>
        <h3 className="font-semibold">Барааны ангилал</h3>
        <p className="text-xs text-slate-400">
          Бараа бүртгэх, орлого авах цонхны «Ангилал» сонголт; үнийн жагсаалт, тайлан үүгээр бүлэглэнэ. Дээрээс доош энэ дарааллаар харагдана (↑ ↓-аар зөөнө).
        </p>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
      <ol className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {categories.map((c, idx) => (
          <li key={c} className="flex items-center gap-2 px-2 py-1">
            <span className="w-6 text-right text-xs text-slate-500">{idx + 1}.</span>
            <span className="min-w-0 flex-1 break-words">
              {c}
              {categoryLabel(c) !== c && <span className="ml-1 text-xs text-slate-500">= {categoryLabel(c)}</span>}
            </span>
            <button type="button" className="btn-ghost h-9 w-9 p-0" aria-label={`${c}: дээш`} disabled={idx === 0} onClick={() => move(idx, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="btn-ghost h-9 w-9 p-0"
              aria-label={`${c}: доош`}
              disabled={idx === categories.length - 1}
              onClick={() => move(idx, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn-ghost h-9 w-9 p-0 text-red-300"
              aria-label={`${c}: хасах`}
              onClick={() => setCategories(categories.filter((_, i) => i !== idx))}
            >
              ✕
            </button>
          </li>
        ))}
        {categories.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Жагсаалт хоосон.</li>}
      </ol>
      {inUse.length > 0 && (
        <p className="text-xs text-slate-500">
          Жагсаалтад байхгүй ч бараанд бичигдсэн: {inUse.map((c) => categoryLabel(c)).join(', ')} — бараа бүртгэх цонхонд сонголт хэвээр харагдана.
        </p>
      )}
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1"
          placeholder="Шинэ ангилал (жишээ: Шал, Дээврийн материал)"
          aria-label="Шинэ ангилал"
          maxLength={CATEGORY_MAX_LENGTH}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn-ghost" disabled={!draft.trim()}>
          + Нэмэх
        </button>
      </form>
      <p className="text-[11px] text-slate-500">
        Ангиллыг хассан ч одоо байгаа бараанд бичигдсэн ангилал өөрчлөгдөхгүй; бараа бүртгэх цонхонд сонголт хэвээр харагдана.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {changed && <span className="mr-auto text-xs text-amber-300">Хадгалаагүй өөрчлөлт байна</span>}
        {changed && (
          <button type="button" className="btn-ghost" disabled={saving} onClick={() => setCategories(saved)}>
            Буцаах
          </button>
        )}
        <button type="button" className="btn-primary" disabled={saving || !changed || categories.length === 0} onClick={() => void save()}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </section>
  );
}
