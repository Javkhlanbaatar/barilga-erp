'use client';

import { SellerBlock, Watermark } from '@/components/invoice-doc';
import { tugrik } from '@/lib/api';
import type { CompanySettings } from '@/lib/types';

/** A price list as the customer sees it: no costs, grouped by category. */
export type PriceSheet = {
  name: string;
  notes: string | null;
  validUntil: string | null;
  generatedAt: string;
  items: Array<{ sku: string; nameMn: string; unit: string; category: string; priceMnt: number; retailMnt: number; listed: boolean }>;
};

const day = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** The printable / shareable price list document. `showRetail` adds the shelf price next to the list price. */
export function PriceSheetDoc({ sheet, company, showRetail }: { sheet: PriceSheet; company: CompanySettings; showRetail: boolean }) {
  const groups = new Map<string, PriceSheet['items']>();
  for (const i of sheet.items) groups.set(i.category || 'Бусад', [...(groups.get(i.category || 'Бусад') ?? []), i]);
  const cols = showRetail ? 6 : 5;
  let n = 0;
  return (
    <div className="relative space-y-4">
      <Watermark company={company} />
      <div className="flex items-start justify-between gap-6">
        <SellerBlock company={company} />
        <div className="text-right">
          <h1 className="text-2xl font-bold tracking-wide">ҮНИЙН ЖАГСААЛТ</h1>
          <p className="text-sm font-semibold">{sheet.name}</p>
          <p className="text-xs">Огноо: {day(sheet.generatedAt)}</p>
          {sheet.validUntil && <p className="text-xs font-semibold">Хүчинтэй: {day(sheet.validUntil)} хүртэл</p>}
        </div>
      </div>
      {sheet.notes && <p className="whitespace-pre-line text-xs">{sheet.notes}</p>}
      <table>
        <thead>
          <tr>
            <th className="w-8">№</th>
            <th>Код</th>
            <th>Барааны нэр</th>
            <th>Нэгж</th>
            {showRetail && <th className="text-right">Жижиглэн үнэ</th>}
            <th className="text-right">{showRetail ? 'Таны үнэ' : 'Үнэ'}</th>
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([cat, items]) => (
            <GroupRows key={cat} cat={cat} cols={cols}>
              {items.map((i) => {
                n += 1;
                return (
                  <tr key={i.sku}>
                    <td>{n}</td>
                    <td className="font-mono">{i.sku}</td>
                    <td>{i.nameMn}</td>
                    <td>{i.unit}</td>
                    {showRetail && <td className="text-right">{i.listed && i.retailMnt !== i.priceMnt ? tugrik(i.retailMnt) : ''}</td>}
                    <td className="text-right font-semibold">{tugrik(i.priceMnt)}</td>
                  </tr>
                );
              })}
            </GroupRows>
          ))}
        </tbody>
      </table>
      {sheet.items.length === 0 && <p className="text-sm">Энэ жагсаалтад үнэ оруулаагүй байна.</p>}
      {company.phone && <p className="text-[11px]">Үлдэгдэл, захиалгыг {company.phone} утсаар тодруулна уу.</p>}
    </div>
  );
}

function GroupRows({ cat, cols, children }: { cat: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      <tr>
        <td colSpan={cols} className="font-semibold" style={{ background: '#f8fafc' }}>
          {cat}
        </td>
      </tr>
      {children}
    </>
  );
}

/** Excel-friendly CSV (UTF-8 with BOM so Cyrillic opens correctly). */
export function downloadSheetCsv(sheet: PriceSheet, showRetail: boolean) {
  const head = ['Ангилал', 'Код', 'Барааны нэр', 'Нэгж', ...(showRetail ? ['Жижиглэн үнэ'] : []), 'Үнэ'];
  const rows = sheet.items.map((i) => [i.category, i.sku, i.nameMn, i.unit, ...(showRetail ? [i.retailMnt] : []), i.priceMnt]);
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sheet.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Shared print CSS for price sheets. */
export const PRICE_SHEET_CSS = `
  @media print { .no-print { display: none !important; } body { background: #fff !important; } @page { size: A4 portrait; margin: 12mm; } }
  .print-doc table { border-collapse: collapse; width: 100%; }
  .print-doc th, .print-doc td { border: 1px solid #333; padding: 3px 6px; font-size: 12px; }
  .print-doc th { background: #f1f5f9; text-align: left; }
`;
