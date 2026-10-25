'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { KIND_MN } from '@/components/account-panel';
import { SellerBlock, Watermark } from '@/components/invoice-doc';
import { api, tugrik } from '@/lib/api';
import type { AccountStatement, CompanySettings } from '@/lib/types';

export default function PrintAccountPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <AccountAct />
    </Suspense>
  );
}

const day = (d: string | Date) => new Date(d).toLocaleDateString('mn-MN');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());

/**
 * Тооцоо нийлсэн акт: the partner account for a period — brought forward, every line, closing balance — and
 * who owes whom at the end, signed and stamped by both sides.
 */
function AccountAct() {
  const { customerId } = useParams<{ customerId: string }>();
  const q = useSearchParams();
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  const [st, setSt] = useState<AccountStatement | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    Promise.all([api<AccountStatement>(`/accounts/${customerId}?${params}`), api<CompanySettings>('/settings/company')])
      .then(([s, c]) => {
        setSt(s);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [customerId, from, to]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!st || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;

  // A cancelled line and its reversal cancel out; when both fall in the period neither is shown. The running
  // balance is counted again over what is shown, so it still ends on the same closing balance.
  const ids = new Set(st.lines.map((l) => l.entryId).filter(Boolean));
  const pairs = new Set(st.lines.filter((l) => l.refType === 'VOID' && l.refId && ids.has(l.refId)).flatMap((l) => [l.entryId, l.refId]));
  const opening = st.period?.openingMnt ?? 0;
  let running = opening;
  const lines = st.lines
    .filter((l) => !(l.entryId && pairs.has(l.entryId)))
    .map((l) => ({ ...l, balanceMnt: (running += l.effectMnt) }));
  const debit = lines.reduce((s, l) => s + Math.max(0, l.effectMnt), 0);
  const credit = lines.reduce((s, l) => s + Math.max(0, -l.effectMnt), 0);
  const closing = opening + debit - credit;
  const asOf = to || today();
  const partner = st.customer;

  return (
    <div className="print-doc relative min-h-screen bg-white text-black">
      <div className="no-print border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх / PDF
        </button>
        <span className="ml-3 text-xs text-slate-500">Хүчингүй болгосон мөр болон түүний эсрэг мөр хоёулаа энэ хугацаанд байвал актад орохгүй.</span>
      </div>
      <section className="relative mx-auto max-w-[190mm] space-y-4 px-4 py-6 text-sm">
        <Watermark company={company} />
        <div className="flex items-start justify-between gap-6">
          <SellerBlock company={company} />
          <div className="text-right">
            <h1 className="text-xl font-bold tracking-wide">ТООЦОО НИЙЛСЭН АКТ</h1>
            <p className="text-xs">
              {from ? day(from) : 'Эхнээс'} — {day(asOf)}
            </p>
          </div>
        </div>
        <div className="text-xs leading-5">
          <p>
            Харилцагч: <b>{partner.name}</b>
            {partner.regNumber ? ` · РД ${partner.regNumber}` : ''}
            {partner.phone ? ` · утас ${partner.phone}` : ''}
          </p>
          {partner.address && <p>Хаяг: {partner.address}</p>}
          {partner.barterContract && <p>Бартерын гэрээ: {partner.barterContract}</p>}
        </div>
        <table>
          <thead>
            <tr>
              <th className="w-8">№</th>
              <th>Огноо</th>
              <th>Гүйлгээ</th>
              <th>Тайлбар</th>
              <th className="text-right">Авлага нэмэгдсэн</th>
              <th className="text-right">Авлага буурсан</th>
              <th className="text-right">Үлдэгдэл</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td />
              <td>{from ? day(from) : ''}</td>
              <td colSpan={4} className="font-semibold">
                Эхний үлдэгдэл
              </td>
              <td className="text-right font-semibold">{tugrik(opening)}</td>
            </tr>
            {lines.map((l, i) => (
              <tr key={`${l.entryId ?? l.orderId}-${i}`}>
                <td>{i + 1}</td>
                <td className="whitespace-nowrap">{day(l.at)}</td>
                <td>{KIND_MN[l.kind] ?? l.kind}</td>
                <td>
                  {l.description}
                  {l.voided ? ' (хүчингүй болсон)' : ''}
                </td>
                <td className="text-right">{l.effectMnt > 0 ? tugrik(l.effectMnt) : ''}</td>
                <td className="text-right">{l.effectMnt < 0 ? tugrik(-l.effectMnt) : ''}</td>
                <td className="text-right">{tugrik(l.balanceMnt)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="text-right font-bold">
                Гүйлгээний дүн
              </td>
              <td className="text-right font-bold">{tugrik(debit)}</td>
              <td className="text-right font-bold">{tugrik(credit)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={6} className="text-right font-bold">
                Эцсийн үлдэгдэл ({day(asOf)})
              </td>
              <td className="text-right font-bold">{tugrik(closing)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-sm">
          {day(asOf)} өдрийн байдлаар{' '}
          {closing > 0 ? (
            <>
              <b>{partner.name}</b> нь <b>{company.name || 'манай байгууллага'}</b>-д <b>{tugrik(closing)}</b> төлөх үлдэгдэлтэй.
            </>
          ) : closing < 0 ? (
            <>
              <b>{company.name || 'Манай байгууллага'}</b> нь <b>{partner.name}</b>-д <b>{tugrik(-closing)}</b> төлөх үлдэгдэлтэй.
            </>
          ) : (
            <>талуудын тооцоо бүрэн дууссан, үлдэгдэлгүй.</>
          )}
        </p>
        <p className="text-[11px] text-slate-600">
          «Авлага нэмэгдсэн» — харилцагч бидэнд өртэй болсон (бараа авсан, авлага бичсэн, бид мөнгө төлсөн); «Авлага буурсан» — харилцагч төлсөн, бид
          бараа/үйлчилгээ авсан, хасалт. Үлдэгдэл эерэг бол харилцагч бидэнд, сөрөг бол бид харилцагчид өртэй.
        </p>
        <div className="grid grid-cols-2 gap-10 pt-8 text-xs leading-7">
          <div>
            <p className="font-semibold">{company.name || 'Манай байгууллага'}</p>
            <p>Захирал: ____________________</p>
            <p>Нягтлан бодогч: ____________________</p>
            <p className="pt-4 text-slate-500">Тамга</p>
          </div>
          <div>
            <p className="font-semibold">{partner.name}</p>
            <p>Захирал: ____________________</p>
            <p>Нягтлан бодогч: ____________________</p>
            <p className="pt-4 text-slate-500">Тамга</p>
          </div>
        </div>
      </section>
      <style>{`
        @media print { .no-print { display: none !important; } @page { size: A4 portrait; margin: 12mm; } }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
        .print-doc thead { display: table-header-group; }
        .print-doc tr { break-inside: avoid; }
      `}</style>
    </div>
  );
}
