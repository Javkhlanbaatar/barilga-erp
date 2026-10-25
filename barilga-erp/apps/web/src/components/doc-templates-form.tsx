'use client';

import { useEffect, useMemo, useState } from 'react';
import { DESIGN_CSS, DocDesignProvider } from '@/components/doc-design';
import { InvoiceDoc } from '@/components/invoice-doc';
import { IssueNote, Picklist, Receipt } from '@/components/print-docs';
import { api } from '@/lib/api';
import type { CompanySettings, DocTemplate, Order, PrintDocKey } from '@/lib/types';

const TEMPLATE_DOCS: Array<[PrintDocKey, string]> = [
  ['invoice', 'Нэхэмжлэх'],
  ['issueNote', 'Зарлагын баримт'],
  ['receipt', 'Баримт (касс)'],
  ['picklist', 'Бэлтгэх хуудас'],
];

/** A made-up order so every part of a document is visible while designing. */
const SAMPLE = {
  id: 'sample',
  orderNumber: 'BR-20261018-0001',
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  status: 'COMPLETED',
  customerName: 'Жишээ Барилга ХХК',
  customerPhone: '99112233',
  customerRegNumber: '6123456',
  deliveryAddress: 'СБД, 1-р хороо',
  deliveryMethod: 'SELF_PICKUP',
  deliveryFeeMnt: 0,
  unloadingFeeMnt: 0,
  timeAdjustmentMnt: 0,
  totalMnt: 222_000,
  totalWeightKg: 1_250,
  totalVolumeM3: 1.2,
  vehicleNumber: '1234 УБА',
  driverPhone: '88001122',
  notes: '',
  warehouse: { id: 'w', code: 'MAIN', name: 'Үндсэн дэлгүүр' },
  createdBy: { fullName: 'Кассчин Бат' },
  payments: [
    { id: 'p1', method: 'CASH', provider: 'CASH', status: 'PAID', amountMnt: 122_000 },
    { id: 'p2', method: 'CARD', provider: 'CARD', status: 'PAID', amountMnt: 100_000 },
  ],
  items: [
    { id: 'i1', quantity: 10, unitPrice: 18_500, lineTotal: 185_000, sourceType: 'INTERNAL', pickedAt: null, product: { id: 'a', sku: 'CEM-42.5', nameMn: 'Цемент М400 50кг', unit: 'шуудай', companions: null } },
    { id: 'i2', quantity: 2, unitPrice: 18_500, lineTotal: 37_000, sourceType: 'INTERNAL', pickedAt: null, product: { id: 'b', sku: 'PNT-EP', nameMn: 'Эпокси будаг 5л', unit: 'ш', companions: [{ name: 'Хатаагч', qtyPerUnit: 1, unit: 'ш' }] } },
  ],
} as unknown as Order;

/**
 * Баримтын загвар — WYSIWYG. The document is shown as it prints, filled with an example order. Every part
 * has a small tab: 🔒 parts are always printed; 👁 parts can be clicked off (they stay faded here so they can
 * be clicked back on). Text with a yellow underline is typed straight on the page; signature names are edited,
 * removed (×) or added in place. Nothing changes until «Хадгалах».
 */
export function DocTemplatesForm() {
  const [docs, setDocs] = useState<Record<PrintDocKey, DocTemplate> | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [doc, setDoc] = useState<PrintDocKey>('invoice');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    Promise.all([api<Record<PrintDocKey, DocTemplate>>('/settings/documents'), api<CompanySettings>('/settings/company')])
      .then(([d, c]) => {
        const withHidden = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, hidden: v.hidden ?? [] }])) as Record<PrintDocKey, DocTemplate>;
        setDocs(withHidden);
        setSaved(JSON.stringify(withHidden));
        setCompany(c);
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Ачаалж чадсангүй' }));
  }, []);

  const dirty = useMemo(() => Boolean(docs) && JSON.stringify(docs) !== saved, [docs, saved]);

  if (!docs || !company) return <p className="mt-6 text-slate-500">{message?.text ?? 'Уншиж байна…'}</p>;
  const t = docs[doc];
  const set = (patch: Partial<DocTemplate>) => setDocs({ ...docs, [doc]: { ...t, ...patch } });

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api<Record<PrintDocKey, DocTemplate>>('/settings/documents', { method: 'PUT', body: JSON.stringify(docs) });
      setDocs(next);
      setSaved(JSON.stringify(next));
      setMessage({ ok: true, text: 'Хадгалагдлаа. Дараагийн хэвлэлтээс эхлэн ингэж гарна.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  function showAll() {
    set({ hidden: [] });
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {TEMPLATE_DOCS.map(([d, label]) => (
          <button key={d} type="button" className={d === doc ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setDoc(d)}>
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-300">Хадгалаагүй өөрчлөлттэй</span>}
          <button type="button" className="btn-ghost text-sm" onClick={showAll} title="Хассан бүх хэсгийг буцааж харуулна">
            Бүх хэсгийг харуулах
          </button>
          <button type="button" className="btn-ghost text-sm" disabled={!dirty} onClick={() => setDocs(JSON.parse(saved))}>
            Болих
          </button>
          <button type="button" className="btn-primary text-sm" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Хадгалж байна…' : 'Хадгалах'}
          </button>
        </span>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-400'}`}>{message.text}</p>}
      <p className="text-xs text-slate-400">
        🔒 заавал хэвлэгдэнэ · 👁 дарж хасна · 🚫 хасагдсан (дарж буцааж нэмнэ) · ☐/☑ асаах/унтраах · шар зураастай бичгийг дарж засна ·
        гарын үсгийг × -ээр хасаж, «+» мөрөнд бичээд Enter дарж нэмнэ.
      </p>

      <div className="overflow-auto rounded-xl bg-slate-200 p-6">
        <div
          className="print-doc design mx-auto bg-white p-8 text-black shadow-xl"
          style={{ width: doc === 'receipt' ? '80mm' : '210mm', minHeight: doc === 'receipt' ? undefined : '200mm' }}
        >
          <DocDesignProvider t={t} set={set}>
            {doc === 'invoice' && <InvoiceDoc order={SAMPLE} company={company} />}
            {doc === 'issueNote' && <IssueNote order={SAMPLE} company={company} />}
            {doc === 'receipt' && <Receipt order={SAMPLE} company={company} />}
            {doc === 'picklist' && <Picklist order={SAMPLE} company={company} />}
          </DocDesignProvider>
        </div>
      </div>
      <style>{`
        ${DESIGN_CSS}
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
      `}</style>
    </div>
  );
}
