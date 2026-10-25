'use client';

import { SellerBlock, Watermark } from '@/components/invoice-doc';
import { tugrik } from '@/lib/api';
import { categoryLabel, unitLabel } from '@/lib/catalog';
import { downloadCsv } from '@/lib/csv';
import type { CompanySettings } from '@/lib/types';

type SheetItem = { sku: string; nameMn: string; unit: string; category: string; priceMnt: number; retailMnt: number; listed: boolean };

/** A price list as the customer sees it: no costs, grouped by category. */
export type PriceSheet = {
  name: string;
  notes: string | null;
  validUntil: string | null;
  generatedAt: string;
  /** Set when the sheet was narrowed to chosen products and/or categories. */
  scope?: { count: number; categories: string[] } | null;
  /** Who a shared link was made for (public link only). */
  label?: string | null;
  items: SheetItem[];
};

const day = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** The group for products without a category (and for the "Other" category); always printed last. */
const OTHER = 'Бусад';

/** Category heading in Mongolian ("Cement" → "Цемент"); a product without one goes under "Бусад". */
const groupName = (category: string | null) => ((category ?? '').trim() ? categoryLabel(category) : OTHER);

/** Items grouped under their Mongolian category, groups in Mongolian alphabetical order with "Бусад" last (items keep their order). */
function byCategory(items: SheetItem[]) {
  const groups = new Map<string, SheetItem[]>();
  for (const i of items) {
    const g = groupName(i.category);
    groups.set(g, [...(groups.get(g) ?? []), i]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === OTHER) !== (b === OTHER) ? (a === OTHER ? 1 : -1) : a.localeCompare(b, 'mn'));
}

/** "Сонгосон 12 бараа · ангилал: Цемент, Төмөр" for a narrowed sheet; null for the whole list. */
export function scopeLine(scope: PriceSheet['scope']): string | null {
  if (!scope) return null;
  const cats = scope.categories.map((c) => groupName(c));
  return `Сонгосон ${scope.count} бараа${cats.length ? ` · ангилал: ${cats.join(', ')}` : ''}`;
}

/** The shelf price printed next to the customer's price: only when the list gives them a different price. */
const retailShown = (i: SheetItem) => (i.listed && i.retailMnt !== i.priceMnt ? i.retailMnt : null);

/** The printable / shareable price list document. `showRetail` adds the shelf price next to the list price. */
export function PriceSheetDoc({ sheet, company, showRetail }: { sheet: PriceSheet; company: CompanySettings; showRetail: boolean }) {
  const groups = byCategory(sheet.items);
  const cols = showRetail ? 6 : 5;
  const scope = scopeLine(sheet.scope);
  let n = 0;
  return (
    <div className="relative space-y-4">
      <Watermark company={company} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <SellerBlock company={company} />
        <div className="sm:text-right">
          <h1 className="text-2xl font-bold tracking-wide">ҮНИЙН ЖАГСААЛТ</h1>
          <p className="text-sm font-semibold">{sheet.name}</p>
          {sheet.label && <p className="text-sm">Хэнд: {sheet.label}</p>}
          <p className="text-xs">Огноо: {day(sheet.generatedAt)}</p>
          {sheet.validUntil && <p className="text-xs font-semibold">Хүчинтэй: {day(sheet.validUntil)} хүртэл</p>}
          {scope && <p className="text-xs">{scope}</p>}
        </div>
      </div>
      {sheet.notes && <p className="whitespace-pre-line text-xs">{sheet.notes}</p>}
      {/* On a phone the table scrolls sideways inside this box, not the whole page. */}
      <div className="table-scroll">
        <table className="min-w-[480px]">
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
            {groups.map(([cat, items]) => (
              <GroupRows key={cat} cat={cat} cols={cols}>
                {items.map((i) => {
                  n += 1;
                  const retail = retailShown(i);
                  return (
                    <tr key={`${i.sku}-${n}`}>
                      <td>{n}</td>
                      <td className="font-mono">{i.sku}</td>
                      <td>{i.nameMn}</td>
                      <td className="whitespace-nowrap">{unitLabel(i.unit)}</td>
                      {showRetail && <td className="whitespace-nowrap text-right">{retail === null ? '' : tugrik(retail)}</td>}
                      <td className="whitespace-nowrap text-right font-semibold">{tugrik(i.priceMnt)}</td>
                    </tr>
                  );
                })}
              </GroupRows>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.items.length === 0 && (
        <p className="text-sm">{sheet.scope ? 'Сонгосон бараанд үнэ алга.' : 'Энэ жагсаалтад үнэ оруулаагүй байна.'}</p>
      )}
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

/** Excel-friendly CSV with the same rows, order, columns and numbers as the printed sheet. */
export function downloadSheetCsv(sheet: PriceSheet, showRetail: boolean) {
  const head = ['№', 'Ангилал', 'Код', 'Барааны нэр', 'Нэгж', ...(showRetail ? ['Жижиглэн үнэ'] : []), showRetail ? 'Таны үнэ' : 'Үнэ'];
  let n = 0;
  const rows = byCategory(sheet.items).flatMap(([cat, items]) =>
    items.map((i) => {
      n += 1;
      return [n, cat, i.sku, i.nameMn, unitLabel(i.unit), ...(showRetail ? [retailShown(i)] : []), i.priceMnt];
    }),
  );
  downloadCsv(sheet.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'une-jagsaalt', head, rows);
}

/** Shared print CSS for price sheets. */
export const PRICE_SHEET_CSS = `
  @media print {
    .no-print { display: none !important; }
    body { background: #fff !important; }
    @page { size: A4 portrait; margin: 12mm; }
    .print-doc .table-scroll { overflow: visible !important; }
  }
  .print-doc table { border-collapse: collapse; width: 100%; }
  .print-doc th, .print-doc td { border: 1px solid #333; padding: 3px 6px; font-size: 12px; }
  .print-doc th { background: #f1f5f9; text-align: left; }
`;
