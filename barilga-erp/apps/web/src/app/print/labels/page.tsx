'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Barcode } from '@/components/barcode';
import { api, tugrik } from '@/lib/api';
import { Product, productMatchesQuery } from '@/lib/types';

/** Label sizes: thermal label printers (58×40, 40×30 mm) or an A4 sheet of 3×8 stickers. */
const SIZES = {
  '58x40': { label: '58×40 мм (наалт хэвлэгч)', page: '58mm 40mm', w: '58mm', h: '40mm', cols: 1, bar: 34 },
  '40x30': { label: '40×30 мм (наалт хэвлэгч)', page: '40mm 30mm', w: '40mm', h: '30mm', cols: 1, bar: 24 },
  a4: { label: 'A4 хуудас, 3×8 наалт', page: 'A4 portrait', w: '70mm', h: '37mm', cols: 3, bar: 32 },
} as const;
type SizeKey = keyof typeof SIZES;

export default function LabelsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <Labels />
    </Suspense>
  );
}

/** Баркод шошго: choose products and how many labels of each, then print. ?ids=a,b preselects products. */
function Labels() {
  const q = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [size, setSize] = useState<SizeKey>('58x40');
  const [showPrice, setShowPrice] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Product[]>('/products')
      .then((rows) => {
        setProducts(rows);
        const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
        setCounts(Object.fromEntries(ids.map((id) => [id, 1])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [q]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const chosen = Object.entries(counts)
    .filter(([id, n]) => n > 0 && byId.has(id))
    .map(([id, n]) => ({ p: byId.get(id)!, n }));
  const labels = chosen.flatMap(({ p, n }) => Array.from({ length: n }, (_, i) => ({ p, key: `${p.id}-${i}` })));
  const noCode = chosen.filter(({ p }) => !p.barcode);
  const hits = search.trim() ? products.filter((p) => productMatchesQuery(p, search)).slice(0, 8) : [];
  const s = SIZES[size];

  return (
    <div className="min-h-screen bg-white text-black">
      <div className="no-print space-y-3 border-b border-slate-200 bg-slate-50 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-bold">Баркод шошго хэвлэх</h1>
          <select className="rounded border border-slate-300 px-2 py-1" value={size} onChange={(e) => setSize(e.target.value as SizeKey)}>
            {(Object.keys(SIZES) as SizeKey[]).map((k) => (
              <option key={k} value={k}>
                {SIZES[k].label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Үнэ хэвлэх
          </label>
          <button className="rounded bg-slate-900 px-4 py-1.5 text-white disabled:opacity-40" disabled={!labels.length} onClick={() => window.print()}>
            Хэвлэх ({labels.length} шошго)
          </button>
        </div>
        {error && <p className="text-red-600">{error}</p>}
        <div className="relative max-w-md">
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            placeholder="Бараа нэмэх: нэр, код, баркод…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {hits.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded border border-slate-300 bg-white shadow">
              {hits.map((p) => (
                <li key={p.id}>
                  <button
                    className="w-full px-2 py-1 text-left hover:bg-slate-100"
                    onClick={() => {
                      setCounts({ ...counts, [p.id]: (counts[p.id] ?? 0) + 1 });
                      setSearch('');
                    }}
                  >
                    {p.nameMn} <span className="font-mono text-xs text-slate-500">{p.barcode ?? 'баркодгүй'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {chosen.length > 0 && (
          <table className="text-xs">
            <tbody>
              {chosen.map(({ p, n }) => (
                <tr key={p.id}>
                  <td className="pr-3">{p.nameMn}</td>
                  <td className="pr-3 font-mono">{p.barcode ?? '—'}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      className="w-16 rounded border border-slate-300 px-1"
                      value={n}
                      onChange={(e) => setCounts({ ...counts, [p.id]: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })}
                    />{' '}
                    ширхэг
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {noCode.length > 0 && (
          <p className="text-amber-700">
            {noCode.map(({ p }) => p.nameMn).join(', ')} — баркодгүй. «Агуулахын үлдэгдэл» → «Баркодгүйд олгох» дарж автоматаар оноогоод дахин нээнэ үү.
          </p>
        )}
        <p className="text-xs text-slate-500">
          Хэвлэхдээ цонхон дээр наалт хэвлэгчээ сонгож, «Margins: None», «Scale: 100%» болгоно. Шошгоны хэмжээ принтерийн тохиргоотой таарах ёстой.
        </p>
      </div>

      <div className="labels" style={{ display: 'grid', gridTemplateColumns: `repeat(${s.cols}, ${s.w})` }}>
        {labels
          .filter(({ p }) => p.barcode)
          .map(({ p, key }) => (
            <div key={key} className="label" style={{ width: s.w, height: s.h }}>
              <p className="name">{p.nameMn}</p>
              {showPrice && <p className="price">{tugrik(p.priceMnt)}</p>}
              <Barcode value={p.barcode!} height={s.bar} width={size === '40x30' ? 1.2 : 1.5} fontSize={size === '40x30' ? 9 : 11} />
            </div>
          ))}
      </div>
      <style>{`
        .label { box-sizing: border-box; padding: 1.5mm 2mm; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: space-between; page-break-inside: avoid; break-inside: avoid; }
        .label .name { font-size: 9pt; font-weight: 600; line-height: 1.1; text-align: center; max-height: 2.3em; overflow: hidden; }
        .label .price { font-size: 11pt; font-weight: 700; }
        @media screen { .labels { gap: 4px; padding: 16px; } .label { border: 1px dashed #94a3b8; } }
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          @page { size: ${s.page}; margin: ${size === 'a4' ? '10mm 0 0 0' : '0'}; }
          ${size === 'a4' ? '' : '.label { page-break-after: always; break-after: page; }'}
        }
      `}</style>
    </div>
  );
}
