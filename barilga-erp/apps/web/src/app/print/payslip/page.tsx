'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SellerBlock } from '@/components/invoice-doc';
import { api, tugrik } from '@/lib/api';
import { CompanySettings, PayrollReport, PayrollRow, ROLE_LABEL } from '@/lib/types';

export default function PayslipPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <Payslip />
    </Suspense>
  );
}

/** One employee's payslip (цалингийн хуудас) for a month, with every line of the calculation. */
function Payslip() {
  const q = useSearchParams();
  const period = q.get('period') ?? '';
  const userId = q.get('user') ?? '';
  const [row, setRow] = useState<PayrollRow | null>(null);
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<PayrollReport>(`/hr/payroll?periodMonth=${encodeURIComponent(period)}`), api<CompanySettings>('/settings/company')])
      .then(([r, c]) => {
        const mine = r.rows.find((x) => x.user.id === userId);
        if (!mine) throw new Error('Ажилтан олдсонгүй');
        setReport(r);
        setRow(mine);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [period, userId]);

  useEffect(() => {
    if (row && company) {
      const h = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(h);
    }
  }, [row, company]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!row || !company || !report) return <p className="p-6 text-slate-500">Уншиж байна…</p>;
  const s = report.settings;
  const lines: Array<[string, number, string?]> = [
    ['Үндсэн цалин', row.baseSalary],
    ...(row.earnedBase !== row.baseSalary ? ([[`Ирцээр бодсон (${row.workedDays}/${row.workingDays} өдөр)`, row.earnedBase]] as Array<[string, number]>) : []),
    [`Бэлтгэлийн урамшуулал (${row.ticketCount} × ${tugrik(s.ticketBonusMnt)})`, row.ticketBonus],
    [`Борлуулалтын шагнал (${tugrik(row.salesAmountMnt)} × ${s.salesCommissionPct}%)`, row.salesBonus],
    ...row.adjustments.map((a) => [a.reason, a.amountMnt] as [string, number]),
  ];

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх
        </button>
      </div>
      <section className="mx-auto max-w-[150mm] space-y-4 px-4 py-6 text-sm">
        <div className="flex items-start justify-between gap-6">
          <SellerBlock company={company} />
          <div className="text-right">
            <h1 className="text-lg font-bold">ЦАЛИНГИЙН ХУУДАС</h1>
            <p>{row.periodMonth}</p>
          </div>
        </div>
        <p>
          <b>{row.user.fullName}</b> · {ROLE_LABEL[row.user.role]} · ирц {row.workedDays}/{row.workingDays} өдөр
        </p>
        <table>
          <tbody>
            {lines.map(([label, v], i) => (
              <tr key={i}>
                <td>{label}</td>
                <td className="text-right">{tugrik(v)}</td>
              </tr>
            ))}
            <tr>
              <td className="font-bold">Нийт бодогдсон</td>
              <td className="text-right font-bold">{tugrik(row.grossSalary)}</td>
            </tr>
            <tr>
              <td>НДШ ({s.socialInsurancePct}%)</td>
              <td className="text-right">−{tugrik(row.socialInsuranceMnt)}</td>
            </tr>
            <tr>
              <td>ХХОАТ ({s.incomeTaxPct}%)</td>
              <td className="text-right">−{tugrik(row.incomeTaxMnt)}</td>
            </tr>
            <tr>
              <td className="font-bold">Гарт олгох</td>
              <td className="text-right font-bold">{tugrik(row.netSalary)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs">{row.status === 'PAID' ? `Олгосон: ${row.paidAt ? new Date(row.paidAt).toLocaleDateString('mn-MN') : ''}` : 'Ноорог — хараахан олгоогүй'}</p>
        <div className="grid grid-cols-2 gap-8 pt-8 text-xs">
          <p>Олгосон: ____________</p>
          <p>Хүлээн авсан: ____________ /{row.user.fullName}/</p>
        </div>
      </section>
      <style>{`
        @media print { .no-print { display: none !important; } @page { size: A5 portrait; margin: 10mm; } }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
      `}</style>
    </div>
  );
}
