'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PRICE_SHEET_CSS, PriceSheet, PriceSheetDoc, downloadSheetCsv } from '@/components/price-sheet';
import { api } from '@/lib/api';
import type { CompanySettings } from '@/lib/types';

export default function PrintPriceListPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <PrintPriceList />
    </Suspense>
  );
}

/** ?id=<list> (add &all=1 for every product) or ?id=retail for the shelf prices. */
function PrintPriceList() {
  const q = useSearchParams();
  const id = q.get('id') ?? 'retail';
  const all = q.get('all') === '1';
  const [sheet, setSheet] = useState<PriceSheet | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');
  const retail = id === 'retail';

  useEffect(() => {
    const path = retail ? '/price-lists/retail/sheet' : `/price-lists/${encodeURIComponent(id)}/sheet${all ? '?all=true' : ''}`;
    Promise.all([api<PriceSheet>(path), api<CompanySettings>('/settings/company')])
      .then(([s, c]) => {
        setSheet(s);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [id, all, retail]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!sheet || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => window.print()}>
          Хэвлэх / PDF хадгалах
        </button>
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => downloadSheetCsv(sheet, !retail)}>
          Excel (CSV)
        </button>
        <span className="self-center text-slate-500">{sheet.items.length} бараа</span>
      </div>
      <section className="mx-auto max-w-[190mm] px-4 py-6">
        <PriceSheetDoc sheet={sheet} company={company} showRetail={!retail} />
      </section>
      <style>{PRICE_SHEET_CSS}</style>
    </div>
  );
}
