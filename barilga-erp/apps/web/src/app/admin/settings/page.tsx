'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, apiUpload, mediaUrl } from '@/lib/api';
import { homeForRole } from '@/lib/rbac';
import { AuthUser, CompanySettings, DocTemplate, PrintDocKey } from '@/lib/types';

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
        required={required}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Admin</p>
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
            <div className="flex items-center justify-between">
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
              <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                <input placeholder="Банк" value={b.bankName} onChange={(e) => setBank(idx, { bankName: e.target.value })} />
                <input
                  placeholder="Дансны дугаар"
                  className="font-mono"
                  value={b.accountNumber}
                  onChange={(e) => setBank(idx, { accountNumber: e.target.value })}
                />
                <input placeholder="Эзэмшигч" value={b.accountName} onChange={(e) => setBank(idx, { accountName: e.target.value })} />
                <button
                  type="button"
                  className="btn-ghost text-xs px-2"
                  onClick={() => setForm({ ...form, bankAccounts: form.bankAccounts.filter((_, i) => i !== idx) })}
                >
                  ✕
                </button>
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
      <DocTemplatesForm />
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
      <table className="w-full text-sm">
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
      <div className="flex justify-end">
        <button className="btn-primary" disabled={saving}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </form>
  );
}

const TEMPLATE_DOCS: Array<[PrintDocKey, string]> = [
  ['invoice', 'Нэхэмжлэх'],
  ['issueNote', 'Зарлагын баримт'],
  ['receipt', 'Баримт (касс)'],
  ['picklist', 'Бэлтгэх хуудас'],
];

/**
 * Баримтын загвар: per document the heading, extra text, empty lines to fill in by hand and the signature
 * lines. One-off changes are made on the print page itself («Засаад хэвлэх»).
 */
function DocTemplatesForm() {
  const [docs, setDocs] = useState<Record<PrintDocKey, DocTemplate> | null>(null);
  const [doc, setDoc] = useState<PrintDocKey>('invoice');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Record<PrintDocKey, DocTemplate>>('/settings/documents')
      .then(setDocs)
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, []);

  if (!docs) return null;
  const t = docs[doc];
  const set = (patch: Partial<DocTemplate>) => setDocs({ ...docs, [doc]: { ...t, ...patch } });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      setDocs(await api<Record<PrintDocKey, DocTemplate>>('/settings/documents', { method: 'PUT', body: JSON.stringify(docs) }));
      setMessage({ ok: true, text: 'Хадгалагдлаа. Дараагийн хэвлэлтээс эхлэн хэрэглэгдэнэ.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="card mt-6 max-w-2xl space-y-3">
      <div>
        <h3 className="font-semibold">Баримтын загвар</h3>
        <p className="text-xs text-slate-400">
          Гарчиг, нэмэлт текст, гараар бөглөх хоосон мөр, гарын үсэг. Нэг удаагийн өөрчлөлтийг хэвлэх хуудсан дээрх «Засаад хэвлэх»-ээр хийнэ.
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {TEMPLATE_DOCS.map(([d, label]) => (
          <button key={d} type="button" className={d === doc ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setDoc(d)}>
            {label}
          </button>
        ))}
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
      <label className="block text-xs text-slate-400">
        Гарчиг (хоосон бол үндсэн нэр)
        <input className="mt-1 w-full" maxLength={60} value={t.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="block text-xs text-slate-400">
        Гарчгийн доорх текст
        <textarea className="mt-1 w-full" rows={2} maxLength={600} value={t.headerNote} onChange={(e) => set({ headerNote: e.target.value })} />
      </label>
      <label className="block text-xs text-slate-400">
        Доод текст (гарын үсгийн дээр)
        <textarea className="mt-1 w-full" rows={3} maxLength={800} value={t.footerNote} onChange={(e) => set({ footerNote: e.target.value })} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={t.blankBuyer} onChange={(e) => set({ blankBuyer: e.target.checked })} />
          Худалдан авагчийн мэдээллийг хоосон (гараар бөглөх) үлдээх
        </label>
        <label className="text-xs text-slate-400">
          Барааны доор нэмэх хоосон мөр
          <input className="mt-1 block w-24" type="number" min={0} max={20} value={t.blankRows} onChange={(e) => set({ blankRows: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
        </label>
        {doc === 'issueNote' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={t.showPrices} onChange={(e) => set({ showPrices: e.target.checked })} />
            Үнэ, дүн харуулах
          </label>
        )}
        {doc !== 'receipt' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={t.stamp} onChange={(e) => set({ stamp: e.target.checked })} />
            «Тэмдэг» дарах дугуй хүрээ
          </label>
        )}
      </div>
      <label className="block text-xs text-slate-400">
        Гарын үсэг зурах хүмүүс (мөр бүрт нэг, 4 хүртэл)
        <textarea
          className="mt-1 w-full"
          rows={3}
          value={t.signatures.join('\n')}
          onChange={(e) => set({ signatures: e.target.value.split('\n').slice(0, 4) })}
          placeholder={'Нягтлан бодогч\nХүлээн авсан'}
        />
      </label>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={saving}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </form>
  );
}
