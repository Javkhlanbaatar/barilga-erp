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
  const [retry, setRetry] = useState(false);

  useEffect(() => {
    publicApi<PriceSheet & { company: CompanySettings }>(`/public/price-lists/${encodeURIComponent(token)}`)
      .then(setData)
      // Only the link's own state is shown as the server says it («…хугацаа дууссан», «…хаасан»). Other errors are
      // written for staff (a command to run, «Админ → Модулиуд»…), so customers get a plain sentence instead.
      .catch((err) => {
        const msg = err instanceof Error ? err.message : '';
        if (/холбоосын хугацаа дууссан|холбоосыг хаасан/.test(msg)) return setError(msg);
        if (/олдсонгүй|not found|модуль унтраалттай|switched off/i.test(msg)) return setError('Үнийн жагсаалт олдсонгүй эсвэл одоогоор нээлттэй биш байна.');
        // Anything else is a passing problem (no connection, too many tries, a server error): the link itself is fine.
        setRetry(true);
        setError('Одоогоор нээж чадсангүй. Түр хүлээгээд дахин нээнэ үү.');
      });
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen bg-white px-4 py-12 text-center text-slate-700">
        <p className="text-lg font-semibold">{error}</p>
        {!retry && <p className="mt-2 text-sm text-slate-500">Шинэ холбоос авахын тулд илгээсэн хүндээ хандана уу.</p>}
      </div>
    );
  }
  if (!data) return <p className="min-h-screen bg-white p-8 text-center text-slate-500">Уншиж байна…</p>;

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm sm:px-4">
        <button className="min-h-[40px] rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => window.print()}>
          Хэвлэх / PDF хадгалах
        </button>
        <button className="min-h-[40px] rounded border border-slate-300 bg-white px-3 py-1" onClick={() => downloadSheetCsv(data, true)}>
          Excel татах
        </button>
      </div>
      <section className="mx-auto max-w-[190mm] px-3 py-4 sm:px-4 sm:py-6">
        <PriceSheetDoc sheet={data} company={data.company} showRetail />
      </section>
      <style>{PRICE_SHEET_CSS}</style>
    </div>
  );
}
