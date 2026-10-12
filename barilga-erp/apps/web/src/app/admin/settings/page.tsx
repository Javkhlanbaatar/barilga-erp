'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
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
