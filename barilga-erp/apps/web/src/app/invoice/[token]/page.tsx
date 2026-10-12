'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { InvoiceDoc, InvoiceDocOrder } from '@/components/invoice-doc';
import { publicApi, tugrik } from '@/lib/api';
import type { CompanySettings, InvoiceState } from '@/lib/types';

type PublicInvoice = {
  invoiceNumber: string;
  createdAt: string;
  dueDate: string | null;
  note: string | null;
  paidMnt: number;
  owedMnt: number;
  state: InvoiceState;
  company: CompanySettings;
  order: InvoiceDocOrder;
};

const STATE_TEXT: Partial<Record<InvoiceState, string>> = {
  PAID: 'Төлөгдсөн. Баярлалаа!',
  PARTIAL: 'Хэсэгчлэн төлөгдсөн',
  OVERDUE: 'Төлөх хугацаа хэтэрсэн',
};

/** What the buyer opens from the link we sent: the invoice, ready to print or save as PDF. No login. */
export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [inv, setInv] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    publicApi<PublicInvoice>(`/public/invoices/${encodeURIComponent(token)}`)
      .then(setInv)
      .catch(() => setError('Нэхэмжлэх олдсонгүй эсвэл цуцлагдсан байна.'));
  }, [token]);

  if (error) return <p className="p-8 text-center text-slate-600">{error}</p>;
  if (!inv) return <p className="p-8 text-center text-slate-500">Уншиж байна…</p>;

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm">
        <button className="rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => window.print()}>
          Хэвлэх / PDF хадгалах
        </button>
        <span className={inv.state === 'PAID' ? 'text-emerald-700' : inv.state === 'OVERDUE' ? 'text-red-700' : 'text-slate-600'}>
          {STATE_TEXT[inv.state] ?? `Төлөх дүн: ${tugrik(inv.owedMnt)}`}
        </span>
      </div>
      <section className="mx-auto max-w-[190mm] px-4 py-6">
        <InvoiceDoc order={inv.order} company={inv.company} invoice={inv} />
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
      `}</style>
    </div>
  );
}
