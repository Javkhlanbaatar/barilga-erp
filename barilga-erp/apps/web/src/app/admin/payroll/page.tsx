'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { AuthUser, PayrollReport, ROLE_LABEL } from '@/lib/types';
import { OVERSIGHT_ROLES, hasRole, homeForRole } from '@/lib/rbac';

const PAYROLL_STATUS_LABEL: Record<string, string> = { DRAFT: 'Ноорог', PAID: 'Олгосон' };

export default function PayrollPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const load = useCallback(async (month: string) => {
    setLoading(true);
    setError('');
    try {
      setReport(await api<PayrollReport>(`/hr/payroll?periodMonth=${month}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Цалин ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const parsed = raw ? (JSON.parse(raw) as AuthUser) : null;
    if (!hasRole(parsed?.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(parsed?.role));
      return;
    }
    setUser(parsed);
    setAllowed(true);
  }, [router]);

  useEffect(() => {
    if (allowed) void load(period);
  }, [allowed, load, period]);

  async function markPaid(id: string) {
    setError('');
    try {
      await api(`/hr/payroll/${id}/pay`, { method: 'PATCH', body: '{}' });
      await load(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Төлбөр бүртгэж чадсангүй');
    }
  }

  if (!allowed) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Цалин</p>
          <h2 className="text-xl font-bold">Сарын цалин</h2>
          <p className="text-slate-400 text-sm mt-1">
            Үндсэн цалин + гүйцэтгэсэн тасалбар тутамд {tugrik(report?.rates.ticketBonusMnt ?? 15000)}
            {report ? ` + ${(report.rates.salesCommissionBps / 100).toFixed(2)}% кассчны борлуулалтаас` : ''}.
          </p>
        </div>
        <label className="text-xs text-slate-400">
          Сар
          <input
            type="month"
            className="mt-1 block"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>
      </div>
      {error && <p className="text-red-400 mb-3">{error}</p>}
      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Ажилтан</th>
              <th>Албан тушаал</th>
              <th className="text-right">Тасалбар</th>
              <th className="text-right">Борлуулалт</th>
              <th className="text-right">Үндсэн</th>
              <th className="text-right">Урамшуулал</th>
              <th className="text-right">Гарт олгох</th>
              <th>Төлөв</th>
              {user?.role === 'ADMIN' && <th />}
            </tr>
          </thead>
          <tbody>
            {(report?.rows ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-800">
                <td className="p-3 font-medium">{row.user.fullName}</td>
                <td>{ROLE_LABEL[row.user.role]}</td>
                <td className="text-right">{row.ticketCount}</td>
                <td className="text-right">{tugrik(row.salesAmountMnt)}</td>
                <td className="text-right">{tugrik(row.baseSalary)}</td>
                <td className="text-right">{tugrik(row.fulfillmentBonus)}</td>
                <td className="text-right font-semibold">{tugrik(row.netSalary)}</td>
                <td>{PAYROLL_STATUS_LABEL[row.status] ?? row.status}</td>
                {user?.role === 'ADMIN' && (
                  <td className="pr-3 text-right">
                    {row.status === 'DRAFT' && (
                      <button className="btn-ghost text-xs px-3 py-1" onClick={() => void markPaid(row.id)}>
                        Олгосон гэж тэмдэглэх
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Тооцоолж байна…</p>}
      </div>
    </Shell>
  );
}
