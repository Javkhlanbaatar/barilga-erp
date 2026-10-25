'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { SellerBlock } from '@/components/invoice-doc';
import { api } from '@/lib/api';
import type { CompanySettings, StockTransfer } from '@/lib/types';

const qty = (v: string | number | null | undefined) => (v == null ? '' : Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 }));
const when = (iso?: string | null) =>
  iso
    ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
    : '';

/** Transfer note (шилжүүлгийн баримт) that travels with the goods: sender, driver and receiver sign it. */
export default function PrintTransferPage() {
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<StockTransfer | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<StockTransfer>(`/inventory/transfers/${id}`), api<CompanySettings>('/settings/company')])
      .then(([tr, c]) => {
        setT(tr);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [id]);

  useEffect(() => {
    if (t && company) {
      const h = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(h);
    }
  }, [t, company]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!t || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;
  const received = t.status === 'RECEIVED';

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх
        </button>
      </div>
      <section className="mx-auto max-w-[186mm] space-y-4 px-4 py-6">
        <div className="flex items-start justify-between gap-6">
          <SellerBlock company={company} />
          <div className="text-right">
            <h1 className="text-xl font-bold">ШИЛЖҮҮЛГИЙН БАРИМТ</h1>
            <p className="text-sm">№ {t.transferNumber}</p>
            <p className="text-xs">Илгээсэн: {when(t.sentAt)}</p>
            {received && <p className="text-xs">Хүлээн авсан: {when(t.receivedAt)}</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div className="rounded border border-slate-400 p-3">
            <p className="font-semibold">Илгээх агуулах</p>
            <p>{t.fromWarehouse.name}</p>
          </div>
          <div className="rounded border border-slate-400 p-3">
            <p className="font-semibold">Хүлээн авах агуулах</p>
            <p>{t.toWarehouse.name}</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th className="w-8">№</th>
              <th>Код</th>
              <th>Барааны нэр</th>
              <th>Нэгж</th>
              <th className="text-right">Илгээсэн</th>
              <th className="text-right">Хүлээн авсан</th>
              <th>Тайлбар</th>
            </tr>
          </thead>
          <tbody>
            {t.items
              .filter((i) => Number(i.quantity) > 0)
              .map((i, idx) => (
                <tr key={i.id}>
                  <td>{idx + 1}</td>
                  <td className="font-mono">{i.product.sku}</td>
                  <td>{i.product.nameMn}</td>
                  <td>{i.product.unit}</td>
                  <td className="text-right">{qty(i.quantity)}</td>
                  <td className="text-right">{received ? qty(i.receivedQty ?? i.quantity) : ''}</td>
                  <td>{i.shortageReason ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {t.notes && <p className="text-xs">Тэмдэглэл: {t.notes}</p>}
        <div className="grid grid-cols-3 gap-6 pt-10 text-xs">
          <p>Илгээсэн: ____________ /{t.sentBy?.fullName ?? ''}/</p>
          <p>Тээвэрлэсэн: ____________ /__________/</p>
          <p>Хүлээн авсан: ____________ /{t.receivedBy?.fullName ?? ''}/</p>
        </div>
      </section>
      <style>{`
        @media print { .no-print { display: none !important; } @page { size: A4 portrait; margin: 12mm; } }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
      `}</style>
    </div>
  );
}
