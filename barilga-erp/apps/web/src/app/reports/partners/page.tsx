'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

type Aging = {
  asOf: string;
  customers: Array<{
    customerId: string;
    name: string;
    phone: string;
    orders: number;
    oldestDays: number;
    totalMnt: number;
    d0_30: number;
    d31_60: number;
    d61_90: number;
    d90p: number;
    ledgerMnt: number;
  }>;
  totals: { totalMnt: number; d0_30: number; d31_60: number; d61_90: number; d90p: number };
  /** False when the partner-accounts module is off: the ledger column is not shown. */
  ledgerShown?: boolean;
};
type Sales = {
  range: { startDate: string; endDate: string };
  customers: Array<{
    customerId: string | null;
    name: string;
    type: string | null;
    orders: number;
    grossMnt: number;
    returnedMnt: number;
    netMnt: number;
    moneyMnt: number;
    creditMnt: number;
    offsetMnt: number;
  }>;
  totals: { orders: number; grossMnt: number; returnedMnt: number; netMnt: number };
};
type Purchases = {
  range: { startDate: string; endDate: string };
  suppliers: Array<{
    key: string;
    customerId: string | null;
    name: string;
    registered: boolean;
    receipts: number;
    goodsMnt: number;
    unpricedLines: number;
    otherMnt: number;
    totalMnt: number;
  }>;
  totals: { receipts: number; goodsMnt: number; otherMnt: number; unpricedLines: number };
  receiptsShown?: boolean;
  ledgerShown?: boolean;
};

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const TABS = [
  ['aging', 'Авлагын насжилт'],
  ['sales', 'Борлуулалт харилцагчаар'],
  ['purchases', 'Худалдан авалт нийлүүлэгчээр'],
] as const;
type Tab = (typeof TABS)[number][0];

/** Partner reports: who owes us and for how long, what each customer bought, what we bought from each supplier. */
export default function PartnerReportsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('aging');
  const [startDate, setStartDate] = useState(() => ymd(new Date()).slice(0, 8) + '01');
  const [endDate, setEndDate] = useState(() => ymd(new Date()));
  const [aging, setAging] = useState<Aging | null>(null);
  const [sales, setSales] = useState<Sales | null>(null);
  const [purchases, setPurchases] = useState<Purchases | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (!hasRole(me.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(me.role));
      return;
    }
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'sales' || t === 'purchases' || t === 'aging') setTab(t);
    setReady(true);
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    setError('');
    const range = new URLSearchParams({ startDate, endDate });
    const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    if (tab === 'aging') api<Aging>('/reports/partners/aging').then(setAging).catch(fail);
    if (tab === 'sales') api<Sales>(`/reports/partners/sales?${range}`).then(setSales).catch(fail);
    if (tab === 'purchases') api<Purchases>(`/reports/partners/purchases?${range}`).then(setPurchases).catch(fail);
  }, [ready, tab, startDate, endDate]);

  function csv() {
    if (tab === 'aging' && aging)
      downloadCsv(
        `avlagiin-nasjilt-${aging.asOf}`,
        ['Харилцагч', 'Утас', 'Захиалга', '0–30 хоног', '31–60', '61–90', '90+', 'Нийт', 'Хамгийн хуучин (хоног)', ...(aging.ledgerShown === false ? [] : ['Бидний өглөг'])],
        aging.customers.map((c) => [
          c.name,
          c.phone,
          c.orders,
          c.d0_30,
          c.d31_60,
          c.d61_90,
          c.d90p,
          c.totalMnt,
          c.oldestDays,
          ...(aging.ledgerShown === false ? [] : [Math.max(0, c.ledgerMnt)]),
        ]),
      );
    if (tab === 'sales' && sales)
      downloadCsv(
        `borluulalt-hariltsagchaar-${startDate}-${endDate}`,
        ['Харилцагч', 'Захиалга', 'Нийт', 'Буцаалт', 'Цэвэр', 'Мөнгөөр', 'Дараа төлөх', 'Хасалт/бартер'],
        sales.customers.map((c) => [c.name, c.orders, c.grossMnt, c.returnedMnt, c.netMnt, c.moneyMnt, c.creditMnt, c.offsetMnt]),
      );
    if (tab === 'purchases' && purchases)
      downloadCsv(
        `hudaldan-avalt-${startDate}-${endDate}`,
        ['Нийлүүлэгч', 'Бүртгэлтэй', 'Орлого', 'Барааны дүн', 'Үнэгүй мөр', 'Бусад (үйлчилгээ)', 'Нийт'],
        purchases.suppliers.map((s) => [s.name, s.registered ? 'тийм' : 'үгүй', s.receipts, s.goodsMnt, s.unpricedLines, s.otherMnt, s.totalMnt]),
      );
  }

  const nameCell = (id: string | null, name: string) =>
    id ? (
      <Link href={`/customers?focus=${id}`} className="hover:underline">
        {name}
      </Link>
    ) : (
      <span className="text-slate-300">{name}</span>
    );

  return (
    <Shell>
      <ReportsNav />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Харилцагчийн тайлан</h2>
          <p className="mt-1 text-sm text-slate-400">
            Хэн хэдэн хоног өртэй байгаа, харилцагч бүр хэдийн бараа авсан, нийлүүлэгч бүрээс бид хэдийг авсан.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs print:hidden">
          {tab !== 'aging' && (
            <>
              <label className="text-slate-400">
                Эхлэх
                <input type="date" className="mt-1 block" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label className="text-slate-400">
                Дуусах
                <input type="date" className="mt-1 block" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
            </>
          )}
          <button className="btn-ghost text-xs" onClick={csv}>
            Excel
          </button>
          <button className="btn-ghost text-xs" onClick={() => window.print()}>
            🖨 Хэвлэх
          </button>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1 print:hidden">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {error && <p className="mb-3 text-red-400">{error}</p>}

      {tab === 'aging' && aging && (
        <>
          <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Tile label="Нийт авлага" value={aging.totals.totalMnt} cls="text-amber-300" />
            <Tile label="0–30 хоног" value={aging.totals.d0_30} />
            <Tile label="31–60 хоног" value={aging.totals.d31_60} />
            <Tile label="61–90 хоног" value={aging.totals.d61_90} cls={aging.totals.d61_90 ? 'text-orange-300' : ''} />
            <Tile label="90+ хоног" value={aging.totals.d90p} cls={aging.totals.d90p ? 'text-red-400' : ''} />
          </section>
          <div className="card overflow-auto p-0">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
                <tr>
                  <th className="p-2">Харилцагч</th>
                  <th className="text-right">Захиалга</th>
                  <th className="text-right">0–30</th>
                  <th className="text-right">31–60</th>
                  <th className="text-right">61–90</th>
                  <th className="text-right">90+</th>
                  <th className="text-right">Нийт</th>
                  {aging.ledgerShown !== false && (
                    <th className="text-right pr-3" title="Тэднээс авсан бараа г.м. — хасалт хийж болно">
                      Бидний өглөг
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {aging.customers.map((c) => (
                  <tr key={c.customerId} className="border-t border-slate-800">
                    <td className="p-2">
                      {nameCell(c.customerId, c.name)}
                      <span className="block text-xs text-slate-500">
                        {c.phone} · хамгийн хуучин {c.oldestDays} хоног
                      </span>
                    </td>
                    <td className="text-right">{c.orders}</td>
                    <Money v={c.d0_30} />
                    <Money v={c.d31_60} />
                    <Money v={c.d61_90} cls="text-orange-300" />
                    <Money v={c.d90p} cls="text-red-400" />
                    <td className="text-right font-semibold text-amber-300">{tugrik(c.totalMnt)}</td>
                    {aging.ledgerShown !== false && <td className="text-right pr-3 text-sky-300">{c.ledgerMnt > 0 ? tugrik(c.ledgerMnt) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {aging.customers.length === 0 && <p className="p-3 text-sm text-slate-500">Төлөгдөөгүй авлага алга.</p>}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {aging.asOf}-ны байдлаар. Нэхэмжлэхтэй захиалга төлөх хугацаа нь дууссан өдрөөс, бусад нь бараа авсан өдрөөс тоологдоно. Захиалгагүй
            бичсэн авлага (тээврийн хөлс г.м.) энд орохгүй — «Харилцагчийн тооцоо» тайланд харагдана.
          </p>
        </>
      )}

      {tab === 'sales' && sales && (
        <>
          <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={`Захиалга (${sales.totals.orders})`} value={sales.totals.grossMnt} />
            <Tile label="Буцаалт" value={sales.totals.returnedMnt} />
            <Tile label="Цэвэр борлуулалт" value={sales.totals.netMnt} cls="text-amber-brand" />
            <article className="card py-3">
              <p className="text-[10px] uppercase text-slate-400">Харилцагч</p>
              <p className="text-lg font-bold">{sales.customers.filter((c) => c.customerId).length}</p>
            </article>
          </section>
          <div className="card overflow-auto p-0">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
                <tr>
                  <th className="p-2">Харилцагч</th>
                  <th className="text-right">Захиалга</th>
                  <th className="text-right">Нийт</th>
                  <th className="text-right">Буцаалт</th>
                  <th className="text-right">Цэвэр</th>
                  <th className="text-right">Мөнгөөр</th>
                  <th className="text-right">Дараа төлөх</th>
                  <th className="text-right pr-3">Хасалт / бартер</th>
                </tr>
              </thead>
              <tbody>
                {sales.customers.map((c) => (
                  <tr key={c.customerId ?? 'walkin'} className="border-t border-slate-800">
                    <td className="p-2">{nameCell(c.customerId, c.name)}</td>
                    <td className="text-right">{c.orders}</td>
                    <td className="text-right">{tugrik(c.grossMnt)}</td>
                    <Money v={c.returnedMnt} />
                    <td className="text-right font-semibold">{tugrik(c.netMnt)}</td>
                    <Money v={c.moneyMnt} />
                    <Money v={c.creditMnt} cls="text-amber-300" />
                    <Money v={c.offsetMnt} cls="text-emerald-300 pr-3" />
                  </tr>
                ))}
              </tbody>
            </table>
            {sales.customers.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд борлуулалт алга.</p>}
          </div>
        </>
      )}

      {tab === 'purchases' && purchases && (
        <>
          <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={`Орлого (${purchases.totals.receipts})`} value={purchases.totals.goodsMnt} cls="text-sky-300" />
            <Tile label="Бусад (үйлчилгээ г.м.)" value={purchases.totals.otherMnt} />
            <Tile label="Нийт" value={purchases.totals.goodsMnt + purchases.totals.otherMnt} />
            <article className="card py-3">
              <p className="text-[10px] uppercase text-slate-400">Үнэгүй мөр</p>
              <p className={`text-lg font-bold ${purchases.totals.unpricedLines ? 'text-amber-300' : ''}`}>{purchases.totals.unpricedLines}</p>
            </article>
          </section>
          <div className="card overflow-auto p-0">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
                <tr>
                  <th className="p-2">Нийлүүлэгч</th>
                  <th className="text-right">Орлого</th>
                  <th className="text-right">Барааны дүн</th>
                  <th className="text-right">Үнэгүй мөр</th>
                  <th className="text-right">Бусад</th>
                  <th className="text-right pr-3">Нийт</th>
                </tr>
              </thead>
              <tbody>
                {purchases.suppliers.map((s) => (
                  <tr key={s.key} className="border-t border-slate-800">
                    <td className="p-2">
                      {nameCell(s.customerId, s.name)}
                      {!s.registered && <span className="ml-2 text-[11px] text-slate-500">бүртгэлгүй</span>}
                    </td>
                    <td className="text-right">{s.receipts || '—'}</td>
                    <Money v={s.goodsMnt} />
                    <td className={`text-right ${s.unpricedLines ? 'text-amber-300' : 'text-slate-500'}`}>{s.unpricedLines || '—'}</td>
                    <Money v={s.otherMnt} />
                    <td className="text-right pr-3 font-semibold text-sky-300">{tugrik(s.totalMnt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {purchases.suppliers.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд худалдан авалт алга.</p>}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Бүртгэлгүй нийлүүлэгчийн орлогыг «Бараа орлого» дээрээс харилцагчид холбож болно — тэгвэл үнэтэй мөрүүд нь өглөгт орно.
          </p>
        </>
      )}
    </Shell>
  );
}

function Tile({ label, value, cls = '' }: { label: string; value: number; cls?: string }) {
  return (
    <article className="card py-3">
      <p className="text-[10px] uppercase text-slate-400">{label}</p>
      <p className={`text-lg font-bold ${cls}`}>{tugrik(value)}</p>
    </article>
  );
}

function Money({ v, cls = '' }: { v: number; cls?: string }) {
  return <td className={`text-right ${v ? cls : 'text-slate-500'}`}>{v ? tugrik(v) : '—'}</td>;
}
