'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';

type OwnPrice = {
  productId: string;
  sku: string;
  nameMn: string;
  unit: string;
  priceMnt: number;
  retailMnt: number;
  active: boolean;
  /** A later receipt's cost passed it: not used until a new price is set. */
  belowCost?: boolean;
  updatedAt: string;
};

/**
 * The customer's own prices: set at the till by someone allowed to change prices, used by themselves on the
 * customer's next purchase (before their price list and retail). Removing one brings the usual price back.
 */
export function CustomerOwnPrices({ customerId, canRemove }: { customerId: string; canRemove: boolean }) {
  const [rows, setRows] = useState<OwnPrice[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<OwnPrice[]>(`/customers/${customerId}/prices`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хувийн үнийг ачаалж чадсангүй');
    }
  }, [customerId]);

  useEffect(() => {
    setRows(null);
    setError('');
    void load();
  }, [load]);

  async function remove(p: OwnPrice) {
    if (!window.confirm(`«${p.nameMn}»-ийн хувийн үнэ ${tugrik(p.priceMnt)}-ийг устгах уу? Дараагийн худалдаанд ердийн үнээр гарна.`)) return;
    setBusy(p.productId);
    setError('');
    try {
      await api(`/customers/${customerId}/prices/${p.productId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Устгаж чадсангүй');
    } finally {
      setBusy(null);
    }
  }

  if (!rows?.length && !error) return null;
  return (
    <div className="mt-2 rounded-lg border border-slate-800 p-2 text-xs">
      <p className="mb-1 text-slate-400">Хувийн үнэ (касс дээр тохирсон)</p>
      {error && <p className="text-red-400">{error}</p>}
      <ul className="divide-y divide-slate-800">
        {(rows ?? []).map((p) => (
          <li key={p.productId} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
            <span className="min-w-0 flex-1 truncate">
              {p.nameMn} <span className="text-slate-500">{p.sku}</span>
              {!p.active && <span className="text-slate-500"> · идэвхгүй</span>}
              {p.belowCost && <span className="text-amber-300"> · өртгөөс доош болсон тул хэрэглэгдэхгүй</span>}
            </span>
            <span className="font-semibold text-emerald-300">{tugrik(p.priceMnt)}</span>
            {p.retailMnt !== p.priceMnt && <span className="text-slate-500 line-through">{tugrik(p.retailMnt)}</span>}
            {canRemove && (
              <button type="button" className="text-red-300 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void remove(p)}>
                устгах
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
