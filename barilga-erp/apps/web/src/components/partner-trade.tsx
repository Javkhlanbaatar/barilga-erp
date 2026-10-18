'use client';

import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { useCan } from '@/lib/permissions';
import { ORDER_STATUS_LABEL, type PartnerTrade } from '@/lib/types';

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const qty = (n: number) => n.toLocaleString('mn-MN', { maximumFractionDigits: 3 });

/**
 * Худалдаа / худалдан авалт with one partner: what we sold them (each order with its goods and how it was
 * paid) and — for managers — what we bought from them (goods receipts), plus both directions per product.
 */
export function PartnerTradePanel({ customerId }: { customerId: string }) {
  /** Pricing a receipt line later needs the cost right. */
  const canCost = useCan()('RECEIPT_COST_EDIT');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    return ymd(d);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [data, setData] = useState<PartnerTrade | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'sales' | 'purchases' | 'goods'>('sales');
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [msg, setMsg] = useState('');

  /** Goods taken by quantity get their price later; the partner account follows (managers only). */
  async function price(receiptId: string, item: PartnerTrade['purchases'][number]['items'][number]) {
    const raw = window.prompt(`${item.nameMn} (${qty(item.quantity)} ${item.unit}): нэгж үнэ ₮`, item.unitCostMnt == null ? '' : String(item.unitCostMnt));
    if (raw === null || !raw.trim()) return;
    const n = Math.round(Number(raw.replace(/[\s,]/g, '')));
    if (!(n >= 0)) return setError('Үнэ буруу байна');
    const reason = item.unitCostMnt == null ? 'Үнэ тохирсон' : window.prompt('Засах шалтгаан (засварын түүхэд бичигдэнэ):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/inventory/receipts/${receiptId}/items/${item.itemId}/cost`, { method: 'PATCH', body: JSON.stringify({ unitCostMnt: n, reason: reason.trim() }) });
      setMsg(`${item.nameMn}: ${tugrik(n)} — тооцоонд орлоо`);
      window.setTimeout(() => setMsg(''), 4000);
      setReload((x) => x + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    }
  }

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    setError('');
    api<PartnerTrade>(`/customers/${customerId}/trade?${params}`)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
    return () => {
      alive = false;
    };
  }, [customerId, from, to, reload]);

  function csv() {
    if (!data) return;
    const name = `${data.customer.name}-${from || 'ehnees'}-${to || 'odoo'}`;
    if (tab === 'sales')
      downloadCsv(
        `borluulalt-${name}`,
        ['Огноо', 'Захиалга', 'Салбар', 'Бараа', 'Тоо', 'Нэгж үнэ', 'Дүн', 'Захиалгын дүн', 'Мөнгөөр', 'Хасалтаар', 'Өр', 'Буцаалт'],
        data.sales.flatMap((s) =>
          s.items.map((i, n) => [
            new Date(s.at).toLocaleDateString('mn-MN'),
            s.orderNumber,
            s.warehouse ?? '',
            i.nameMn,
            i.quantity,
            i.unitPrice,
            i.lineTotal,
            n === 0 ? s.totalMnt : '',
            n === 0 ? s.moneyMnt : '',
            n === 0 ? s.offsetMnt : '',
            n === 0 ? s.owedMnt : '',
            n === 0 ? s.returnedMnt : '',
          ]),
        ),
      );
    else if (tab === 'purchases')
      downloadCsv(
        `hudaldan-avalt-${name}`,
        ['Огноо', 'Орлого', 'Агуулах', 'Падаан', 'Бараа', 'Тоо', 'Нэгж өртөг', 'Дүн'],
        data.purchases.flatMap((p) =>
          p.items.map((i) => [
            new Date(p.at).toLocaleDateString('mn-MN'),
            p.receiptNumber,
            p.warehouse,
            p.supplierInvoiceNo ?? '',
            i.nameMn,
            i.quantity,
            i.unitCostMnt ?? 'үнэ ороогүй',
            i.lineMnt ?? '',
          ]),
        ),
      );
    else
      downloadCsv(
        `baraa-${name}`,
        ['Код', 'Бараа', 'Нэгж', 'Зарсан тоо', 'Зарсан дүн', 'Авсан тоо', 'Авсан дүн'],
        data.goods.map((g) => [g.sku, g.nameMn, g.unit, g.soldQty, g.soldMnt, g.boughtQty, g.boughtMnt]),
      );
  }

  const t = data?.totals;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-semibold">Худалдаа / худалдан авалт</h3>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="text-slate-400">
            Эхлэх
            <input type="date" className="mt-1 block" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-slate-400">
            Дуусах
            <input type="date" className="mt-1 block" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="btn-ghost text-xs" onClick={() => (setFrom(''), setTo(''))}>
            Бүх хугацаа
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={csv} disabled={!data}>
            Excel
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {msg && <p className="text-sm text-emerald-300">{msg}</p>}
      {t && (
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <Tile label={`Бид зарсан (${t.salesCount})`} value={tugrik(t.netSalesMnt)} cls="text-amber-brand" />
          <Tile label="Мөнгөөр авсан" value={tugrik(t.moneyMnt)} />
          <Tile label="Хасалт / бартераар" value={tugrik(t.offsetMnt)} />
          <Tile label="Төлөгдөөгүй өр" value={tugrik(t.owedMnt)} cls={t.owedMnt > 0 ? 'text-amber-300' : ''} />
          {data.purchasesShown && (
            <>
              <Tile label={`Бид авсан (${t.purchasesCount})`} value={tugrik(t.purchasesMnt)} cls="text-sky-300" />
              <Tile label="Үнэ ороогүй мөр" value={String(t.unpricedLines)} cls={t.unpricedLines > 0 ? 'text-amber-300' : ''} />
            </>
          )}
        </div>
      )}
      <div className="flex gap-1 text-sm">
        {(
          [
            ['sales', 'Бид зарсан'],
            ...(data?.purchasesShown ? [['purchases', 'Бид авсан']] : []),
            ['goods', 'Бараагаар'],
          ] as Array<[typeof tab, string]>
        ).map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {data && tab === 'sales' && (
        <div className="max-h-[28rem] overflow-auto rounded border border-slate-800">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-steel-900 text-left text-xs text-slate-400">
              <tr>
                <th className="p-2">Огноо</th>
                <th>Захиалга</th>
                <th>Салбар</th>
                <th className="text-right">Дүн</th>
                <th className="text-right">Мөнгөөр</th>
                <th className="text-right">Хасалт</th>
                <th className="text-right">Өр</th>
                <th className="text-right pr-2">Буцаалт</th>
              </tr>
            </thead>
            <tbody>
              {data.sales.map((s) => (
                <Fragment key={s.id}>
                  <tr className="cursor-pointer border-t border-slate-800 hover:bg-steel-800" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    <td className="p-2 text-xs text-slate-400">{new Date(s.at).toLocaleDateString('mn-MN')}</td>
                    <td>
                      <Link href={`/orders/${s.id}`} className="font-mono text-xs text-amber-300 hover:underline" onClick={(e) => e.stopPropagation()}>
                        {s.orderNumber}
                      </Link>{' '}
                      <span className="text-[11px] text-slate-500">{ORDER_STATUS_LABEL[s.status as keyof typeof ORDER_STATUS_LABEL] ?? s.status}</span>
                    </td>
                    <td className="text-xs text-slate-400">{s.warehouse ?? '—'}</td>
                    <td className="text-right">{tugrik(s.totalMnt)}</td>
                    <td className="text-right text-slate-300">{s.moneyMnt ? tugrik(s.moneyMnt) : '—'}</td>
                    <td className="text-right text-slate-300">{s.offsetMnt ? tugrik(s.offsetMnt) : '—'}</td>
                    <td className={`text-right ${s.owedMnt ? 'text-amber-300' : 'text-slate-500'}`}>{s.owedMnt ? tugrik(s.owedMnt) : '—'}</td>
                    <td className="text-right pr-2 text-slate-400">{s.returnedMnt ? tugrik(s.returnedMnt) : '—'}</td>
                  </tr>
                  {open === s.id && (
                    <tr className="bg-steel-900/50">
                      <td colSpan={8} className="px-4 py-2">
                        <ItemList items={s.items.map((i) => ({ nameMn: i.nameMn, sku: i.sku, unit: i.unit, quantity: i.quantity, price: i.unitPrice, total: i.lineTotal }))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {data.sales.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд борлуулалт алга.</p>}
        </div>
      )}

      {data && tab === 'purchases' && (
        <div className="max-h-[28rem] overflow-auto rounded border border-slate-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-steel-900 text-left text-xs text-slate-400">
              <tr>
                <th className="p-2">Огноо</th>
                <th>Орлого</th>
                <th>Агуулах</th>
                <th>Падаан</th>
                <th className="text-right pr-2">Дүн</th>
              </tr>
            </thead>
            <tbody>
              {data.purchases.map((p) => (
                <Fragment key={p.id}>
                  <tr className="cursor-pointer border-t border-slate-800 hover:bg-steel-800" onClick={() => setOpen(open === p.id ? null : p.id)}>
                    <td className="p-2 text-xs text-slate-400">{new Date(p.at).toLocaleDateString('mn-MN')}</td>
                    <td>
                      <a href={`/print/receipts/${p.id}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-sky-300 hover:underline" onClick={(e) => e.stopPropagation()}>
                        {p.receiptNumber}
                      </a>
                    </td>
                    <td className="text-xs text-slate-400">{p.warehouse}</td>
                    <td className="text-xs text-slate-400">{p.supplierInvoiceNo ?? '—'}</td>
                    <td className="text-right pr-2">
                      {tugrik(p.totalMnt)}
                      {p.unpricedLines > 0 && <span className="ml-1 text-[11px] text-amber-300">+{p.unpricedLines} үнэ ороогүй</span>}
                    </td>
                  </tr>
                  {open === p.id && (
                    <tr className="bg-steel-900/50">
                      <td colSpan={5} className="px-4 py-2">
                        <ItemList
                          items={p.items.map((i) => ({ nameMn: i.nameMn, sku: i.sku, unit: i.unit, quantity: i.quantity, price: i.unitCostMnt, total: i.lineMnt }))}
                          onPrice={canCost ? (n) => void price(p.id, p.items[n]) : undefined}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {data.purchases.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд энэ харилцагчаас бараа аваагүй.</p>}
        </div>
      )}

      {data && tab === 'goods' && (
        <div className="max-h-[28rem] overflow-auto rounded border border-slate-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-steel-900 text-left text-xs text-slate-400">
              <tr>
                <th className="p-2">Бараа</th>
                <th className="text-right">Зарсан</th>
                <th className="text-right">Дүн</th>
                {data.purchasesShown && <th className="text-right">Авсан</th>}
                {data.purchasesShown && <th className="text-right pr-2">Дүн</th>}
              </tr>
            </thead>
            <tbody>
              {data.goods.map((g) => (
                <tr key={g.id} className="border-t border-slate-800">
                  <td className="p-2">
                    {g.nameMn} <span className="font-mono text-[11px] text-slate-500">{g.sku}</span>
                  </td>
                  <td className="text-right">{g.soldQty ? `${qty(g.soldQty)} ${g.unit}` : '—'}</td>
                  <td className="text-right text-amber-200">{g.soldMnt ? tugrik(g.soldMnt) : '—'}</td>
                  {data.purchasesShown && <td className="text-right">{g.boughtQty ? `${qty(g.boughtQty)} ${g.unit}` : '—'}</td>}
                  {data.purchasesShown && <td className="text-right pr-2 text-sky-200">{g.boughtMnt ? tugrik(g.boughtMnt) : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {data.goods.length === 0 && <p className="p-3 text-sm text-slate-500">Бараа алга.</p>}
        </div>
      )}
      {data?.truncated && <p className="text-xs text-amber-300">Хугацаа урт тул сүүлийн 500 баримтыг харуулав — хугацааг богиносгоно уу.</p>}
    </div>
  );
}

function Tile({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <p className="text-slate-400">{label}</p>
      <p className={`font-semibold ${cls}`}>{value}</p>
    </div>
  );
}

function ItemList({
  items,
  onPrice,
}: {
  items: Array<{ nameMn: string; sku: string; unit: string; quantity: number; price: number | null; total: number | null }>;
  /** Purchases: set or correct the price of line n. */
  onPrice?: (n: number) => void;
}) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {items.map((i, n) => (
          <tr key={n}>
            <td className="py-0.5">
              {i.nameMn} <span className="font-mono text-slate-500">{i.sku}</span>
            </td>
            <td className="text-right whitespace-nowrap">
              {qty(i.quantity)} {i.unit}
            </td>
            <td className="text-right whitespace-nowrap text-slate-400">× {i.price == null ? 'үнэ ороогүй' : tugrik(i.price)}</td>
            <td className="text-right whitespace-nowrap">{i.total == null ? '—' : tugrik(i.total)}</td>
            {onPrice && (
              <td className="text-right whitespace-nowrap">
                <button type="button" className={`text-[11px] hover:underline ${i.price == null ? 'text-amber-300' : 'text-slate-400'}`} onClick={() => onPrice(n)}>
                  {i.price == null ? 'үнэ оруулах' : 'үнэ засах'}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
