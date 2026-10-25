'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { SellerBlock, Watermark } from '@/components/invoice-doc';
import { api, tugrik } from '@/lib/api';
import type { CompanySettings, StockReceipt } from '@/lib/types';

const qty = (v: number | string) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });

/** Орлогын баримт: what arrived from the supplier, signed by whoever delivered and whoever received it. */
export default function PrintReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<StockReceipt | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<StockReceipt>(`/inventory/receipts/${id}`), api<CompanySettings>('/settings/company')])
      .then(([rec, c]) => {
        setR(rec);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [id]);

  useEffect(() => {
    if (r && company) {
      const t = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(t);
    }
  }, [r, company]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!r || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;
  const costed = r.items.some((i) => i.unitCostMnt != null);
  const total = r.items.reduce((s, i) => s + Number(i.quantity) * (i.unitCostMnt ?? 0), 0);

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх / PDF
        </button>
      </div>
      <section className="relative mx-auto max-w-[190mm] space-y-4 px-4 py-6 text-sm">
        <Watermark company={company} />
        <div className="flex items-start justify-between gap-6">
          <SellerBlock company={company} />
          <div className="text-right">
            <h1 className="text-xl font-bold tracking-wide">ОРЛОГЫН БАРИМТ</h1>
            <p>№ {r.receiptNumber}</p>
            <p className="text-xs">Огноо: {new Date(r.receivedAt).toLocaleString('mn-MN')}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <p>
            Нийлүүлэгч: <b>{r.supplierName}</b>
            {r.supplierInvoiceNo ? ` · падаан № ${r.supplierInvoiceNo}` : ''}
          </p>
          <p>
            Хүлээн авсан агуулах: <b>{r.warehouse.name}</b>
          </p>
          {r.notes && <p className="col-span-2">Тэмдэглэл: {r.notes}</p>}
        </div>
        <table>
          <thead>
            <tr>
              <th className="w-8">№</th>
              <th>Барааны нэр</th>
              <th>Код</th>
              <th>Нэгж</th>
              <th className="text-right">Тоо</th>
              {costed && <th className="text-right">Нэгж өртөг</th>}
              {costed && <th className="text-right">Дүн</th>}
            </tr>
          </thead>
          <tbody>
            {r.items.map((i, idx) => (
              <tr key={i.id}>
                <td>{idx + 1}</td>
                <td>{i.product.nameMn}</td>
                <td className="font-mono">{i.product.sku}</td>
                <td>{i.product.unit}</td>
                <td className="text-right font-semibold">{qty(i.quantity)}</td>
                {costed && <td className="text-right">{i.unitCostMnt != null ? tugrik(i.unitCostMnt) : '—'}</td>}
                {costed && <td className="text-right">{i.unitCostMnt != null ? tugrik(Number(i.quantity) * i.unitCostMnt) : '—'}</td>}
              </tr>
            ))}
            {costed && (
              <tr>
                <td colSpan={6} className="text-right font-bold">
                  Нийт
                </td>
                <td className="text-right font-bold">{tugrik(total)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-10 pt-8 text-xs">
          <p>Хүлээлгэн өгсөн (нийлүүлэгч): ____________________</p>
          <p>Хүлээн авсан: ____________________ /{r.receivedBy?.fullName ?? ''}/</p>
        </div>
      </section>
      <style>{`
        @media print { .no-print { display: none !important; } @page { size: A4 portrait; margin: 12mm; } }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
        .print-doc thead { display: table-header-group; }
        .print-doc tr { break-inside: avoid; }
      `}</style>
    </div>
  );
}
