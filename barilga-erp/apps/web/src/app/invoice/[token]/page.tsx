'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { InvoiceDoc, InvoiceDocOrder, paymentReference } from '@/components/invoice-doc';
import { publicApi, tugrik } from '@/lib/api';
import type { CompanySettings, DocTemplate, InvoiceState } from '@/lib/types';

type PublicInvoice = {
  invoiceNumber: string;
  createdAt: string;
  dueDate: string | null;
  note: string | null;
  paidMnt: number;
  owedMnt: number;
  state: InvoiceState;
  company: CompanySettings;
  template?: DocTemplate;
  order: InvoiceDocOrder;
};

const STATE_TEXT: Partial<Record<InvoiceState, string>> = {
  PAID: 'Төлөгдсөн. Баярлалаа!',
  PARTIAL: 'Хэсэгчлэн төлөгдсөн',
  OVERDUE: 'Төлөх хугацаа хэтэрсэн',
};

const day = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/**
 * What the buyer opens from the link we sent: on a phone first how much, to which account, with what transfer
 * description and by when; then the invoice itself, ready to print or save as PDF. No login.
 */
export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [inv, setInv] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    publicApi<PublicInvoice>(`/public/invoices/${encodeURIComponent(token)}`)
      .then((row) => {
        setInv(row);
        // The saved PDF is named after the page title.
        document.title = `Нэхэмжлэх ${row.invoiceNumber}`;
      })
      .catch(() => setError('Нэхэмжлэх олдсонгүй эсвэл цуцлагдсан байна.'));
  }, [token]);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(''), 2500);
    } catch {
      window.prompt('Хуулж авна уу:', text);
    }
  }

  if (error) return <p className="min-h-screen bg-white p-8 text-center text-slate-600">{error}</p>;
  if (!inv) return <p className="min-h-screen bg-white p-8 text-center text-slate-500">Уншиж байна…</p>;

  const reference = paymentReference(inv, inv.order);
  const owing = inv.state !== 'PAID' && inv.owedMnt > 0;
  const copyBtn = 'min-h-[36px] shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 active:bg-slate-100';

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 px-4 py-3 text-sm backdrop-blur">
        <div className="mx-auto flex max-w-[190mm] flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="min-h-[44px] w-full rounded-lg bg-slate-900 px-5 font-semibold text-white active:bg-slate-700 sm:w-auto"
            onClick={() => window.print()}
          >
            🖨 Хэвлэх / PDF хадгалах
          </button>
          <span className={inv.state === 'PAID' ? 'text-emerald-700' : inv.state === 'OVERDUE' ? 'text-red-700' : 'text-slate-600'}>
            {STATE_TEXT[inv.state] ?? `Төлөх дүн: ${tugrik(inv.owedMnt)}`}
          </span>
        </div>
        <p className="mx-auto mt-1 max-w-[190mm] text-[11px] text-slate-500">PDF болгох: «Хэвлэх» дараад принтерийн оронд «PDF болгон хадгалах / Save as PDF»-ийг сонгоно.</p>
      </div>

      {owing && (
        <div className="no-print mx-auto max-w-[190mm] px-4 pt-4">
          <div className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-4 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p>
                Төлөх дүн: <b className="text-2xl">{tugrik(inv.owedMnt)}</b>
              </p>
              {inv.dueDate && (
                <p className={inv.state === 'OVERDUE' ? 'text-red-700' : ''}>
                  Төлөх хугацаа: <b>{day(inv.dueDate)}</b>
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2">
              <p className="min-w-0">
                <span className="block text-xs text-slate-600">Гүйлгээний утга (заавал бичнэ)</span>
                <b className="break-all font-mono text-base">{reference}</b>
              </p>
              <button type="button" className={copyBtn} onClick={() => void copy(reference, 'ref')}>
                {copied === 'ref' ? 'Хуулсан ✓' : 'Хуулах'}
              </button>
            </div>
            {inv.company.bankAccounts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-slate-600">Шилжүүлэх данс — {inv.company.name}</p>
                {inv.company.bankAccounts.map((b) => (
                  <div key={b.accountNumber} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <p className="min-w-0">
                      <span className="block text-xs text-slate-600">
                        {b.bankName}
                        {b.accountName ? ` · ${b.accountName}` : ''}
                      </span>
                      <b className="break-all font-mono">{b.accountNumber}</b>
                    </p>
                    <button type="button" className={copyBtn} onClick={() => void copy(b.accountNumber, b.accountNumber)}>
                      {copied === b.accountNumber ? 'Хуулсан ✓' : 'Хуулах'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <section className="mx-auto max-w-[190mm] px-4 py-6">
        <InvoiceDoc order={inv.order} company={inv.company} invoice={inv} template={inv.template} />
      </section>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          @page { size: A4 portrait; margin: 12mm; }
        }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
        .print-doc thead { display: table-header-group; }
        .print-doc tr { break-inside: avoid; page-break-inside: avoid; }
        .print-doc .doc-keep { break-inside: avoid; page-break-inside: avoid; }
      `}</style>
    </div>
  );
}
