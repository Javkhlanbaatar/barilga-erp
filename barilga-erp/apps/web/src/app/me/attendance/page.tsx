'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/shell';
import { Modal } from '@/components/modal';
import { api } from '@/lib/api';
import { useCan } from '@/lib/permissions';

// ───────── Types of GET /hr/me/attendance (declared here; lib/types.ts is not touched) ─────────

type DayMark = 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'SICK' | 'ANNUAL_LEAVE' | 'BUSINESS_TRIP' | 'ABSENT' | 'DAY_OFF';
/** What a person may ask for; «Тасалсан» and «Амралтын өдөр» are set by a manager. */
type LeaveKind = 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'SICK' | 'ANNUAL_LEAVE' | 'BUSINESS_TRIP';
type SelfMode = 'OFF' | 'CONFIRM' | 'AUTO';
type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
type DayRecord = {
  id: string;
  checkIn: string;
  checkOut: string | null;
  status: 'ON_TIME' | 'LATE' | 'OVERTIME';
  confirmed: boolean;
  source: string;
};
type Day = { date: string; working: boolean; holiday: boolean; beforeStart?: boolean; records: DayRecord[]; mark: DayMark | null; note: string | null };
type MyRequest = {
  id: string;
  kind: LeaveKind;
  fromDate: string;
  toDate: string;
  reason: string;
  status: LeaveStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
};
type MyMonth = {
  periodMonth: string;
  today: string;
  settings: { selfCheckIn: SelfMode; shiftStart: string; shiftEnd: string; graceMinutes: number };
  open: { id: string; checkIn: string; confirmed: boolean } | null;
  workingDays: number;
  presentDays: number;
  waiting: number;
  days: Day[];
  requests: MyRequest[];
};

// ───────── Day codes (the same letters and colours as the managers' month grid) ─────────

const MARK: Record<DayMark, { label: string; code: string; tone: string }> = {
  PAID_LEAVE: { label: 'Цалинтай чөлөө', code: 'Ч', tone: 'bg-sky-900/70 text-sky-200 border-sky-700' },
  UNPAID_LEAVE: { label: 'Цалингүй чөлөө', code: 'Ч−', tone: 'bg-indigo-900/70 text-indigo-200 border-indigo-600' },
  SICK: { label: 'Өвчтэй', code: 'Ө', tone: 'bg-pink-900/70 text-pink-200 border-pink-700' },
  ANNUAL_LEAVE: { label: 'Ээлжийн амралт', code: 'ЭА', tone: 'bg-teal-900/70 text-teal-200 border-teal-700' },
  BUSINESS_TRIP: { label: 'Томилолт', code: 'Т', tone: 'bg-violet-900/70 text-violet-200 border-violet-600' },
  ABSENT: { label: 'Тасалсан', code: '✕', tone: 'bg-red-900/70 text-red-200 border-red-700' },
  DAY_OFF: { label: 'Амралтын өдөр', code: 'А', tone: 'bg-slate-700/60 text-slate-200 border-slate-500' },
};
type State = 'present' | 'late' | 'waiting' | 'holiday' | 'off' | 'none' | 'empty';
const STATE: Record<State, { label: string; code: string; tone: string }> = {
  present: { label: 'Ирсэн', code: '✓', tone: 'bg-emerald-900/70 text-emerald-200 border-emerald-700' },
  late: { label: 'Хоцорсон', code: 'Х', tone: 'bg-amber-900/60 text-amber-200 border-amber-600' },
  waiting: { label: 'Батлаагүй — менежер батлахыг хүлээж байна', code: 'Б', tone: 'border-dashed border-yellow-500 bg-yellow-900/20 text-yellow-200' },
  holiday: { label: 'Нийтийн амралтын өдөр', code: 'НА', tone: 'bg-steel-800 text-slate-300 border-slate-600' },
  off: { label: 'Ажлын бус өдөр', code: '·', tone: 'bg-steel-950 text-slate-600 border-slate-800' },
  none: { label: 'Бүртгэлгүй (ирц ч, төлөв ч алга)', code: '?', tone: 'border-red-800 text-red-300' },
  empty: { label: '', code: '', tone: 'border-slate-800 text-slate-500' },
};
const LEAVE_KINDS: LeaveKind[] = ['PAID_LEAVE', 'UNPAID_LEAVE', 'SICK', 'ANNUAL_LEAVE', 'BUSINESS_TRIP'];
const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: string }> = {
  PENDING: { label: 'Хүлээгдэж байна', tone: 'border-amber-600 text-amber-200' },
  APPROVED: { label: 'Зөвшөөрсөн', tone: 'border-emerald-700 text-emerald-300' },
  REJECTED: { label: 'Татгалзсан', tone: 'border-red-700 text-red-300' },
  CANCELLED: { label: 'Цуцалсан', tone: 'border-slate-600 text-slate-400' },
};
const STATUS_LABEL: Record<DayRecord['status'], string> = { ON_TIME: 'Цагтаа', LATE: 'Хоцорсон', OVERTIME: 'Илүү цаг' };
/** Monday first, as the shop's week. */
const WEEK_HEAD = ['Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя', 'Ня'];
const WEEKDAY = ['Ням', 'Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба'];

// Ulaanbaatar is UTC+08:00 all year; times are shown in the shop's time whatever the phone's zone.
const UB_OFFSET_MS = 8 * 3_600_000;
const toUbLocal = (t: string | Date) => new Date(new Date(t).getTime() + UB_OFFSET_MS).toISOString().slice(0, 16);
const ubDay = (t: string | Date) => toUbLocal(t).slice(0, 10);
const ubTime = (t: string | Date) => toUbLocal(t).slice(11, 16);
const thisMonth = () => toUbLocal(new Date()).slice(0, 7);
/** Same rule as the API: a check-in from an earlier day is forgotten only after 16 h (a shift may run past midnight). */
const MAX_SHIFT_MS = 16 * 3_600_000;
const isStale = (checkIn: string, today: string) => ubDay(checkIn) < today && Date.now() - new Date(checkIn).getTime() > MAX_SHIFT_MS;
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
const minutesOf = (iso: string) => hhmm(ubTime(iso));
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/** What a day shows: a status beats a check-in; a confirmed check-in beats one waiting for a manager. */
function stateOf(d: Day, today: string, lateAfter: number): State | DayMark {
  if (d.mark) return d.mark;
  const counted = d.records.filter((r) => r.confirmed);
  if (counted.length) return minutesOf(counted[0].checkIn) > lateAfter ? 'late' : 'present';
  if (d.records.length) return 'waiting';
  if (d.holiday) return 'holiday';
  if (!d.working) return 'off';
  if (d.date < today && !d.beforeStart) return 'none'; // before they started is not a missed day
  return 'empty';
}
const infoOf = (s: State | DayMark) => (s in MARK ? MARK[s as DayMark] : STATE[s as State]);

export default function MyAttendancePage() {
  const canDo = useCan();
  const [period, setPeriod] = useState(thisMonth);
  const [data, setData] = useState<MyMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const next = await api<MyMonth>(`/hr/me/attendance?periodMonth=${p}`);
      setData(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ирц ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  // The selected day follows the month: today when it is in it, otherwise nothing.
  useEffect(() => {
    if (!data) return;
    setSelected((cur) => (cur && cur.startsWith(data.periodMonth) ? cur : data.today.startsWith(data.periodMonth) ? data.today : null));
  }, [data]);

  async function punch(kind: 'in' | 'out') {
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      await api(kind === 'in' ? '/hr/me/check-in' : '/hr/me/check-out', { method: 'POST', body: '{}' });
      const at = ubTime(new Date());
      setNotice(
        kind === 'in'
          ? `Ирсэн цаг бүртгэгдлээ: ${at}.${data?.settings.selfCheckIn === 'CONFIRM' ? ' Менежер баталсны дараа ирцэд тооцогдоно.' : ''}`
          : `Явсан цаг бүртгэгдлээ: ${at}.`,
      );
      if (period !== thisMonth()) setPeriod(thisMonth());
      else await load(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Бүртгэж чадсангүй');
    } finally {
      setBusy(null);
    }
  }

  async function cancelRequest(id: string) {
    setBusy(id);
    setError('');
    try {
      await api(`/hr/me/leave/${id}/cancel`, { method: 'POST', body: '{}' });
      setCancelling(null);
      setNotice('Хүсэлт цуцлагдлаа.');
      await load(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Цуцалж чадсангүй');
    } finally {
      setBusy(null);
    }
  }

  const s = data?.settings;
  const today = data?.today ?? toUbLocal(new Date()).slice(0, 10);
  const lateAfter = s ? hhmm(s.shiftStart) + s.graceMinutes : 24 * 60;
  const open = data?.open ?? null;
  const stale = Boolean(open && isStale(open.checkIn, today));
  const atWork = Boolean(open && !stale);
  // Checked in yesterday and not out yet (within 16 h): leaving now, or a new day's arrival — both are offered.
  const overnight = Boolean(open && !stale && ubDay(open.checkIn) < today);
  const days = data?.periodMonth === period ? data.days : [];
  const lead = days.length ? (dow(days[0].date) + 6) % 7 : 0;
  const lateDays = days.filter((d) => stateOf(d, today, lateAfter) === 'late').length;
  const markCounts = new Map<DayMark, number>();
  for (const d of days) if (d.mark) markCounts.set(d.mark, (markCounts.get(d.mark) ?? 0) + 1);
  const sel = days.find((d) => d.date === selected) ?? null;

  return (
    <Shell>
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Хүний нөөц</p>
            <h2 className="text-xl font-bold">Миний ирц</h2>
            {s && (
              <p className="mt-1 text-sm text-slate-400">
                Ажлын цаг {s.shiftStart}–{s.shiftEnd}. {s.shiftStart}-с хойш {s.graceMinutes} минут хүртэл хоцролтод тооцохгүй.
              </p>
            )}
          </div>
          {canDo('ATTENDANCE_MANAGE') && (
            <Link href="/admin/attendance" className="btn-ghost text-sm">
              Ажилтнуудын ирц →
            </Link>
          )}
        </div>

        {error && <p className="mb-3 rounded border border-red-800 bg-red-900/20 p-3 text-sm text-red-300">{error}</p>}
        {notice && <p className="mb-3 rounded border border-emerald-800 bg-emerald-900/20 p-3 text-sm text-emerald-200">{notice}</p>}

        {/* Check in / out */}
        {s && (
          <section className="card mb-4">
            {s.selfCheckIn === 'OFF' ? (
              <>
                <p className="font-semibold">Ирцийг менежер бүртгэнэ</p>
                <p className="mt-1 text-sm text-slate-400">Ирсэн, явахдаа менежерт хэлнэ үү. Энд өөрийн ирц, төлөвөө харж, чөлөө хүсэж болно.</p>
                {atWork && open && (
                  <p className="mt-2 text-sm text-emerald-300">
                    Ажил дээр · {overnight ? `${ubDay(open.checkIn).slice(5)} ` : ''}
                    {ubTime(open.checkIn)}-с
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="mb-3">
                  {atWork && open ? (
                    <p className="text-lg font-semibold text-emerald-300">Ажил дээр · {ubTime(open.checkIn)}-с</p>
                  ) : (
                    <p className="text-lg font-semibold text-slate-300">Одоо ажил дээр биш</p>
                  )}
                  {atWork && open && !open.confirmed && <p className="text-sm text-yellow-300">Ирсэн цагийг менежер хараахан батлаагүй.</p>}
                  <p className="mt-1 text-xs text-slate-400">
                    {s.selfCheckIn === 'CONFIRM'
                      ? 'Ирэхдээ «Ирлээ», явахдаа «Явлаа» дарна. Менежер баталсны дараа ирцэд тооцогдоно.'
                      : 'Ирэхдээ «Ирлээ», явахдаа «Явлаа» дарна. Дармагц ирцэд тооцогдоно.'}
                  </p>
                </div>
                {overnight && open && (
                  <p className="mb-3 rounded border border-sky-800 bg-sky-900/20 p-3 text-xs text-sky-200">
                    Өчигдөр {ubTime(open.checkIn)}-с ирсэн бүртгэл нээлттэй байна. Шөнө ажиллаад одоо явж байгаа бол «Явлаа». Шинэ өдөр ирсэн бол «Ирлээ» —
                    өчигдрийнхийг ажлын төгсгөлийн цагаар ({s.shiftEnd}) хаана (ажлын цагаас хойш ирсэн бол 0 цагтай) — зөв цагийг менежерт засуулна уу.
                  </p>
                )}
                {stale && open && (
                  <p className="mb-3 rounded border border-amber-700 bg-amber-900/20 p-3 text-xs text-amber-200">
                    {ubDay(open.checkIn)}-нд явсан цагаа бүртгүүлээгүй байна. «Ирлээ» дарвал тэр өдрийг ажлын төгсгөлийн цагаар ({s.shiftEnd}) хаана — зөв
                    цагийг менежерт хэлж засуулна уу.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <button className="btn-primary h-16 !text-lg" disabled={(atWork && !overnight) || busy !== null || loading} onClick={() => void punch('in')}>
                    {busy === 'in' ? 'Түр хүлээнэ үү…' : 'Ирлээ'}
                  </button>
                  <button
                    className="btn-ghost h-16 !text-lg !border-slate-400"
                    disabled={!atWork || busy !== null || loading}
                    onClick={() => void punch('out')}
                  >
                    {busy === 'out' ? 'Түр хүлээнэ үү…' : 'Явлаа'}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* Month */}
        <section className="card mb-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button className="btn-ghost h-10 w-10 p-0" aria-label="Өмнөх сар" onClick={() => setPeriod(shiftMonth(period, -1))}>
                ‹
              </button>
              <input
                type="month"
                className="w-40"
                value={period}
                aria-label="Сар"
                onChange={(e) => e.target.value && setPeriod(e.target.value)}
              />
              <button className="btn-ghost h-10 w-10 p-0" aria-label="Дараагийн сар" onClick={() => setPeriod(shiftMonth(period, 1))}>
                ›
              </button>
            </div>
            {period !== thisMonth() && (
              <button className="btn-ghost text-sm" onClick={() => setPeriod(thisMonth())}>
                Энэ сар
              </button>
            )}
          </div>

          {data && data.periodMonth === period && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Total label="Ирсэн өдөр" value={`${data.presentDays} / ${data.workingDays}`} hint="ажлын өдрөөс" />
              <Total label="Хоцорсон" value={String(lateDays)} tone={lateDays ? 'text-amber-300' : undefined} />
              <Total
                label="Батлаагүй"
                value={String(data.waiting)}
                hint="менежер батлаагүй"
                tone={data.waiting ? 'text-yellow-300' : undefined}
              />
              <Total label="Төлөвтэй өдөр" value={String([...markCounts.values()].reduce((a, b) => a + b, 0))} hint="чөлөө, өвчтэй…" />
            </div>
          )}
          {markCounts.size > 0 && (
            <p className="mb-3 text-xs text-slate-300">
              {[...markCounts.entries()].map(([m, n]) => `${MARK[m].label} ${n}`).join(' · ')}
            </p>
          )}

          {loading && !days.length && <p className="py-6 text-center text-sm text-slate-500">Уншиж байна…</p>}
          {days.length > 0 && (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-slate-500">
                {WEEK_HEAD.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1">
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`lead-${i}`} />
                ))}
                {days.map((d) => {
                  const st = stateOf(d, today, lateAfter);
                  const info = infoOf(st);
                  const isToday = d.date === today;
                  return (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => setSelected(d.date)}
                      aria-label={`${d.date}: ${info.label || 'бүртгэлгүй'}`}
                      className={`relative flex min-h-[48px] flex-col items-center justify-center rounded-md border text-sm ${info.tone} ${
                        selected === d.date ? 'ring-2 ring-amber-brand' : isToday ? 'ring-1 ring-slate-300' : ''
                      }`}
                    >
                      <span className="absolute left-1 top-0.5 text-[10px] opacity-70">{Number(d.date.slice(8))}</span>
                      <span className="mt-2 font-semibold">{info.code}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {sel && <DayDetail day={sel} today={today} lateAfter={lateAfter} />}

          <Legend />
        </section>

        {/* Leave requests */}
        <section className="card mb-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">Чөлөөний хүсэлт</h3>
              <p className="text-xs text-slate-400">Чөлөө, өвчтэй, томилолтын өдрөө урьдчилан хүснэ. Менежер зөвшөөрвөл тэр өдрүүдэд тэмдэглэгдэнэ.</p>
            </div>
            <button className="btn-primary" onClick={() => setAsking(true)}>
              Чөлөө хүсэх
            </button>
          </div>
          {data && data.periodMonth === period && data.requests.length === 0 && (
            <p className="py-3 text-sm text-slate-500">Энэ сард болон хүлээгдэж буй хүсэлт алга.</p>
          )}
          <ul className="divide-y divide-slate-800">
            {(data?.periodMonth === period ? data.requests : []).map((r) => {
              const st = LEAVE_STATUS[r.status];
              const mayCancel = r.status === 'PENDING' || (r.status === 'APPROVED' && r.fromDate > today);
              return (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <span className={`mr-2 inline-block rounded border px-1.5 text-xs ${MARK[r.kind].tone}`}>{MARK[r.kind].code}</span>
                        {MARK[r.kind].label}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-300">
                        {r.fromDate === r.toDate ? r.fromDate : `${r.fromDate} – ${r.toDate}`}{' '}
                        <span className="text-slate-500">({spanDays(r.fromDate, r.toDate)} хоног)</span>
                      </p>
                      <p className="mt-0.5 break-words text-xs text-slate-400">{r.reason}</p>
                      {(r.decidedBy || r.decisionNote) && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          {r.decidedBy ? `${r.decidedBy}: ` : ''}
                          {r.decisionNote ?? ''}
                        </p>
                      )}
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${st.tone}`}>{st.label}</span>
                  </div>
                  {mayCancel &&
                    (cancelling === r.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-sm text-slate-300">Хүсэлтээ цуцлах уу?</span>
                        <button className="btn-danger text-sm" disabled={busy === r.id} onClick={() => void cancelRequest(r.id)}>
                          {busy === r.id ? 'Цуцалж байна…' : 'Тийм, цуцлах'}
                        </button>
                        <button className="btn-ghost text-sm" onClick={() => setCancelling(null)}>
                          Үгүй
                        </button>
                      </div>
                    ) : (
                      <button className="btn-ghost mt-2 text-sm" onClick={() => setCancelling(r.id)}>
                        Цуцлах
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {asking && (
        <LeaveModal
          today={today}
          onClose={() => setAsking(false)}
          onSent={() => {
            setAsking(false);
            setNotice('Хүсэлт илгээгдлээ. Менежер шийдвэрлэхийг хүлээнэ үү.');
            void load(period);
          }}
        />
      )}
    </Shell>
  );
}

function Total({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-steel-950/60 p-2">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={`text-lg font-bold ${tone ?? ''}`}>{value}</p>
      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

/** The tapped day: its check-ins and status. */
function DayDetail({ day, today, lateAfter }: { day: Day; today: string; lateAfter: number }) {
  const st = stateOf(day, today, lateAfter);
  const info = infoOf(st);
  return (
    <div className="mt-3 rounded-lg border border-slate-700 bg-steel-950/60 p-3 text-sm">
      <p className="font-semibold">
        {day.date} · {WEEKDAY[dow(day.date)]}
        {info.label && <span className="ml-2 text-xs font-normal text-slate-400">{info.label}</span>}
      </p>
      {day.mark && (
        <p className="mt-1">
          <span className={`mr-2 inline-block rounded border px-1.5 text-xs ${MARK[day.mark].tone}`}>{MARK[day.mark].code}</span>
          {MARK[day.mark].label}
          {day.note && <span className="text-slate-400"> — {day.note}</span>}
        </p>
      )}
      {day.records.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">
          {day.holiday ? 'Нийтийн амралтын өдөр.' : !day.working ? 'Ажлын бус өдөр.' : day.date > today ? 'Болоогүй өдөр.' : 'Ирсэн бүртгэл алга.'}
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {day.records.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-mono">
                {ubTime(r.checkIn)} – {r.checkOut ? ubTime(r.checkOut) : isStale(r.checkIn, today) ? '??' : 'ажил дээр'}
              </span>
              <span className={r.status === 'LATE' ? 'text-amber-300' : r.status === 'OVERTIME' ? 'text-sky-300' : 'text-emerald-300'}>
                {STATUS_LABEL[r.status]}
              </span>
              {!r.confirmed && <span className="rounded border border-dashed border-yellow-500 px-1.5 text-[11px] text-yellow-200">батлаагүй</span>}
              {!r.checkOut && isStale(r.checkIn, today) && <span className="text-[11px] text-red-300">явсан цаг бүртгээгүй</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend() {
  const items: Array<{ code: string; label: string; tone: string }> = [
    STATE.present,
    STATE.late,
    STATE.waiting,
    ...Object.values(MARK),
    STATE.holiday,
    STATE.off,
    STATE.none,
  ];
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <p className="mb-2 text-xs font-semibold text-slate-300">Тэмдэглэгээ</p>
      <ul className="grid grid-cols-1 gap-1.5 text-xs text-slate-300 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-2">
            <span className={`inline-flex h-6 w-8 shrink-0 items-center justify-center rounded border font-semibold ${i.tone}`}>{i.code}</span>
            {i.label}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500">Өдөр дээр дарж тэр өдрийн ирсэн, явсан цагийг харна. Төлөв цалинг автоматаар өөрчлөхгүй — эзэн шийднэ.</p>
    </div>
  );
}

/** «Чөлөө хүсэх»: kind, first and last day, and why. */
function LeaveModal({ today, onClose, onSent }: { today: string; onClose: () => void; onSent: () => void }) {
  const [kind, setKind] = useState<LeaveKind>('PAID_LEAVE');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const monthAgo = toUbLocal(new Date(Date.now() - 31 * 86_400_000)).slice(0, 10);
  const span = fromDate && toDate && toDate >= fromDate ? spanDays(fromDate, toDate) : 0;

  async function send(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!fromDate || !toDate) return setError('Эхлэх, дуусах өдрөө сонгоно уу');
    if (toDate < fromDate) return setError('Дуусах өдөр эхлэх өдрөөс өмнө байна');
    if (span > 31) return setError('Нэг хүсэлтэд 31 хоногоос ихгүй');
    if (fromDate < monthAgo) return setError('Сар гаруйн өмнөх өдрийг хүсэхгүй — менежерт хандана уу');
    if (reason.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    setSaving(true);
    try {
      await api('/hr/me/leave', { method: 'POST', body: JSON.stringify({ kind, fromDate, toDate, reason: reason.trim() }) });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Илгээж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="Чөлөө хүсэх"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            Болих
          </button>
          <button type="submit" form="leave-form" className="btn-primary" disabled={saving}>
            {saving ? 'Илгээж байна…' : 'Илгээх'}
          </button>
        </>
      }
    >
      <form id="leave-form" onSubmit={send} className="space-y-3">
        <p className="text-xs text-slate-400">Менежер зөвшөөрвөл тэдгээр ажлын өдрүүдэд таны сонгосон төлөв тавигдана.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <fieldset>
          <legend className="mb-1 text-xs text-slate-400">Төрөл</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LEAVE_KINDS.map((k) => (
              <label
                key={k}
                className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  kind === k ? 'border-amber-brand bg-steel-800' : 'border-slate-700'
                }`}
              >
                <input type="radio" name="kind" className="h-4 w-4" checked={kind === k} onChange={() => setKind(k)} />
                <span className={`inline-flex h-6 w-8 items-center justify-center rounded border text-xs font-semibold ${MARK[k].tone}`}>{MARK[k].code}</span>
                {MARK[k].label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            Эхлэх өдөр
            <input
              type="date"
              className="mt-1 w-full"
              required
              min={monthAgo}
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                if (e.target.value && toDate < e.target.value) setToDate(e.target.value);
              }}
            />
          </label>
          <label className="block text-xs text-slate-400">
            Дуусах өдөр
            <input type="date" className="mt-1 w-full" required min={fromDate} value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
        </div>
        {span > 0 && (
          <p className="text-xs text-slate-400">{span} хоног. Зөвшөөрвөл зөвхөн ажлын өдрүүдэд төлөв тавигдана (амралтын, баярын өдөр алгасна).</p>
        )}
        <label className="block text-xs text-slate-400">
          Шалтгаан
          <textarea
            className="mt-1 w-full"
            rows={3}
            required
            minLength={3}
            maxLength={300}
            placeholder="Эмнэлэгт үзүүлнэ, гэр бүлийн ажилтай…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}
