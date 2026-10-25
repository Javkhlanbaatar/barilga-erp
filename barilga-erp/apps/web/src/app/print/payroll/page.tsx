'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SellerBlock, Watermark } from '@/components/invoice-doc';
import { api, tugrik } from '@/lib/api';
import { CompanySettings, PayrollReport, ROLE_LABEL } from '@/lib/types';

export default function PayrollReportPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <PayrollSheet />
    </Suspense>
  );
}

/** Цалингийн тайлан: one month, every employee, with signatures — for the accountant and the bank. */
function PayrollSheet() {
  const q = useSearchParams();
  const period = q.get('period') ?? '';
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<PayrollReport>(`/hr/payroll?periodMonth=${encodeURIComponent(period)}`), api<CompanySettings>('/settings/company')])
      .then(([r, c]) => {
        setReport(r);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [period]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!report || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;
  const f = report.formula;

  return (
    <div className="print-doc relative min-h-screen bg-white text-black">
      <div className="no-print border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх
        </button>
      </div>
      <Watermark company={company} />
      <section className="relative mx-auto max-w-[270mm] space-y-4 px-4 py-6 text-sm">
        <div className="flex items-start justify-between gap-6">
          <SellerBlock company={company} />
          <div className="text-right">
            <h1 className="text-lg font-bold">ЦАЛИНГИЙН ТАЙЛАН</h1>
            <p>{report.periodMonth}</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>№</th>
              <th>Ажилтан</th>
              <th>Албан тушаал</th>
              <th>Үндсэн цалин</th>
              {f && <th>Бэлтгэл + борлуулалт</th>}
              <th>Урамшуулал</th>
              <th>Суутгал</th>
              {f && <th>НДШ + ХХОАТ</th>}
              <th>Гарт олгох</th>
              <th>Төлөв</th>
              <th>Гарын үсэг</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r, i) => (
              <tr key={r.id}>
                <td>{i + 1}</td>
                <td>{r.user.fullName}</td>
                <td>{ROLE_LABEL[r.user.role]}</td>
                <td className="text-right">{tugrik(r.earnedBase)}</td>
                {f && <td className="text-right">{tugrik(r.ticketBonus + r.salesBonus)}</td>}
                <td className="text-right">{tugrik(r.bonusMnt)}</td>
                <td className="text-right">{r.deductionMnt ? `−${tugrik(r.deductionMnt)}` : '—'}</td>
                {f && <td className="text-right">{tugrik(r.socialInsuranceMnt + r.incomeTaxMnt)}</td>}
                <td className="text-right font-bold">{tugrik(r.netSalary)}</td>
                <td>{r.status === 'PAID' ? `Олгосон ${r.paidAt ? r.paidAt.slice(0, 10) : ''}` : 'Ноорог'}</td>
                <td className="w-28" />
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={3}>Нийт</td>
              <td className="text-right">{tugrik(report.totals.base)}</td>
              {f && <td className="text-right">{tugrik(report.rows.reduce((s, r) => s + r.ticketBonus + r.salesBonus, 0))}</td>}
              <td className="text-right">{tugrik(report.rows.reduce((s, r) => s + r.bonusMnt, 0))}</td>
              <td className="text-right">−{tugrik(report.totals.deduction)}</td>
              {f && <td className="text-right">{tugrik(report.totals.insurance + report.totals.tax)}</td>}
              <td className="text-right">{tugrik(report.totals.net)}</td>
              <td colSpan={2}>Олгосон {tugrik(report.totals.paid)} · үлдсэн {tugrik(report.totals.unpaid)}</td>
            </tr>
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-8 pt-8 text-xs">
          <p>Боловсруулсан: ____________</p>
          <p>Баталсан: ____________</p>
        </div>
      </section>
      <style>{`
        @media print { .no-print { display: none !important; } @page { size: A4 landscape; margin: 10mm; } }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc td, .print-doc th { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
      `}</style>
    </div>
  );
}
