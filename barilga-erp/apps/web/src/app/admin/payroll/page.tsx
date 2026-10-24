'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { AuthUser, PayrollReport, PayrollRow, PayrollSettings, ROLE_LABEL, Role } from '@/lib/types';
import { OVERSIGHT_ROLES, TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';
import { useCan } from '@/lib/permissions';

const PAYROLL_STATUS_LABEL: Record<string, string> = { DRAFT: 'Ноорог', PAID: 'Олгосон' };
const ROLES: Role[] = ['ADMIN', 'SUPER_MANAGER', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date()).slice(0, 7);
const nextMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

type DayMark = 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'SICK' | 'ANNUAL_LEAVE' | 'BUSINESS_TRIP' | 'ABSENT' | 'DAY_OFF';
const MARK_LABEL: Record<DayMark, string> = {
  ABSENT: 'Тасалсан',
  UNPAID_LEAVE: 'Цалингүй чөлөө',
  SICK: 'Өвчтэй',
  PAID_LEAVE: 'Цалинтай чөлөө',
  ANNUAL_LEAVE: 'Ээлжийн амралт',
  BUSINESS_TRIP: 'Томилолт',
  DAY_OFF: 'Амралтын өдөр',
};
/** A payroll row with the month's day statuses from the attendance page (days per status). */
type RowWithMarks = PayrollRow & { attendanceMarks?: Partial<Record<DayMark, number>> };
/** 'Тасалсан 2 · Цалингүй чөлөө 1' — empty when the month has no day statuses. */
function marksLine(r: PayrollRow) {
  const m = (r as RowWithMarks).attendanceMarks ?? {};
  return (Object.keys(MARK_LABEL) as DayMark[])
    .filter((k) => (m[k] ?? 0) > 0)
    .map((k) => `${MARK_LABEL[k]} ${m[k]}`)
    .join(' · ');
}

/** One line of GET /hr/payroll/salary/:userId — a base salary in force from `fromMonth` on. */
type SalaryRate = {
  id: string;
  fromMonth: string;
  baseSalaryMnt: number | null;
  reason: string | null;
  createdAt: string;
  createdBy: { fullName: string } | null;
};

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
  const [salaryFor, setSalaryFor] = useState<PayrollRow | null>(null);
  const canDo = useCan();
  const isAdmin = user?.role === 'ADMIN';
  const canPay = hasRole(user?.role, TOP_ROLES);
  const maySalary = canPay && canDo('SALARY_SET');
  const mayAdjust = canDo('PAYROLL_ADJUST');
  // Same rules as the API: nobody sets their own salary, and only the admin sets an admin's or the general manager's.
  const maySetSalary = (r: PayrollRow) => maySalary && (isAdmin || (r.user.id !== user?.id && !TOP_ROLES.includes(r.user.role)));

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

  // Paying a month that has not ended locks its remaining days: attendance can no longer be recorded for them.
  const notOver = period >= thisMonth();
  const markPaid = (r: PayrollRow) =>
    window.confirm(
      `${r.user.fullName}: гарт олгох ${tugrik(r.netSalary)}-ийг олгосон гэж бүртгэх үү?` +
        (notOver ? `\n\nАнхаар: ${period} сар дуусаагүй байна. Олгосон гэж тэмдэглэвэл энэ сарын үлдсэн өдрүүдийн ирцийг бүртгэх, засах боломжгүй болно.` : '') +
        '\n\nДараа нь зөвхөн «Буцааж нээх»-ээр өөрчилнө.',
    ) && void run(() => api(`/hr/payroll/${r.id}/pay`, { method: 'PATCH', body: '{}' }));

  /**
   * Undo «олгосон» for these rows, with one reason. The general manager does not reopen his own pay or a top
   * role's (the admin does), as for setting a salary.
   */
  const mayReopen = (r: PayrollRow) => maySetSalary(r);
  const reopen = (rows: PayrollRow[]) => {
    const allowed = rows.filter(mayReopen);
    if (!allowed.length) return;
    const who = allowed.length === 1 ? allowed[0].user.fullName : `${allowed.length} ажилтны`;
    const skipped = rows.length - allowed.length;
    const reason = window.prompt(
      `${who} ${period} сарын цалинг «олгосон»-оос буцааж нээх шалтгаан (3-аас доошгүй тэмдэгт)${skipped ? ` — өөрийн болон дээд албан тушаалын ${skipped} мөрийг админ нээнэ` : ''}:`,
    );
    if (reason === null) return;
    if (reason.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    void (async () => {
      setError('');
      try {
        for (const r of allowed) await api(`/hr/payroll/${r.id}/reopen`, { method: 'PATCH', body: JSON.stringify({ reason: reason.trim() }) });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Алдаа');
      } finally {
        // Some rows may already be reopened when one fails: show the table as it is now.
        await load(period);
      }
    })();
  };

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
      {report && maySalary && report.rows.some((r) => r.status === 'PAID') && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 p-3 text-xs text-slate-400">
          <span className="mr-auto">
            Олгосон сарын ирц, цалинг өөрчлөхгүй. Андуурсан эсвэл сар дуусаагүй байхад тэмдэглэсэн бол буцааж нээнэ (шалтгаан нь засварын түүхэд үлдэнэ).
          </span>
          <button className="btn-ghost text-xs" onClick={() => reopen(report.rows.filter((r) => r.status === 'PAID'))}>
            Олгосон бүгдийг буцааж нээх
          </button>
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
                mayPay={maySalary}
                mayAdjust={mayAdjust}
                maySalary={maySetSalary(r)}
                isMe={r.user.id === user.id}
                isAdmin={isAdmin}
                open={open === r.id}
                onToggle={() => setOpen(open === r.id ? null : r.id)}
                onSalary={() => setSalaryFor(r)}
                onPaid={() => markPaid(r)}
                onReopen={() => reopen([r])}
                mayReopen={mayReopen(r)}
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
        Мөр дээр дарж урамшуулал, суутгал нэмнэ. Үндсэн цалинг аль сараас мөрдөхийг сонгож тогтооно — өмнөх сарууд хэвээр үлдэнэ. «Олгосон»
        гэж бүртгэсэн сар өөрчлөгдөхгүй. Автомат томьёо (захиалга тутмын урамшуулал, %, НДШ, ХХОАТ) хэрэгтэй бол «Модулиуд» хэсгээс асаана.
      </p>
      {salaryFor && (
        <SalaryModal
          r={salaryFor}
          period={period}
          formula={formula}
          onClose={() => setSalaryFor(null)}
          onSaved={() => {
            setSalaryFor(null);
            void load(period);
          }}
        />
      )}
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
  /** Admin or general manager (may write bonuses/deductions on their own pay). */
  canPay: boolean;
  /** May mark a month paid (top role + SALARY_SET). */
  mayPay: boolean;
  /** PAYROLL_ADJUST: bonuses and deductions. */
  mayAdjust: boolean;
  /** May set this person's base salary. */
  maySalary: boolean;
  isMe: boolean;
  /** Only the admin writes bonuses/deductions on their own row. */
  isAdmin: boolean;
  open: boolean;
  period: string;
  onToggle: () => void;
  onSalary: () => void;
  onPaid: () => void;
  onReopen: () => void;
  mayReopen: boolean;
  onAdd: (amountMnt: number, reason: string) => Promise<void> | void;
  onRemove: (id: string) => void;
}) {
  const { r, formula, canPay, open } = props;
  const paid = r.status === 'PAID';
  const canAdjust = props.mayAdjust && !paid && (!props.isMe || props.isAdmin);
  const marks = marksLine(r);
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
          {marks && <p className="text-[11px] text-amber-300">{marks}</p>}
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
              {r.salesAmountMnt > 0 && <p className="text-[11px] text-slate-500">{tugrik(r.salesAmountMnt)}-өөс</p>}
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
            <div className="mb-3 space-y-1 rounded-md border border-slate-800 p-2 text-xs">
              <p className="font-semibold text-slate-300">Ирцийн төлөв ({props.period})</p>
              <p className={marks ? 'text-amber-300' : 'text-slate-500'}>{marks || 'Тасалсан, чөлөөтэй өдөр алга.'}</p>
              <p className="text-slate-500">
                Төлөв цалинг автоматаар өөрчлөхгүй. Хасах, нэмэх бол доор суутгал / урамшууллыг гараар бичнэ.{' '}
                <a className="text-amber-brand hover:underline" href={`/admin/attendance?tab=month&month=${props.period}`}>
                  Сарын ирц харах
                </a>
              </p>
            </div>
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
                {props.mayAdjust && props.isMe && !props.isAdmin && !paid && <p className="text-slate-500">Өөрийн цалинд урамшуулал/суутгал бичихгүй.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="btn-ghost text-xs" href={`/print/payslip?period=${props.period}&user=${r.user.id}`} target="_blank" rel="noreferrer">
                  Цалингийн хуудас
                </a>
                {props.maySalary && (
                  <button className="btn-ghost text-xs" onClick={props.onSalary}>
                    Үндсэн цалин оруулах
                  </button>
                )}
                {props.mayPay && !paid && (
                  <button className="btn-primary text-xs" onClick={props.onPaid}>
                    Олгосон
                  </button>
                )}
                {props.mayPay && paid && props.mayReopen && (
                  <button className="btn-ghost text-xs" onClick={props.onReopen}>
                    Буцааж нээх
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Base salary from a chosen month on (earlier months keep theirs), with the person's salary history.
 * For a month already paid it starts at the next month — the API refuses a paid month.
 */
function SalaryModal(props: { r: PayrollRow; period: string; formula: boolean; onClose: () => void; onSaved: () => void }) {
  const { r } = props;
  const none = props.formula ? 'анхдагч' : 'цалингүй';
  const [amount, setAmount] = useState(r.customBase ? String(r.baseSalary) : '');
  const [fromMonth, setFromMonth] = useState(r.status === 'PAID' ? nextMonth(props.period) : props.period);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<SalaryRate[] | null>(null);
  const [historyError, setHistoryError] = useState('');

  useEffect(() => {
    let alive = true;
    api<SalaryRate[]>(`/hr/payroll/salary/${r.user.id}`)
      .then((rows) => alive && setHistory(rows))
      .catch((err) => alive && setHistoryError(err instanceof Error ? err.message : 'Түүх ачаалж чадсангүй'));
    return () => {
      alive = false;
    };
  }, [r.user.id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const raw = amount.trim();
    const value = raw === '' ? null : Math.round(Number(raw.replace(/[\s,]/g, '')));
    if (value !== null && !(value >= 0 && value <= 100_000_000)) return setError('Цалин буруу байна');
    if (!/^\d{4}-\d{2}$/.test(fromMonth)) return setError('Хэдэн сараас мөрдөхийг сонгоно уу');
    setSaving(true);
    try {
      await api(`/hr/payroll/salary/${r.user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ baseSalaryMnt: value, fromMonth, reason: reason.trim() || undefined }),
      });
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <form onSubmit={save} className="card max-h-[90vh] w-full max-w-md space-y-3 overflow-auto">
        <div>
          <h3 className="text-lg font-semibold">Үндсэн цалин</h3>
          <p className="text-xs text-slate-400">
            {r.user.fullName} · {ROLE_LABEL[r.user.role]}
          </p>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          Сарын үндсэн цалин ₮
          <input
            className="mt-1 w-full"
            inputMode="numeric"
            autoFocus
            placeholder={`Хоосон = ${props.formula ? 'албан тушаалын анхдагч' : 'цалингүй'}`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block text-xs text-slate-400">
          Хэдэн сараас
          <input type="month" className="mt-1 w-full" required value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} />
          <span className="mt-1 block text-[11px] text-slate-500">Энэ сараас хойш мөрдөнө; өмнөх сарууд хэвээр. Олгосон сараас эхлүүлэхгүй.</span>
        </label>
        <label className="block text-xs text-slate-400">
          Шалтгаан (заавал биш)
          <input
            className="mt-1 w-full"
            maxLength={200}
            placeholder="Албан тушаал ахисан, гэрээ шинэчилсэн…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="border-t border-slate-800 pt-2">
          <p className="text-xs font-semibold text-slate-300">Цалингийн түүх</p>
          {history === null && !historyError && <p className="mt-1 text-xs text-slate-500">Уншиж байна…</p>}
          {historyError && <p className="mt-1 text-xs text-red-400">{historyError}</p>}
          {history?.length === 0 && <p className="mt-1 text-xs text-slate-500">Түүх алга.</p>}
          {history && history.length > 0 && (
            <ul className="mt-1 max-h-48 divide-y divide-slate-800 overflow-auto text-xs">
              {history.map((h) => (
                <li key={h.id} className="py-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono text-slate-300">{h.fromMonth} сараас</span>
                    <span className={h.baseSalaryMnt === null ? 'text-slate-500' : 'font-semibold'}>
                      {h.baseSalaryMnt === null ? none : tugrik(h.baseSalaryMnt)}
                    </span>
                  </div>
                  <p className="text-slate-500">
                    {h.reason ? `${h.reason} · ` : ''}
                    {h.createdBy?.fullName ?? 'өмнө тогтоосон'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={props.onClose}>
            Болих
          </button>
          <button className="btn-primary" disabled={saving}>
            {saving ? 'Хадгалж байна…' : 'Хадгалах'}
          </button>
        </div>
      </form>
    </div>
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
