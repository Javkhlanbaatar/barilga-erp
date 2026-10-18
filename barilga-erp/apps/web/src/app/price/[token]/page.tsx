'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PRICE_SHEET_CSS, PriceSheet, PriceSheetDoc, downloadSheetCsv } from '@/components/price-sheet';
import { publicApi } from '@/lib/api';
import type { CompanySettings } from '@/lib/types';

/** What the customer opens from the link we sent: their price list, ready to print or save. No login. */
export default function PublicPriceListPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<(PriceSheet & { company: CompanySettings }) | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    publicApi<PriceSheet & { company: CompanySettings }>(`/public/price-lists/${encodeURIComponent(token)}`)
      .then(setData)
      .catch(() => setError('Үнийн жагсаалт олдсонгүй эсвэл хаагдсан байна.'));
  }, [token]);

  if (error) return <p className="p-8 text-center text-slate-600">{error}</p>;
  if (!data) return <p className="p-8 text-center text-slate-500">Уншиж байна…</p>;

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm">
        <button className="rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => window.print()}>
          Хэвлэх / PDF хадгалах
        </button>
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => downloadSheetCsv(data, true)}>
          Excel татах
        </button>
      </div>
      <section className="mx-auto max-w-[190mm] px-4 py-6">
        <PriceSheetDoc sheet={data} company={data.company} showRetail />
      </section>
      <style>{PRICE_SHEET_CSS}</style>
    </div>
  );
}
