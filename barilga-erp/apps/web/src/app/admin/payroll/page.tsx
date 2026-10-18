'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { AuthUser, PayrollReport, PayrollRow, PayrollSettings, ROLE_LABEL, Role } from '@/lib/types';
import { OVERSIGHT_ROLES, TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';

const PAYROLL_STATUS_LABEL: Record<string, string> = { DRAFT: 'Ноорог', PAID: 'Олгосон' };
const ROLES: Role[] = ['ADMIN', 'SUPER_MANAGER', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date()).slice(0, 7);

/**
 * Monthly payroll. By default it is entered by hand: each person's base salary plus the bonuses and
 * deductions written for the month. With the PAYROLL_FORMULA module on, the per-order bonus, cashier
 * commission, insurance and income tax are added automatically.
 */
export default function PayrollPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [period, setPeriod] = useState(thisMonth);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const isAdmin = user?.role === 'ADMIN';
  const canPay = hasRole(user?.role, TOP_ROLES);

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
  }, [router]);

  useEffect(() => {
    if (user) void load(period);
  }, [user, load, period]);

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await load(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа');
    }
  }

  const markPaid = (r: PayrollRow) =>
    window.confirm(`${r.user.fullName}: гарт олгох ${tugrik(r.netSalary)}-ийг олгосон гэж бүртгэх үү? Дараа нь өөрчлөгдөхгүй.`) &&
    void run(() => api(`/hr/payroll/${r.id}/pay`, { method: 'PATCH', body: '{}' }));

  function setSalary(r: PayrollRow) {
    const hint = report?.formula ? 'Хоосон = албан тушаалын анхдагч' : 'Хоосон = цалингүй (0)';
    const raw = window.prompt(`${r.user.fullName}-ийн сарын үндсэн цалин (₮). ${hint}:`, r.customBase ? String(r.baseSalary) : '');
    if (raw === null) return;
    const value = raw.trim() === '' ? null : Math.round(Number(raw.replace(/[\s,]/g, '')));
    if (value !== null && !(value >= 0)) return setError('Цалин буруу байна');
    void run(() => api(`/hr/payroll/salary/${r.user.id}`, { method: 'PUT', body: JSON.stringify({ baseSalaryMnt: value }) }));
  }

  function downloadCsv() {
    if (!report) return;
    const head = ['Ажилтан', 'Албан тушаал', 'Үндсэн цалин', 'Урамшуулал', 'Суутгал'];
    if (report.formula) head.push('Бэлтгэлийн урамшуулал', 'Борлуулалтын шагнал', 'НДШ', 'ХХОАТ');
    head.push('Гарт олгох', 'Төлөв', 'Олгосон огноо');
    const lines = report.rows.map((r) => {
      const cells: Array<string | number> = [r.user.fullName, ROLE_LABEL[r.user.role], r.earnedBase, r.bonusMnt, r.deductionMnt];
      if (report.formula) cells.push(r.ticketBonus, r.salesBonus, r.socialInsuranceMnt, r.incomeTaxMnt);
      cells.push(r.netSalary, PAYROLL_STATUS_LABEL[r.status], r.paidAt ? r.paidAt.slice(0, 10) : '');
      return cells;
    });
    const csv = [head, ...lines].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `tsalin-${report.periodMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!user) return <div className="p-8 text-slate-400">Уншиж байна…</div>;
  const s = report?.settings;
  const formula = report?.formula ?? false;
  const cols = formula ? 10 : 6;

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Цалин</h2>
          {report && (
            <p className="mt-1 text-sm text-slate-400">
              {formula && s
                ? `Үндсэн цалин${s.prorateByAttendance ? ` (ирцээр, ${report.workingDays} ажлын өдөр)` : ''} + бэлтгэсэн захиалга тутамд ${tugrik(s.ticketBonusMnt)} + кассчны борлуулалтаас ${s.salesCommissionPct}% + урамшуулал − суутгал − НДШ ${s.socialInsurancePct}% − ХХОАТ ${s.incomeTaxPct}%`
                : 'Үндсэн цалин + урамшуулал − суутгал. Бүгдийг гараар оруулна.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-400">
            Сар
            <input type="month" className="mt-1 block" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </label>
          <a className="btn-ghost text-sm" href={`/print/payroll?period=${period}`} target="_blank" rel="noreferrer">
            Цалингийн тайлан
          </a>
          <button className="btn-ghost text-sm" onClick={downloadCsv} disabled={!report}>
            Excel (CSV)
          </button>
          {isAdmin && formula && (
            <button className="btn-ghost text-sm" onClick={() => setShowSettings((v) => !v)}>
              Томьёоны тохиргоо
            </button>
          )}
        </div>
      </div>

      {isAdmin && formula && showSettings && s && <SettingsForm settings={s} onSaved={() => void load(period)} />}
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {report && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Үндсэн цалин" value={report.totals.base} />
          <Stat label="Урамшуулал" value={report.totals.bonus} />
          <Stat label={formula ? 'Суутгал + НДШ + ХХОАТ' : 'Суутгал'} value={report.totals.deduction + report.totals.insurance + report.totals.tax} />
          <Stat label={`Гарт олгох · олгосон ${tugrik(report.totals.paid)}`} value={report.totals.net} accent />
        </div>
      )}

      <div className="card overflow-auto p-0">
        <table className={`w-full text-sm ${formula ? 'min-w-[980px]' : 'min-w-[640px]'}`}>
          <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
            <tr>
              <th className="p-3">Ажилтан</th>
              <th className="text-right">Үндсэн цалин</th>
              {formula && (
                <>
                  <th className="text-right">Ирц</th>
                  <th className="text-right">Бэлтгэл</th>
                  <th className="text-right">Борлуулалт</th>
                </>
              )}
              <th className="text-right">Урамшуулал</th>
              <th className="text-right">Суутгал</th>
              {formula && <th className="text-right">НДШ + ХХОАТ</th>}
              <th className="text-right">Гарт олгох</th>
              <th className="pr-3 text-right">Төлөв</th>
            </tr>
          </thead>
          <tbody>
            {report?.rows.map((r) => (
              <FragmentRow
                key={r.id}
                r={r}
                formula={formula}
                cols={cols}
                canPay={canPay}
                isMe={r.user.id === user.id}
                open={open === r.id}
                onToggle={() => setOpen(open === r.id ? null : r.id)}
                onSalary={() => setSalary(r)}
                onPaid={() => markPaid(r)}
                onAdd={(amountMnt, reason) =>
                  run(() => api('/hr/payroll/adjustments', { method: 'POST', body: JSON.stringify({ userId: r.user.id, periodMonth: period, amountMnt, reason }) }))
                }
                onRemove={(id) => run(() => api(`/hr/payroll/adjustments/${id}`, { method: 'DELETE' }))}
                period={period}
              />
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-sm text-slate-500">Уншиж байна…</p>}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Мөр дээр дарж урамшуулал, суутгал нэмнэ. Үндсэн цалинг админ эсвэл ерөнхий менежер тохируулж, «Олгосон» гэж бүртгэнэ; олгосон сар
        өөрчлөгдөхгүй. Автомат томьёо (захиалга тутмын урамшуулал, %, НДШ, ХХОАТ) хэрэгтэй бол «Модулиуд» хэсгээс асаана.
      </p>
    </Shell>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <article className="card">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-xl font-bold ${accent ? 'text-amber-brand' : ''}`}>{tugrik(value)}</p>
    </article>
  );
}

function FragmentRow(props: {
  r: PayrollRow;
  formula: boolean;
  cols: number;
  canPay: boolean;
  isMe: boolean;
  open: boolean;
  period: string;
  onToggle: () => void;
  onSalary: () => void;
  onPaid: () => void;
  onAdd: (amountMnt: number, reason: string) => Promise<void> | void;
  onRemove: (id: string) => void;
}) {
  const { r, formula, canPay, open } = props;
  const paid = r.status === 'PAID';
  const canAdjust = !paid && (!props.isMe || canPay);
  const [kind, setKind] = useState<'bonus' | 'deduction'>('bonus');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  async function add(e: FormEvent) {
    e.preventDefault();
    const n = Math.abs(Math.round(Number(amount.replace(/[\s,]/g, ''))));
    if (!n || reason.trim().length < 3) return;
    await props.onAdd(kind === 'bonus' ? n : -n, reason.trim());
    setAmount('');
    setReason('');
  }
  return (
    <>
      <tr className="border-t border-slate-800 hover:bg-steel-800 cursor-pointer" onClick={props.onToggle}>
        <td className="p-3">
          <p className="font-medium">
            {r.user.fullName}
            {r.user.isActive === false && <span className="ml-1 text-[10px] text-slate-500">(гарсан)</span>}
          </p>
          <p className="text-[11px] text-slate-500">{ROLE_LABEL[r.user.role]}</p>
        </td>
        <td className="text-right whitespace-nowrap">
          {tugrik(r.earnedBase)}
          {r.earnedBase !== r.baseSalary && <p className="text-[11px] text-slate-500">/ {tugrik(r.baseSalary)}</p>}
          {!r.customBase && <p className="text-[10px] text-amber-400">{formula ? 'анхдагч' : 'оруулаагүй'}</p>}
        </td>
        {formula && (
          <>
            <td className="text-right text-xs">
              {r.workedDays}/{r.workingDays}
            </td>
            <td className="text-right whitespace-nowrap">
              {tugrik(r.ticketBonus)}
              <p className="text-[11px] text-slate-500">{r.ticketCount} захиалга</p>
            </td>
            <td className="text-right whitespace-nowrap">
              {tugrik(r.salesBonus)}
              {r.salesAmountMnt > 0 && <p className="text-[11px] text-slate-500">{tugrik(r.salesAmountMnt)}-аас</p>}
            </td>
          </>
        )}
        <td className="text-right whitespace-nowrap text-emerald-300">{r.bonusMnt ? tugrik(r.bonusMnt) : '—'}</td>
        <td className="text-right whitespace-nowrap text-red-300">{r.deductionMnt ? `−${tugrik(r.deductionMnt)}` : '—'}</td>
        {formula && <td className="text-right whitespace-nowrap text-slate-400">{tugrik(r.socialInsuranceMnt + r.incomeTaxMnt)}</td>}
        <td className="text-right whitespace-nowrap font-semibold text-amber-brand">{tugrik(r.netSalary)}</td>
        <td className="pr-3 text-right">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${paid ? 'border-emerald-700 text-emerald-300' : 'border-slate-600 text-slate-300'}`}>
            {PAYROLL_STATUS_LABEL[r.status]}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-slate-800 bg-steel-900/60">
          <td colSpan={props.cols} className="p-3">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1 text-xs">
                <p className="font-semibold text-slate-300">Урамшуулал / суутгал ({props.period})</p>
                {r.adjustments.length === 0 && <p className="text-slate-500">Алга.</p>}
                {r.adjustments.map((a) => (
                  <p key={a.id}>
                    <span className={a.amountMnt < 0 ? 'text-red-300' : 'text-emerald-300'}>
                      {a.amountMnt < 0 ? 'Суутгал' : 'Урамшуулал'} {tugrik(Math.abs(a.amountMnt))}
                    </span>{' '}
                    — {a.reason} <span className="text-slate-500">({a.by})</span>
                    {canAdjust && (
                      <button className="ml-2 text-red-300 hover:underline" onClick={() => props.onRemove(a.id)}>
                        устгах
                      </button>
                    )}
                  </p>
                ))}
                {canAdjust && (
                  <form onSubmit={add} className="mt-2 flex flex-wrap gap-2">
                    <select value={kind} onChange={(e) => setKind(e.target.value as 'bonus' | 'deduction')}>
                      <option value="bonus">Урамшуулал (+)</option>
                      <option value="deduction">Суутгал (−)</option>
                    </select>
                    <input className="w-32" inputMode="numeric" placeholder="Дүн ₮" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <input
                      className="w-56"
                      placeholder={kind === 'bonus' ? 'Шалтгаан (борлуулалт, илүү цаг…)' : 'Шалтгаан (урьдчилгаа, торгууль…)'}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button className="btn-ghost text-xs">Нэмэх</button>
                  </form>
                )}
                {props.isMe && !canPay && !paid && <p className="text-slate-500">Өөрийн цалинд урамшуулал/суутгал бичихгүй.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="btn-ghost text-xs" href={`/print/payslip?period=${props.period}&user=${r.user.id}`} target="_blank" rel="noreferrer">
                  Цалингийн хуудас
                </a>
                {canPay && !paid && (
                  <>
                    <button className="btn-ghost text-xs" onClick={props.onSalary}>
                      Үндсэн цалин оруулах
                    </button>
                    <button className="btn-primary text-xs" onClick={props.onPaid}>
                      Олгосон
                    </button>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SettingsForm({ settings, onSaved }: { settings: PayrollSettings; onSaved: () => void }) {
  const [form, setForm] = useState(settings);
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      await api('/hr/payroll/settings', { method: 'PUT', body: JSON.stringify(form) });
      setMsg('Хадгалагдлаа');
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    }
  }
  const num = (k: keyof PayrollSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  return (
    <form onSubmit={save} className="card mb-4 grid gap-3 md:grid-cols-4">
      <p className="md:col-span-4 font-semibold">Цалингийн томьёоны тохиргоо</p>
      {ROLES.map((role) => (
        <label key={role} className="text-xs text-slate-400">
          {ROLE_LABEL[role]} — анхдагч цалин ₮
          <input
            className="mt-1 block w-full"
            type="number"
            min={0}
            value={form.defaultBaseMnt[role] ?? 0}
            onChange={(e) => setForm({ ...form, defaultBaseMnt: { ...form.defaultBaseMnt, [role]: Number(e.target.value) } })}
          />
        </label>
      ))}
      <label className="text-xs text-slate-400">
        Бэлтгэсэн захиалга тутамд ₮
        <input className="mt-1 block w-full" type="number" min={0} value={form.ticketBonusMnt} onChange={num('ticketBonusMnt')} />
      </label>
      <label className="text-xs text-slate-400">
        Кассчны борлуулалтын шагнал %
        <input className="mt-1 block w-full" type="number" min={0} max={100} step="0.01" value={form.salesCommissionPct} onChange={num('salesCommissionPct')} />
      </label>
      <label className="text-xs text-slate-400">
        Ажилтны НДШ %
        <input className="mt-1 block w-full" type="number" min={0} max={100} step="0.01" value={form.socialInsurancePct} onChange={num('socialInsurancePct')} />
      </label>
      <label className="text-xs text-slate-400">
        ХХОАТ %
        <input className="mt-1 block w-full" type="number" min={0} max={100} step="0.01" value={form.incomeTaxPct} onChange={num('incomeTaxPct')} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.prorateByAttendance} onChange={(e) => setForm({ ...form, prorateByAttendance: e.target.checked })} />
        Үндсэн цалинг ирцээр бодох
      </label>
      <label className="text-xs text-slate-400">
        Долоо хоногт ажлын өдөр
        <select className="mt-1 block w-full" value={form.workDaysPerWeek} onChange={num('workDaysPerWeek') as never}>
          <option value={5}>5 (Да–Ба)</option>
          <option value={6}>6 (Да–Бя)</option>
          <option value={7}>7 (өдөр бүр)</option>
        </select>
      </label>
      <div className="md:col-span-4 flex items-center gap-3">
        <button className="btn-primary text-sm">Хадгалах</button>
        {msg && <span className="text-xs text-slate-400">{msg}</span>}
      </div>
    </form>
  );
}
