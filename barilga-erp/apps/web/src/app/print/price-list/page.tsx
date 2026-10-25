'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PRICE_SHEET_CSS, PriceSheet, PriceSheetDoc, downloadSheetCsv, scopeLine } from '@/components/price-sheet';
import { api } from '@/lib/api';
import type { CompanySettings } from '@/lib/types';

export default function PrintPriceListPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <PrintPriceList />
    </Suspense>
  );
}

/**
 * ?id=<list> (add &all=1 for every product) or ?id=retail for the shelf prices. &ids=<id,id,…> and / or
 * &cat=<category,…> print only those products (a product shows when it is picked OR in a picked category).
 */
function PrintPriceList() {
  const q = useSearchParams();
  const id = q.get('id') ?? 'retail';
  const all = q.get('all') === '1' || q.get('all') === 'true';
  const ids = (q.get('ids') ?? '').trim();
  // A category name may contain a comma: categories come as repeated ?cat= values, never split.
  const cats = q.getAll('cat').map((c) => c.trim()).filter(Boolean);
  const cat = cats.join('\u0000');
  const [sheet, setSheet] = useState<PriceSheet | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');
  const retail = id === 'retail';

  useEffect(() => {
    const params = new URLSearchParams();
    if (!retail && all) params.set('all', 'true');
    if (ids) params.set('ids', ids);
    for (const c of cats) params.append('cat', c);
    const query = params.toString();
    const path = `${retail ? '/price-lists/retail/sheet' : `/price-lists/${encodeURIComponent(id)}/sheet`}${query ? `?${query}` : ''}`;
    setError('');
    Promise.all([api<PriceSheet>(path), api<CompanySettings>('/settings/company')])
      .then(([s, c]) => {
        setSheet(s);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [id, all, ids, cat, retail]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!sheet || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;

  const scope = scopeLine(sheet.scope);

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm sm:px-4">
        <button className="min-h-[40px] rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => window.print()}>
          Хэвлэх / PDF хадгалах
        </button>
        <button className="min-h-[40px] rounded border border-slate-300 bg-white px-3 py-1" onClick={() => downloadSheetCsv(sheet, !retail)}>
          Excel (CSV)
        </button>
        <span className="text-slate-600">
          {scope ?? `${retail || all ? 'Бүх бараа' : 'Жагсаалтад орсон бараа'} · ${sheet.items.length}`}
        </span>
      </div>
      <section className="mx-auto max-w-[190mm] px-3 py-6 sm:px-4">
        <PriceSheetDoc sheet={sheet} company={company} showRetail={!retail} />
      </section>
      <style>{PRICE_SHEET_CSS}</style>
    </div>
  );
}
