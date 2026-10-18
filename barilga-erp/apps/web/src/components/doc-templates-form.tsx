'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { DocTemplate, PrintDocKey } from '@/lib/types';

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
export function DocTemplatesForm() {
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
