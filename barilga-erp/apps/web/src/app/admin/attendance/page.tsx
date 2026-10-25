'use client';

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Shell } from '@/components/shell';
import { Modal } from '@/components/modal';
import { api } from '@/lib/api';
import { can, savedUser, useCan } from '@/lib/permissions';
import { Attendance, AttendanceBoard, AuthUser, ROLE_LABEL, Role } from '@/lib/types';

const ATTENDANCE_STATUS_LABEL: Record<string, string> = { ON_TIME: 'Цагтаа', LATE: 'Хоцорсон', OVERTIME: 'Илүү цаг' };
const STATUS_TONE: Record<string, string> = { ON_TIME: 'text-emerald-300', LATE: 'text-amber-300', OVERTIME: 'text-sky-300' };
const WEEKDAY = ['Ня', 'Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя'];
const AUTO_CLOSED = 'Гарсан цаг бүртгээгүй';

type AttendanceStatus = 'ON_TIME' | 'LATE' | 'OVERTIME';
type DayMark = 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'SICK' | 'ANNUAL_LEAVE' | 'BUSINESS_TRIP' | 'ABSENT' | 'DAY_OFF';
type SelfMode = 'OFF' | 'CONFIRM' | 'AUTO';
type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
type Tab = 'today' | 'month' | 'requests';

/** A record as the API returns it: who pressed it (SELF = the person) and whether a manager confirmed it. */
type Rec = Attendance & { source?: string; confirmedAt?: string | null };
type BoardMember = Omit<AttendanceBoard['staff'][number], 'open'> & {
  open: Rec | null;
  mark?: DayMark | null;
  /** Today's status note, and whether it came from an approved request (kept when the status is changed). */
  markNote?: string | null;
  markFromRequest?: boolean;
};
/** A check-in the person made themselves, waiting for a manager. */
type WaitingPunch = { id: string; userId: string; checkIn: string; checkOut?: string | null; user: { id: string; fullName: string } };
/** GET /hr/attendance */
type Board = Omit<AttendanceBoard, 'staff' | 'recent'> & { staff: BoardMember[]; recent: Rec[]; waiting?: WaitingPunch[]; pendingRequests?: number };
type MonthRecord = {
  id: string;
  checkIn: string;
  checkOut: string | null;
  status: AttendanceStatus;
  notes: string | null;
  source?: string;
  confirmed?: boolean;
};
type MonthMark = { date: string; mark: DayMark; note: string | null; fromRequest: boolean };
type MonthPerson = {
  id: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  presentDays: number;
  lateDays: number;
  overtimeDays: number;
  hours: number;
  /** Check-ins of earlier days never closed. */
  unclosed: Array<{ id: string; checkIn: string }>;
  records: MonthRecord[];
  waiting?: number;
  markCounts?: Partial<Record<DayMark, number>>;
  marks?: MonthMark[];
  /** Past working days with nothing recorded. */
  unknownDays?: string[];
  /** The day the person was registered (days before it are not counted as missed). */
  startedOn?: string;
};
/** GET /hr/attendance/month */
type AttendanceMonth = { periodMonth: string; workingDays: number; holidays?: string[]; people: MonthPerson[] };
/** GET/PUT /hr/attendance/settings */
type WorkHours = {
  shiftStart: string;
  graceMinutes: number;
  shiftEnd: string;
  overtimeAfterHours: number;
  selfCheckIn?: SelfMode;
  holidays?: string[];
};
/** GET /hr/leave */
type LeaveRow = {
  id: string;
  user: { id: string; fullName: string; role: Role };
  kind: DayMark;
  fromDate: string;
  toDate: string;
  reason: string;
  status: LeaveStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
};
/** The record being corrected and whose it is. */
type FixTarget = { id: string; checkIn: string; checkOut: string | null; notes?: string | null; who: string };
type MarkTarget = { userId: string; who: string; date: string; mark: DayMark | null; note?: string | null; fromRequest?: boolean };
type RecordTarget = { id: string; who: string; checkIn: string; checkOut: string | null };
type Person = { id: string; fullName: string };
type Dialog =
  | { kind: 'fix'; target: FixTarget }
  | { kind: 'mark'; target: MarkTarget }
  | { kind: 'add'; userId?: string; date?: string }
  | { kind: 'delete'; target: RecordTarget }
  | { kind: 'cell'; person: MonthPerson; date: string }
  | { kind: 'records'; person: MonthPerson }
  | { kind: 'decide'; request: LeaveRow; approve: boolean }
  | { kind: 'cutLeave'; request: LeaveRow }
  | { kind: 'settings' };

// ───────── Day codes: one letter/sign and a colour per day, same as «Миний ирц» ─────────

type Code = { code: string; label: string; tone: string };
const MARK: Record<DayMark, Code> = {
  PAID_LEAVE: { label: 'Цалинтай чөлөө', code: 'Ч', tone: 'bg-sky-900/70 text-sky-200 border-sky-700' },
  UNPAID_LEAVE: { label: 'Цалингүй чөлөө', code: 'Ч−', tone: 'bg-indigo-900/70 text-indigo-200 border-indigo-600' },
  SICK: { label: 'Өвчтэй', code: 'Ө', tone: 'bg-pink-900/70 text-pink-200 border-pink-700' },
  ANNUAL_LEAVE: { label: 'Ээлжийн амралт', code: 'ЭА', tone: 'bg-teal-900/70 text-teal-200 border-teal-700' },
  BUSINESS_TRIP: { label: 'Томилолт', code: 'Т', tone: 'bg-violet-900/70 text-violet-200 border-violet-600' },
  ABSENT: { label: 'Тасалсан', code: '✕', tone: 'bg-red-900/70 text-red-200 border-red-700' },
  DAY_OFF: { label: 'Амралтын өдөр', code: 'А', tone: 'bg-slate-700/60 text-slate-200 border-slate-500' },
};
const MARKS = Object.keys(MARK) as DayMark[];
type CellState = 'present' | 'late' | 'waiting' | 'holiday' | 'off' | 'before' | 'unknown' | 'empty';
type CellKind = DayMark | CellState;
const STATE: Record<CellState, Code> = {
  present: { label: 'Ирсэн', code: '✓', tone: 'bg-emerald-900/70 text-emerald-200 border-emerald-700' },
  late: { label: 'Хоцорсон', code: 'Х', tone: 'bg-amber-900/60 text-amber-200 border-amber-600' },
  waiting: { label: 'Өөрөө бүртгүүлсэн, батлаагүй', code: 'Б', tone: 'border-dashed border-yellow-500 bg-yellow-900/20 text-yellow-200' },
  holiday: { label: 'Нийтийн амралтын өдөр', code: 'НА', tone: 'bg-steel-800 text-slate-300 border-slate-600' },
  off: { label: 'Ажлын бус өдөр', code: '·', tone: 'bg-steel-950 text-slate-600 border-slate-800' },
  before: { label: 'Ажилд орохоос өмнө', code: '–', tone: 'bg-steel-950 text-slate-700 border-slate-800' },
  unknown: { label: 'Ажлын өдөр — ирц ч, төлөв ч алга', code: '?', tone: 'border-red-700 text-red-300 bg-red-950/30' },
  empty: { label: '', code: '', tone: 'border-slate-800 text-slate-500' },
};
const codeOf = (k: CellKind): Code => (k in MARK ? MARK[k as DayMark] : STATE[k as CellState]);

const SELF_MODE: Record<SelfMode, { label: string; hint: string }> = {
  OFF: { label: 'Унтраалттай', hint: 'Ирцийг зөвхөн менежер бүртгэнэ. Ажилтан өөрөө дарахгүй.' },
  CONFIRM: { label: 'Менежер батална', hint: 'Ажилтан утаснаасаа «Ирлээ / Явлаа» дарна; менежер баталсны дараа ирцэд тооцогдоно.' },
  AUTO: { label: 'Шууд тооцно', hint: 'Ажилтан өөрөө дарна; батлах шаардлагагүй, шууд ирцэд тооцогдоно.' },
};
const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: string }> = {
  PENDING: { label: 'Хүлээгдэж байна', tone: 'border-amber-600 text-amber-200' },
  APPROVED: { label: 'Зөвшөөрсөн', tone: 'border-emerald-700 text-emerald-300' },
  REJECTED: { label: 'Татгалзсан', tone: 'border-red-700 text-red-300' },
  CANCELLED: { label: 'Цуцалсан', tone: 'border-slate-600 text-slate-400' },
};

// Ulaanbaatar is UTC+08:00 all year. Times are converted with that offset explicitly, so a browser set to
// another zone still shows and sends the shop's local time.
const UB_OFFSET_MS = 8 * 3_600_000;
/** 'YYYY-MM-DDTHH:MM' in Ulaanbaatar time — the datetime-local input format. */
const toUbLocal = (t: string | Date) => new Date(new Date(t).getTime() + UB_OFFSET_MS).toISOString().slice(0, 16);
/** A datetime-local value read as Ulaanbaatar time → ISO (UTC). */
const fromUbLocal = (v: string) => new Date(`${v.slice(0, 16)}:00+08:00`).toISOString();
const ubDay = (t: string | Date) => toUbLocal(t).slice(0, 10);
const ubTime = (t: string | Date) => toUbLocal(t).slice(11, 16);
const thisMonth = () => toUbLocal(new Date()).slice(0, 7);
const dowOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const weekday = (day: string) => WEEKDAY[dowOf(day)];
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
/** Same rule as the API: a check-in from an earlier day is forgotten only after 16 h (a shift may run past midnight). */
const MAX_SHIFT_MS = 16 * 3_600_000;
const isStale = (checkIn: string, today: string) => ubDay(checkIn) < today && Date.now() - new Date(checkIn).getTime() > MAX_SHIFT_MS;
const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
function daysOf(period: string) {
  const [y, m] = period.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

function fmt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' });
}

function hoursLine(h: WorkHours) {
  return `Ажил ${h.shiftStart}–${h.shiftEnd}, ${h.graceMinutes} мин хүлцэл, ${h.overtimeAfterHours} цагаас илүү бол илүү цаг · Өөрөө бүртгүүлэх: ${
    SELF_MODE[h.selfCheckIn ?? 'CONFIRM'].label
  }`;
}

/** Mon–Fri (5), Mon–Sat (6) or every day (7): the same rule as the API's working days. */
const isWorkday = (date: string, week: number) => week >= 7 || (dowOf(date) >= 1 && dowOf(date) <= week);
/** Days a week the shop works, found from the month's working-day count (the month API does not send it). */
function weekOf(month: AttendanceMonth | null): number | null {
  if (!month) return null;
  const holidays = new Set(month.holidays ?? []);
  const days = daysOf(month.periodMonth).filter((d) => !holidays.has(d));
  for (const n of [6, 5, 7]) if (days.filter((d) => isWorkday(d, n)).length === month.workingDays) return n;
  return null;
}

/** What a day of the month grid shows. A status beats check-ins; a confirmed check-in beats one waiting. */
function cellKind(
  date: string,
  recs: MonthRecord[] | undefined,
  mark: MonthMark | undefined,
  unknown: boolean,
  holiday: boolean,
  today: string,
  lateAfter: number | null,
  week: number | null,
  startedOn?: string,
): CellKind {
  if (mark) return mark.mark;
  const list = recs ?? [];
  if (!list.length && startedOn && date < startedOn) return 'before';
  const counted = list.filter((r) => r.confirmed !== false);
  if (counted.length) {
    const first = counted[0];
    // Late = the day's first arrival after the start + grace, as the month totals count it.
    const late = lateAfter !== null ? hhmm(ubTime(first.checkIn)) > lateAfter : first.status === 'LATE';
    return late ? 'late' : 'present';
  }
  if (list.length) return 'waiting';
  if (unknown) return 'unknown';
  if (holiday) return 'holiday';
  // A past working day with nothing is in unknownDays, so a past day here is a day off.
  if (date < today || (week !== null && !isWorkday(date, week))) return 'off';
  return 'empty';
}

const isWaiting = (r: Rec) => r.source === 'SELF' && !r.confirmedAt;

export default function AttendanceAdminPage() {
  return (
    <Suspense fallback={<div className="p-8 text-slate-400">Уншиж байна…</div>}>
      <AttendanceAdmin />
    </Suspense>
  );
}

function AttendanceAdmin() {
  const router = useRouter();
  const canDo = useCan();
  const mayManage = canDo('ATTENDANCE_MANAGE');
  const [me, setMe] = useState<AuthUser | null>(null);
  const [tab, setTabState] = useState<Tab>('today');
  const [board, setBoard] = useState<Board | null>(null);
  const [period, setPeriod] = useState(thisMonth);
  const [month, setMonth] = useState<AttendanceMonth | null>(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [hours, setHours] = useState<WorkHours | null>(null);
  const [requests, setRequests] = useState<LeaveRow[] | null>(null);
  const [reqFilter, setReqFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const [reqLoading, setReqLoading] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const ready = me !== null;
  const isAdmin = me?.role === 'ADMIN';
  // The API refuses confirming, marking or correcting your own attendance unless you are the admin.
  const mayFix = useCallback((userId: string) => isAdmin || userId !== me?.id, [isAdmin, me?.id]);

  const loadBoard = useCallback(async () => {
    try {
      setBoard(await api<Board>('/hr/attendance'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ирц ачаалж чадсангүй');
    }
  }, []);

  const loadMonth = useCallback(async (p: string) => {
    setMonthLoading(true);
    try {
      setMonth(await api<AttendanceMonth>(`/hr/attendance/month?periodMonth=${p}`));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сарын ирц ачаалж чадсангүй');
    } finally {
      setMonthLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async (status: 'PENDING' | 'ALL') => {
    setReqLoading(true);
    try {
      setRequests(await api<LeaveRow[]>(`/hr/leave?status=${status}`));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хүсэлт ачаалж чадсангүй');
    } finally {
      setReqLoading(false);
    }
  }, []);

  // Read-only for most; a person given the right without a manager role may not read it — then no line.
  const loadHours = useCallback(async () => {
    try {
      setHours(await api<WorkHours>('/hr/attendance/settings'));
    } catch {
      setHours(null);
    }
  }, []);

  // Gate on the right itself (re-checked when the Shell refreshes it), not on the role.
  useEffect(() => {
    const user = savedUser();
    if (!can(user, 'ATTENDANCE_MANAGE')) {
      router.replace('/me/attendance');
      return;
    }
    setMe(user);
  }, [router, mayManage]);

  // ?tab=requests (from a notification) or ?tab=month&month=YYYY-MM (from payroll) opens that view — also when
  // the page is already open and the bell's link only changes the query.
  const search = useSearchParams();
  const searchKey = search.toString();
  useEffect(() => {
    const t = search.get('tab');
    setTabState(t === 'month' || t === 'requests' ? t : 'today');
    const m = search.get('month');
    if (m && /^\d{4}-\d{2}$/.test(m)) setPeriod(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  function setTab(t: Tab) {
    setTabState(t);
    const q = new URLSearchParams(window.location.search);
    if (t === 'today') q.delete('tab');
    else q.set('tab', t);
    q.delete('month');
    const qs = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }

  useEffect(() => {
    if (!ready) return;
    void loadBoard();
    void loadHours();
  }, [ready, loadBoard, loadHours]);

  useEffect(() => {
    if (ready && tab === 'month') void loadMonth(period);
  }, [ready, tab, period, loadMonth]);

  useEffect(() => {
    if (ready && tab === 'requests') void loadRequests(reqFilter);
  }, [ready, tab, reqFilter, loadRequests]);

  /** After any change: the board (badges), and the month and requests when they were opened. */
  function refresh() {
    void loadBoard();
    if (month) void loadMonth(period);
    if (requests) void loadRequests(reqFilter);
  }

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusyId(key);
    setError('');
    setNotice('');
    try {
      await fn();
      if (ok) setNotice(ok);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Алдаа гарлаа');
    } finally {
      setBusyId(null);
    }
  }

  const punch = (userId: string, kind: 'in' | 'out') =>
    run(userId, () => api(kind === 'in' ? '/hr/check-in' : '/hr/check-out', { method: 'POST', body: JSON.stringify({ userId }) }));

  const confirmPunches = (ids: string[]) =>
    run('confirm', async () => {
      const r = await api<{ confirmed: number; skipped?: number }>('/hr/attendance/confirm', { method: 'POST', body: JSON.stringify({ ids }) });
      const skipped = r.skipped ? ` ${r.skipped} нь цалин олгосон сарынх тул батлагдсангүй.` : '';
      if (!r.confirmed && skipped) throw new Error(skipped.trim());
      setNotice(r.confirmed ? `${r.confirmed} ирц батлагдлаа.${skipped}` : 'Батлах ирц олдсонгүй');
    });

  const clearMark = (userId: string, date: string) =>
    run(`clear-${userId}-${date}`, () => api(`/hr/attendance/days/${userId}/${date}`, { method: 'DELETE' }), 'Төлөв арилгалаа');

  function done(msg?: string) {
    setDialog(null);
    setError('');
    setNotice(msg ?? '');
    refresh();
  }

  // People a record can be added for: those on today's board plus anyone in the month (e.g. left the job).
  const people = useMemo<Person[]>(() => {
    const byId = new Map<string, Person>();
    for (const s of board?.staff ?? []) byId.set(s.id, { id: s.id, fullName: s.fullName });
    for (const p of month?.people ?? []) if (!byId.has(p.id)) byId.set(p.id, { id: p.id, fullName: p.fullName });
    return [...byId.values()].filter((p) => mayFix(p.id));
  }, [board, month, mayFix]);

  if (!me) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  const today = board?.date ?? ubDay(new Date());
  // Still checked in from an earlier day: the check-out was forgotten.
  const staleOpen = (board?.staff ?? []).filter((m) => m.open && isStale(m.open.checkIn, today));
  const waiting = board?.waiting ?? [];
  const pending = board?.pendingRequests ?? 0;
  const atWork = (board?.staff ?? []).filter((m) => m.open && !isStale(m.open.checkIn, today)).length;
  const marked = (board?.staff ?? []).filter((m) => m.mark).length;

  const tabs: Array<[Tab, string, number, string]> = [
    ['today', 'Өнөөдөр', waiting.filter((w) => mayFix(w.userId)).length, 'bg-yellow-500 text-steel-950'],
    ['month', 'Сарын ирц', 0, ''],
    ['requests', 'Хүсэлтүүд', pending, 'bg-red-600 text-white'],
  ];

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Хүний нөөц</p>
          <h2 className="text-xl font-bold">Ирц</h2>
          <p className="mt-1 text-sm text-slate-400">
            Ажилтны ирэх, явах цаг, өдрийн төлөв (чөлөө, өвчтэй, тасалсан…), чөлөөний хүсэлт. Улаанбаатарын цагаар.
          </p>
          {hours && <p className="mt-0.5 text-xs text-slate-500">{hoursLine(hours)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => setDialog({ kind: 'add' })}>
            + Ирц нэмэх
          </button>
          {isAdmin && hours && (
            <button className="btn-ghost" onClick={() => setDialog({ kind: 'settings' })}>
              Ирцийн тохиргоо
            </button>
          )}
          <button
            className="btn-ghost"
            onClick={() => void (tab === 'today' ? loadBoard() : tab === 'month' ? loadMonth(period) : loadRequests(reqFilter))}
          >
            Шинэчлэх
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([k, label, badge, badgeTone]) => (
          <button key={k} className={tab === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setTab(k)}>
            {label}
            {badge > 0 && <span className={`rounded-full px-1.5 text-[11px] font-bold ${badgeTone}`}>{badge}</span>}
          </button>
        ))}
      </div>

      {error && <p className="mb-3 rounded border border-red-800 bg-red-900/20 p-3 text-sm text-red-300">{error}</p>}
      {notice && <p className="mb-3 rounded border border-emerald-800 bg-emerald-900/20 p-3 text-sm text-emerald-200">{notice}</p>}

      {tab === 'today' && (
        <>
          {board && (
            <p className="mb-3 text-sm text-slate-400">
              {today} {weekday(today)} · Ажил дээр: <b className="text-emerald-300">{atWork}</b> / {board.staff.length}
              {marked > 0 && <> · Өнөөдөр төлөвтэй: {marked}</>}
            </p>
          )}
          {staleOpen.length > 0 && (
            <p className="mb-3 rounded border border-amber-700 bg-amber-900/20 p-3 text-xs text-amber-200">
              {staleOpen.length} ажилтны өмнөх өдрийн гарсан цаг бүртгээгүй. Дахин «Ирсэн» дарвал тэр өдрийг ажлын төгсгөлийн цагаар хаана; зөв
              цагийг «засах»-аар оруулна уу.
            </p>
          )}

          {waiting.length > 0 && (
            <WaitingCard
              waiting={waiting}
              mayFix={mayFix}
              busy={busyId !== null}
              onConfirm={(ids) => void confirmPunches(ids)}
              onDelete={(w) => setDialog({ kind: 'delete', target: { id: w.id, who: w.user.fullName, checkIn: w.checkIn, checkOut: w.checkOut ?? null } })}
            />
          )}

          <StaffBoard
            staff={board?.staff ?? []}
            today={today}
            busyId={busyId}
            mayFix={mayFix}
            onPunch={(id, kind) => void punch(id, kind)}
            onMark={(m) =>
              setDialog({
                kind: 'mark',
                target: { userId: m.id, who: m.fullName, date: today, mark: m.mark ?? null, note: m.markNote ?? null, fromRequest: m.markFromRequest },
              })
            }
            onFix={(m) => m.open && setDialog({ kind: 'fix', target: { ...m.open, who: m.fullName } })}
          />

          <h3 className="mb-2 font-semibold">Өнөөдрийн бүртгэл</h3>
          <TodayRecords
            rows={board?.recent ?? []}
            mayFix={mayFix}
            onFix={(r) => setDialog({ kind: 'fix', target: { ...r, who: r.user?.fullName ?? r.userId } })}
            onDelete={(r) => setDialog({ kind: 'delete', target: { id: r.id, who: r.user?.fullName ?? r.userId, checkIn: r.checkIn, checkOut: r.checkOut } })}
          />
        </>
      )}

      {tab === 'month' && (
        <MonthGrid
          period={period}
          onPeriod={setPeriod}
          data={month?.periodMonth === period ? month : null}
          loading={monthLoading}
          today={today}
          hours={hours}
          onCell={(person, date) => setDialog({ kind: 'cell', person, date })}
          onPerson={(person) => setDialog({ kind: 'records', person })}
        />
      )}

      {tab === 'requests' && (
        <RequestsView
          rows={requests}
          loading={reqLoading}
          filter={reqFilter}
          onFilter={setReqFilter}
          mayFix={mayFix}
          onDecide={(request, approve) => setDialog({ kind: 'decide', request, approve })}
          onCut={(request) => setDialog({ kind: 'cutLeave', request })}
        />
      )}

      {dialog?.kind === 'fix' && (
        <FixModal target={dialog.target} shiftEnd={hours?.shiftEnd} onClose={() => setDialog(null)} onSaved={() => done('Ирц засагдлаа')} />
      )}
      {dialog?.kind === 'mark' && <MarkModal target={dialog.target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'add' && (
        <AddRecordModal
          people={people}
          userId={dialog.userId}
          date={dialog.date}
          today={today}
          shiftStart={hours?.shiftStart ?? '09:00'}
          shiftEnd={hours?.shiftEnd ?? '18:00'}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === 'delete' && <DeleteRecordModal target={dialog.target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'decide' && (
        <DecideModal request={dialog.request} approve={dialog.approve} onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog?.kind === 'cutLeave' && <CutLeaveModal request={dialog.request} today={today} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'settings' && hours && (
        <SettingsModal
          hours={hours}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setHours(next);
            done('Тохиргоо хадгалагдлаа');
          }}
        />
      )}
      {dialog?.kind === 'cell' && (
        <CellModal
          person={dialog.person}
          date={dialog.date}
          today={today}
          holiday={(month?.holidays ?? []).includes(dialog.date)}
          lateAfter={hours ? hhmm(hours.shiftStart) + hours.graceMinutes : null}
          week={weekOf(month)}
          mayFix={mayFix(dialog.person.id)}
          onClose={() => setDialog(null)}
          onMark={(t) => setDialog({ kind: 'mark', target: t })}
          onClearMark={(userId, date) => {
            setDialog(null);
            void clearMark(userId, date);
          }}
          onAdd={(userId, date) => setDialog({ kind: 'add', userId, date })}
          onFix={(t) => setDialog({ kind: 'fix', target: t })}
          onDelete={(t) => setDialog({ kind: 'delete', target: t })}
          onConfirm={(id) => {
            setDialog(null);
            void confirmPunches([id]);
          }}
          onRecords={(person) => setDialog({ kind: 'records', person })}
        />
      )}
      {dialog?.kind === 'records' && (
        <PersonRecordsModal
          person={dialog.person}
          period={period}
          today={today}
          mayFix={mayFix(dialog.person.id)}
          onClose={() => setDialog(null)}
          onAdd={(userId) => setDialog({ kind: 'add', userId })}
          onFix={(t) => setDialog({ kind: 'fix', target: t })}
          onDelete={(t) => setDialog({ kind: 'delete', target: t })}
          onConfirm={(id) => {
            setDialog(null);
            void confirmPunches([id]);
          }}
          onMark={(t) => setDialog({ kind: 'mark', target: t })}
        />
      )}
    </Shell>
  );
}

function MarkChip({ mark, note }: { mark: DayMark; note?: string | null }) {
  const m = MARK[mark];
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${m.tone}`}>
      <b>{m.code}</b> {m.label}
      {note && <span className="truncate opacity-80">· {note}</span>}
    </span>
  );
}

function WaitingBadge() {
  return <span className="rounded border border-dashed border-yellow-500 px-1.5 text-[11px] text-yellow-200">батлаагүй</span>;
}

// ───────── Today ─────────

/** Self check-ins waiting for a manager: confirm one by one or all at once; a wrong one is removed. */
function WaitingCard(props: {
  waiting: WaitingPunch[];
  mayFix: (userId: string) => boolean;
  busy: boolean;
  onConfirm: (ids: string[]) => void;
  onDelete: (w: WaitingPunch) => void;
}) {
  const confirmable = props.waiting.filter((w) => props.mayFix(w.userId));
  return (
    <section className="card mb-4 border-yellow-700/70">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">Батлах — өөрөө бүртгүүлсэн ирц ({props.waiting.length})</h3>
          <p className="text-xs text-slate-400">
            Ажилтан өөрөө «Ирлээ» дарсан. Үнэхээр ирсэн бол батална — батласны дараа ирсэн өдөрт тооцогдоно. Ирээгүй бол устгана.
          </p>
        </div>
        {confirmable.length > 1 && (
          <button className="btn-primary" disabled={props.busy} onClick={() => props.onConfirm(confirmable.map((w) => w.id))}>
            Бүгдийг батлах ({confirmable.length})
          </button>
        )}
      </div>
      <ul className="divide-y divide-slate-800">
        {props.waiting.map((w) => {
          const day = ubDay(w.checkIn);
          return (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="font-medium">{w.user.fullName}</p>
                <p className="font-mono text-xs text-slate-400">
                  {day} {weekday(day)} · {ubTime(w.checkIn)}
                  {w.checkOut ? ` – ${ubTime(w.checkOut)}` : ''}
                </p>
              </div>
              {props.mayFix(w.userId) ? (
                <div className="flex gap-2">
                  <button className="btn-ghost text-sm" disabled={props.busy} onClick={() => props.onDelete(w)}>
                    устгах
                  </button>
                  <button className="btn-primary text-sm" disabled={props.busy} onClick={() => props.onConfirm([w.id])}>
                    Батлах
                  </button>
                </div>
              ) : (
                <span className="text-xs text-slate-500">Өөрийнхийг өөр менежер батална</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MemberStatus({ m, today }: { m: BoardMember; today: string }) {
  const stale = Boolean(m.open && isStale(m.open.checkIn, today));
  if (stale) {
    return (
      <div>
        <span className="font-semibold text-amber-300">{AUTO_CLOSED}</span>
        <p className="text-[11px] text-slate-500">
          Өмнөх өдрөөс нээлттэй{m.open ? ` · ${ubDay(m.open.checkIn)} ${weekday(ubDay(m.open.checkIn))} ${ubTime(m.open.checkIn)}-с` : ''}
        </p>
      </div>
    );
  }
  if (m.open) {
    const earlier = ubDay(m.open.checkIn) < today;
    return (
      <div>
        <span className="font-semibold text-emerald-300">
          Ажил дээр · {earlier ? `${ubDay(m.open.checkIn).slice(5)} ` : ''}
          {ubTime(m.open.checkIn)}-с · {ATTENDANCE_STATUS_LABEL[m.open.status] ?? m.open.status}
        </span>
        {earlier && <p className="text-[11px] text-slate-400">Өчигдрөөс нээлттэй: шөнө ажиллаад явж байвал «Явсан», шинээр ирсэн бол «Ирсэн».</p>}
        {isWaiting(m.open) && <p className="text-[11px] text-yellow-300">Өөрөө бүртгүүлсэн, батлаагүй</p>}
      </div>
    );
  }
  return <span className="text-slate-500">Ажил дээр биш</span>;
}

/** Everyone in scope: phone cards below md, a table above. */
function StaffBoard(props: {
  staff: BoardMember[];
  today: string;
  busyId: string | null;
  mayFix: (userId: string) => boolean;
  onPunch: (userId: string, kind: 'in' | 'out') => void;
  onMark: (m: BoardMember) => void;
  onFix: (m: BoardMember) => void;
}) {
  const { today } = props;
  const stale = (m: BoardMember) => Boolean(m.open && isStale(m.open.checkIn, today));
  // One's own attendance is recorded under «Миний ирц» (a manager confirms it), not from this board.
  const inDisabled = (m: BoardMember) => !props.mayFix(m.id) || Boolean(m.open && ubDay(m.open.checkIn) === today) || props.busyId === m.id;
  const punchTitle = (m: BoardMember) => (!props.mayFix(m.id) ? 'Өөрийн ирцээ «Миний ирц»-ээс бүртгүүлнэ' : undefined);
  const outDisabled = (m: BoardMember) => !props.mayFix(m.id) || !m.open || stale(m) || props.busyId === m.id;
  return (
    <>
      <div className="mb-6 space-y-2 md:hidden">
        {props.staff.map((m) => (
          <article key={m.id} className="card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{m.fullName}</p>
                <p className="text-xs text-slate-500">{ROLE_LABEL[m.role]}</p>
              </div>
              {m.mark && <MarkChip mark={m.mark} />}
            </div>
            <div className="mt-1 text-sm">
              <MemberStatus m={m} today={today} />
            </div>
            {!props.mayFix(m.id) ? (
              <p className="mt-1 text-[11px] text-slate-400">Өөрийн ирцээ «Миний ирц»-ээс бүртгүүлнэ.</p>
            ) : (
              stale(m) && <p className="mt-1 text-[11px] text-slate-400">Өмнөх өдрийнх — гарсан цагийг «засах»-аар оруулна.</p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="btn-primary h-12 !text-base" disabled={inDisabled(m)} onClick={() => props.onPunch(m.id, 'in')}>
                Ирсэн
              </button>
              <button className="btn-ghost h-12 !text-base" disabled={outDisabled(m)} onClick={() => props.onPunch(m.id, 'out')}>
                Явсан
              </button>
            </div>
            {props.mayFix(m.id) && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn-ghost text-sm" onClick={() => props.onMark(m)}>
                  Төлөв{m.mark ? ' солих' : ' тавих'}
                </button>
                {stale(m) && (
                  <button className="btn-ghost text-sm" onClick={() => props.onFix(m)}>
                    засах
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
        {props.staff.length === 0 && <p className="card text-sm text-slate-500">Ажилтан алга.</p>}
      </div>

      <div className="card table-scroll mb-6 hidden p-0 md:block">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-slate-700 text-left text-slate-400">
            <tr>
              <th className="p-3">Ажилтан</th>
              <th>Албан тушаал</th>
              <th>Төлөв</th>
              <th>Өнөөдрийн төлөв</th>
              <th className="pr-3 text-right">Үйлдэл</th>
            </tr>
          </thead>
          <tbody>
            {props.staff.map((m) => (
              <tr key={m.id} className="border-t border-slate-800">
                <td className="p-3">
                  <p className="font-medium">{m.fullName}</p>
                  <p className="text-xs text-slate-500">@{m.username}</p>
                </td>
                <td>{ROLE_LABEL[m.role]}</td>
                <td>
                  <MemberStatus m={m} today={today} />
                </td>
                <td>{m.mark ? <MarkChip mark={m.mark} /> : <span className="text-slate-600">—</span>}</td>
                <td className="pr-3">
                  <div className="flex justify-end gap-1">
                    {props.mayFix(m.id) && (
                      <button className="btn-ghost px-3 py-1 text-xs" onClick={() => props.onMark(m)}>
                        Төлөв
                      </button>
                    )}
                    {stale(m) && props.mayFix(m.id) && (
                      <button className="btn-ghost px-3 py-1 text-xs" onClick={() => props.onFix(m)}>
                        засах
                      </button>
                    )}
                    <button className="btn-primary px-3 py-1 text-xs" disabled={inDisabled(m)} title={punchTitle(m)} onClick={() => props.onPunch(m.id, 'in')}>
                      Ирсэн
                    </button>
                    <button
                      className="btn-ghost px-3 py-1 text-xs"
                      disabled={outDisabled(m)}
                      title={punchTitle(m) ?? (stale(m) ? 'Өмнөх өдрийн бүртгэл — гарсан цагийг «засах»-аар оруулна' : undefined)}
                      onClick={() => props.onPunch(m.id, 'out')}
                    >
                      Явсан
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
          «Төлөв» — өнөөдрийг чөлөө, өвчтэй, тасалсан гэх мэтээр тэмдэглэнэ. «Явсан» 16 цагаас удаан нээлттэй бүртгэлд ажиллахгүй — «засах»-аар оруулна. Өөрийн ирцийг «Миний ирц»-ээс.
        </p>
      </div>
    </>
  );
}

function TodayRecords(props: { rows: Rec[]; mayFix: (userId: string) => boolean; onFix: (r: Rec) => void; onDelete: (r: Rec) => void }) {
  const { rows } = props;
  if (rows.length === 0) return <p className="card text-sm text-slate-500">Өнөөдөр бүртгэл алга.</p>;
  return (
    <>
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <div key={r.id} className="card p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{r.user?.fullName ?? r.userId}</p>
              <span className={STATUS_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status] ?? r.status}</span>
            </div>
            <p className="mt-1 font-mono text-slate-300">
              {ubTime(r.checkIn)} – {r.checkOut ? ubTime(r.checkOut) : <span className="font-sans text-emerald-300">ажил дээр</span>}{' '}
              {isWaiting(r) && <WaitingBadge />}
            </p>
            {props.mayFix(r.userId) && (
              <div className="mt-2 flex gap-2">
                <button className="btn-ghost text-sm" onClick={() => props.onFix(r)}>
                  засах
                </button>
                <button className="btn-ghost text-sm text-red-300" onClick={() => props.onDelete(r)}>
                  устгах
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="card table-scroll hidden p-0 md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700 text-left text-slate-400">
            <tr>
              <th className="p-3">Ажилтан</th>
              <th>Ирсэн</th>
              <th>Явсан</th>
              <th>Төлөв</th>
              <th className="pr-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-800">
                <td className="p-3">
                  {r.user?.fullName ?? r.userId} {isWaiting(r) && <WaitingBadge />}
                </td>
                <td>{fmt(r.checkIn)}</td>
                <td>{fmt(r.checkOut)}</td>
                <td>{ATTENDANCE_STATUS_LABEL[r.status] ?? r.status}</td>
                <td className="pr-3 text-right whitespace-nowrap">
                  {props.mayFix(r.userId) && (
                    <>
                      <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => props.onFix(r)}>
                        засах
                      </button>{' '}
                      <button className="btn-ghost px-2 py-0.5 text-xs text-red-300" onClick={() => props.onDelete(r)}>
                        устгах
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ───────── Month grid ─────────

type PersonIndex = { recs: Map<string, MonthRecord[]>; marks: Map<string, MonthMark>; unknown: Set<string> };
function indexPerson(p: MonthPerson): PersonIndex {
  const recs = new Map<string, MonthRecord[]>();
  for (const r of p.records) {
    const d = ubDay(r.checkIn);
    recs.set(d, [...(recs.get(d) ?? []), r]);
  }
  return { recs, marks: new Map((p.marks ?? []).map((m) => [m.date, m])), unknown: new Set(p.unknownDays ?? []) };
}

/** People × days. A cell opens a small menu for that day; a name opens the person's records of the month. */
function MonthGrid(props: {
  period: string;
  onPeriod: (p: string) => void;
  data: AttendanceMonth | null;
  loading: boolean;
  today: string;
  hours: WorkHours | null;
  onCell: (p: MonthPerson, date: string) => void;
  onPerson: (p: MonthPerson) => void;
}) {
  const { data, today } = props;
  const days = useMemo(() => daysOf(props.period), [props.period]);
  const holidays = useMemo(() => new Set(data?.holidays ?? []), [data]);
  const index = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, indexPerson(p)])), [data]);
  const lateAfter = props.hours ? hhmm(props.hours.shiftStart) + props.hours.graceMinutes : null;
  const workingDays = data?.workingDays ?? 0;
  const week = useMemo(() => weekOf(data), [data]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <label className="text-xs text-slate-400">
          Сар
          <input type="month" className="mt-1 block" value={props.period} onChange={(e) => e.target.value && props.onPeriod(e.target.value)} />
        </label>
        {data && (
          <p className="pb-2 text-xs text-slate-400">
            Ажлын өдөр: {data.workingDays}
            {holidays.size > 0 && ` · Нийтийн амралт: ${[...holidays].map((h) => Number(h.slice(8))).join(', ')}`}
          </p>
        )}
      </div>

      <div className="card table-scroll p-0">
        <table className="border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="text-slate-400">
              <th className="sticky left-0 z-20 w-[8.5rem] min-w-[8.5rem] max-w-[8.5rem] border-b border-r border-slate-700 bg-steel-900 p-2 text-left font-medium sm:w-44 sm:min-w-[11rem] sm:max-w-[11rem]">
                Ажилтан
              </th>
              {days.map((d) => {
                const wd = dowOf(d);
                const hol = holidays.has(d);
                return (
                  <th
                    key={d}
                    className={`border-b border-slate-700 px-0.5 py-1 text-center font-normal ${hol ? 'text-amber-300' : (week !== null ? !isWorkday(d, week) : wd === 0) ? 'text-slate-600' : ''} ${
                      d === today ? 'bg-steel-800' : ''
                    }`}
                  >
                    <div className="text-[11px] font-semibold">{Number(d.slice(8))}</div>
                    <div className="text-[10px]">{WEEKDAY[wd]}</div>
                  </th>
                );
              })}
              <th className="border-b border-l border-slate-700 px-2 text-right font-medium">Ирсэн</th>
              <th className="border-b border-slate-700 px-2 text-right font-medium">Хоцорсон</th>
              <th className="border-b border-slate-700 px-2 text-right font-medium">Илүү цаг</th>
              <th className="border-b border-slate-700 px-2 text-right font-medium">Нийт цаг</th>
              <th className="border-b border-slate-700 px-2 text-left font-medium">Төлөвтэй өдөр</th>
            </tr>
          </thead>
          <tbody>
            {(data?.people ?? []).map((p) => {
              const ix = index.get(p.id) ?? indexPerson(p);
              const counts = MARKS.filter((k) => (p.markCounts?.[k] ?? 0) > 0);
              return (
                <tr key={p.id}>
                  <th scope="row" className="sticky left-0 z-10 border-b border-r border-slate-800 bg-steel-900 p-0 text-left font-normal">
                    <button type="button" className="block w-full px-2 py-1.5 text-left hover:bg-steel-800" onClick={() => props.onPerson(p)}>
                      <span className="block truncate text-[13px] font-medium text-slate-100">{p.fullName}</span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {ROLE_LABEL[p.role]}
                        {!p.isActive && ' · ажлаас гарсан'}
                      </span>
                      <span className="block text-[10px] text-slate-400">
                        {p.presentDays}/{workingDays} өдөр
                        {p.waiting ? <span className="text-yellow-300"> · {p.waiting} батлаагүй</span> : null}
                      </span>
                      {p.unclosed.length > 0 && (
                        <span className="block text-[10px] text-red-300">
                          {AUTO_CLOSED}: {p.unclosed.length}
                        </span>
                      )}
                    </button>
                  </th>
                  {days.map((d) => {
                    const kind = cellKind(d, ix.recs.get(d), ix.marks.get(d), ix.unknown.has(d), holidays.has(d), today, lateAfter, week, p.startedOn);
                    const c = codeOf(kind);
                    return (
                      <td key={d} className={`border-b border-slate-800 p-0.5 ${d === today ? 'bg-steel-800/60' : ''}`}>
                        <button
                          type="button"
                          onClick={() => props.onCell(p, d)}
                          aria-label={`${p.fullName}, ${d}: ${c.label || 'бүртгэлгүй'}`}
                          className={`flex h-9 w-9 items-center justify-center rounded border text-[11px] font-semibold hover:ring-1 hover:ring-amber-brand ${c.tone}`}
                        >
                          {c.code}
                        </button>
                      </td>
                    );
                  })}
                  <td className="border-b border-l border-slate-800 px-2 text-right whitespace-nowrap">
                    {p.presentDays}/{workingDays}
                  </td>
                  <td className={`border-b border-slate-800 px-2 text-right ${p.lateDays ? 'text-amber-300' : 'text-slate-500'}`}>{p.lateDays || '—'}</td>
                  <td className={`border-b border-slate-800 px-2 text-right ${p.overtimeDays ? 'text-sky-300' : 'text-slate-500'}`}>
                    {p.overtimeDays || '—'}
                  </td>
                  <td className="border-b border-slate-800 px-2 text-right whitespace-nowrap">{p.hours} ц</td>
                  <td className="border-b border-slate-800 px-2 py-1">
                    {counts.length === 0 ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <div className="flex min-w-[10rem] flex-wrap gap-1">
                        {counts.map((k) => (
                          <span key={k} className={`whitespace-nowrap rounded border px-1 ${MARK[k].tone}`}>
                            {MARK[k].label} {p.markCounts?.[k]}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {props.loading && <p className="p-3 text-sm text-slate-500">Уншиж байна…</p>}
        {!props.loading && data && data.people.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ сард бүртгэл алга.</p>}
      </div>

      <section className="card mt-3">
        <p className="mb-2 text-xs font-semibold text-slate-300">Тэмдэглэгээ</p>
        <ul className="grid grid-cols-1 gap-1.5 text-xs text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
          {[STATE.present, STATE.late, STATE.waiting, ...MARKS.map((k) => MARK[k]), STATE.holiday, STATE.off, STATE.before, STATE.unknown].map((c) => (
            <li key={c.label} className="flex items-center gap-2">
              <span className={`inline-flex h-6 w-8 shrink-0 items-center justify-center rounded border font-semibold ${c.tone}`}>{c.code}</span>
              {c.label}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-slate-400">
          Нүдэн дээр дарж тэр өдрийн төлөв тавих / арилгах, ирц нэмэх, бүртгэлийг харна. Нэрэн дээр дарж сарын бүх бүртгэлийг харна. Хоосон нүд —
          болоогүй өдөр.
        </p>
        <p className="mt-1 text-[11px] text-amber-200">
          Төлөв (чөлөө, өвчтэй, тасалсан…) цалинг автоматаар өөрчлөхгүй — эзэн шийдээд «Цалин» хэсэгт суутгал, урамшууллыг гараар бичнэ.
        </p>
        <p className="mt-1 text-[11px] text-slate-500">Засвар бүр шалтгаантайгаа засварын тайланд үлдэнэ; цалин олгосон сарыг засахгүй.</p>
      </section>
    </>
  );
}

/** One record line with its buttons, shared by the day menu and the month records. */
function RecordLine(props: {
  r: MonthRecord;
  today: string;
  showDay?: boolean;
  mayFix: boolean;
  who: string;
  onFix: (t: FixTarget) => void;
  onDelete: (t: RecordTarget) => void;
  onConfirm: (id: string) => void;
}) {
  const { r } = props;
  const day = ubDay(r.checkIn);
  const outDay = r.checkOut ? ubDay(r.checkOut) : null;
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {props.showDay && (
          <span className="font-mono whitespace-nowrap">
            {day} <span className="text-slate-500">{weekday(day)}</span>
          </span>
        )}
        <span className="font-mono whitespace-nowrap">
          {ubTime(r.checkIn)} –{' '}
          {r.checkOut ? (
            `${outDay !== day ? `${outDay?.slice(5)} ` : ''}${ubTime(r.checkOut)}`
          ) : isStale(r.checkIn, props.today) ? (
            <span className="font-sans text-red-300">явсан цаг бүртгээгүй</span>
          ) : (
            <span className="font-sans text-emerald-300">ажил дээр</span>
          )}
        </span>
        <span className={STATUS_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status] ?? r.status}</span>
        {r.confirmed === false && <WaitingBadge />}
      </div>
      {r.notes && <p className={`mt-0.5 text-[11px] ${r.notes.includes(AUTO_CLOSED) ? 'text-amber-300' : 'text-slate-500'}`}>{r.notes}</p>}
      {props.mayFix && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {r.confirmed === false && (
            <button className="btn-primary text-xs" onClick={() => props.onConfirm(r.id)}>
              Батлах
            </button>
          )}
          <button className="btn-ghost text-xs" onClick={() => props.onFix({ ...r, who: props.who })}>
            засах
          </button>
          <button
            className="btn-ghost text-xs text-red-300"
            onClick={() => props.onDelete({ id: r.id, who: props.who, checkIn: r.checkIn, checkOut: r.checkOut })}
          >
            устгах
          </button>
        </div>
      )}
    </li>
  );
}

/** The menu of one grid cell: the day's status and records, and what can be done about them. */
function CellModal(props: {
  person: MonthPerson;
  date: string;
  today: string;
  holiday: boolean;
  lateAfter: number | null;
  /** Working days a week, or null when not known. */
  week: number | null;
  mayFix: boolean;
  onClose: () => void;
  onMark: (t: MarkTarget) => void;
  onClearMark: (userId: string, date: string) => void;
  onAdd: (userId: string, date: string) => void;
  onFix: (t: FixTarget) => void;
  onDelete: (t: RecordTarget) => void;
  onConfirm: (id: string) => void;
  onRecords: (p: MonthPerson) => void;
}) {
  const { person: p, date, today } = props;
  const ix = indexPerson(p);
  const recs = ix.recs.get(date) ?? [];
  const mark = ix.marks.get(date);
  const kind = cellKind(date, recs, mark, ix.unknown.has(date), props.holiday, today, props.lateAfter, props.week, p.startedOn);
  const c = codeOf(kind);
  return (
    <Modal onClose={props.onClose} title={p.fullName} size="sm">
      <p className="-mt-2 text-xs text-slate-400">
        {date} {weekday(date)}
        {c.label && <> · {c.label}</>}
      </p>
      {mark && (
        <div>
          <MarkChip mark={mark.mark} note={mark.note} />
          {mark.fromRequest && <p className="mt-1 text-[11px] text-slate-500">Ажилтны хүсэлтээр зөвшөөрсөн.</p>}
        </div>
      )}
      {kind === 'unknown' && (
        <p className="rounded border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">
          Ажлын өдөр боловч ирц ч, төлөв ч алга. Ирсэн бол «+ Ирц нэмэх», ирээгүй бол төлөв (тасалсан, чөлөө…) тавина.
        </p>
      )}
      {recs.length > 0 ? (
        <ul className="divide-y divide-slate-800 text-sm">
          {recs.map((r) => (
            <RecordLine
              key={r.id}
              r={r}
              today={today}
              mayFix={props.mayFix}
              who={p.fullName}
              onFix={props.onFix}
              onDelete={props.onDelete}
              onConfirm={props.onConfirm}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">Энэ өдөр ирсэн бүртгэл алга.</p>
      )}
      {props.mayFix ? (
        <div className="grid grid-cols-1 gap-2 border-t border-slate-800 pt-3">
          <button
            className="btn-ghost"
            onClick={() => props.onMark({ userId: p.id, who: p.fullName, date, mark: mark?.mark ?? null, note: mark?.note, fromRequest: mark?.fromRequest })}
          >
            {mark ? 'Төлөв солих' : 'Төлөв тавих'} (чөлөө, өвчтэй, тасалсан…)
          </button>
          {mark && (
            <button className="btn-ghost text-red-300" onClick={() => props.onClearMark(p.id, date)}>
              Төлөв арилгах
            </button>
          )}
          {date <= today && (
            <button className="btn-ghost" onClick={() => props.onAdd(p.id, date)}>
              + Ирц нэмэх
            </button>
          )}
          <button className="btn-ghost" onClick={() => props.onRecords(p)}>
            Сарын бүх бүртгэл
          </button>
        </div>
      ) : (
        <div className="border-t border-slate-800 pt-3">
          <p className="mb-2 text-xs text-slate-500">Өөрийн ирцийг өөр менежер засна.</p>
          <button className="btn-ghost w-full" onClick={() => props.onRecords(p)}>
            Сарын бүх бүртгэл
          </button>
        </div>
      )}
    </Modal>
  );
}

/** The person's month: every record (correct, remove, confirm) and the day statuses. */
function PersonRecordsModal(props: {
  person: MonthPerson;
  period: string;
  today: string;
  mayFix: boolean;
  onClose: () => void;
  onAdd: (userId: string) => void;
  onFix: (t: FixTarget) => void;
  onDelete: (t: RecordTarget) => void;
  onConfirm: (id: string) => void;
  onMark: (t: MarkTarget) => void;
}) {
  const { person: p } = props;
  const marks = [...(p.marks ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <Modal onClose={props.onClose} title={p.fullName} size="lg">
      <p className="-mt-2 text-xs text-slate-400">
        {props.period} · {ROLE_LABEL[p.role]} · ирсэн {p.presentDays} өдөр · {p.hours} цаг
      </p>
      {props.mayFix && (
        <button className="btn-ghost" onClick={() => props.onAdd(p.id)}>
          + Ирц нэмэх
        </button>
      )}
      <div>
        <p className="text-xs font-semibold text-slate-300">Ирсэн, явсан</p>
        {p.records.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">Энэ сард бүртгэл алга.</p>
        ) : (
          <ul className="divide-y divide-slate-800 text-sm">
            {p.records.map((r) => (
              <RecordLine
                key={r.id}
                r={r}
                today={props.today}
                showDay
                mayFix={props.mayFix}
                who={p.fullName}
                onFix={props.onFix}
                onDelete={props.onDelete}
                onConfirm={props.onConfirm}
              />
            ))}
          </ul>
        )}
      </div>
      {marks.length > 0 && (
        <div className="border-t border-slate-800 pt-3">
          <p className="text-xs font-semibold text-slate-300">Өдрийн төлөв</p>
          <ul className="mt-1 divide-y divide-slate-800 text-sm">
            {marks.map((m) => (
              <li key={m.date} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono whitespace-nowrap">
                    {m.date} <span className="text-slate-500">{weekday(m.date)}</span>
                  </span>
                  <MarkChip mark={m.mark} note={m.note} />
                  {m.fromRequest && <span className="text-[11px] text-slate-500">хүсэлтээр</span>}
                </div>
                {props.mayFix && (
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => props.onMark({ userId: p.id, who: p.fullName, date: m.date, mark: m.mark, note: m.note, fromRequest: m.fromRequest })}
                  >
                    солих
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!props.mayFix && <p className="text-xs text-slate-500">Өөрийн ирцийг өөр менежер засна.</p>}
    </Modal>
  );
}

// ───────── Requests ─────────

function RequestsView(props: {
  rows: LeaveRow[] | null;
  loading: boolean;
  filter: 'PENDING' | 'ALL';
  onFilter: (f: 'PENDING' | 'ALL') => void;
  mayFix: (userId: string) => boolean;
  onDecide: (r: LeaveRow, approve: boolean) => void;
  onCut: (r: LeaveRow) => void;
}) {
  const rows = [...(props.rows ?? [])].sort(
    (a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            ['PENDING', 'Хүлээгдэж буй'],
            ['ALL', 'Бүгд'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={props.filter === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => props.onFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs text-slate-400">
        Ажилтан «Миний ирц» хэсгээс чөлөө хүсдэг. Зөвшөөрвөл тэр хугацааны ажлын өдрүүдэд төлөв тавигдана. Цалин автоматаар өөрчлөгдөхгүй.
      </p>
      {props.loading && rows.length === 0 && <p className="text-sm text-slate-500">Уншиж байна…</p>}
      {!props.loading && props.rows && rows.length === 0 && (
        <p className="card text-sm text-slate-500">{props.filter === 'PENDING' ? 'Хүлээгдэж буй хүсэлт алга.' : 'Хүсэлт алга.'}</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((r) => {
          const st = LEAVE_STATUS[r.status];
          return (
            <article key={r.id} className={`card ${r.status === 'PENDING' ? 'border-amber-700/70' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{r.user.fullName}</p>
                  <p className="text-[11px] text-slate-500">{ROLE_LABEL[r.user.role]}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${st.tone}`}>{st.label}</span>
              </div>
              <div className="mt-2">
                <MarkChip mark={r.kind} />
              </div>
              <p className="mt-1 text-sm">
                {r.fromDate === r.toDate ? r.fromDate : `${r.fromDate} – ${r.toDate}`}{' '}
                <span className="text-slate-500">({spanDays(r.fromDate, r.toDate)} хоног)</span>
              </p>
              <p className="mt-1 break-words text-sm text-slate-300">{r.reason}</p>
              <p className="mt-1 text-[11px] text-slate-500">Илгээсэн: {fmt(r.createdAt)}</p>
              {(r.decidedBy || r.decisionNote) && (
                <p className="text-[11px] text-slate-400">
                  {r.decidedBy ?? ''}
                  {r.decisionNote ? `: ${r.decisionNote}` : ''}
                </p>
              )}
              {r.status === 'PENDING' &&
                (props.mayFix(r.user.id) ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button className="btn-primary" onClick={() => props.onDecide(r, true)}>
                      Зөвшөөрөх
                    </button>
                    <button className="btn-ghost" onClick={() => props.onDecide(r, false)}>
                      Татгалзах
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-slate-500">Өөрийн хүсэлтийг өөр менежер шийднэ.</p>
                ))}
              {r.status === 'APPROVED' && props.mayFix(r.user.id) && (
                <div className="mt-3">
                  <button className="btn-ghost text-sm" onClick={() => props.onCut(r)}>
                    Цуцлах / богиносгох
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

/** A manager cancels an approved leave, or ends it earlier (the person came back): later day statuses are removed. */
function CutLeaveModal(props: { request: LeaveRow; today: string; onClose: () => void; onDone: (msg: string) => void }) {
  const r = props.request;
  const canShorten = r.fromDate < r.toDate;
  const lastAllowed = prevDay(r.toDate);
  // Came back after the leave started: shorten to the day before today. Otherwise (not started, or back on the first
  // day) the whole leave goes.
  const [mode, setMode] = useState<'shorten' | 'cancel'>(canShorten && props.today > r.fromDate ? 'shorten' : 'cancel');
  // Back today: the leave ends yesterday; before it started or after it, the nearest allowed day.
  const suggested = props.today > r.fromDate ? (prevDay(props.today) < lastAllowed ? prevDay(props.today) : lastAllowed) : r.fromDate;
  const [toDate, setToDate] = useState(suggested < r.fromDate ? r.fromDate : suggested);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (note.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    if (mode === 'shorten' && !(toDate >= r.fromDate && toDate <= lastAllowed)) {
      return setError(`Сүүлийн өдөр ${r.fromDate} – ${lastAllowed} хооронд байна`);
    }
    setSaving(true);
    try {
      await api(`/hr/leave/${r.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(mode === 'shorten' ? { toDate, note: note.trim() } : { note: note.trim() }),
      });
      props.onDone(mode === 'shorten' ? `${r.user.fullName}: чөлөө ${toDate}-нд дуусна` : `${r.user.fullName}: чөлөө цуцлагдлаа`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title="Зөвшөөрсөн чөлөө"
      size="sm"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="cut-leave-form" className={mode === 'cancel' ? 'btn-danger' : 'btn-primary'} disabled={saving}>
            {saving ? 'Хадгалж байна…' : mode === 'cancel' ? 'Чөлөө цуцлах' : 'Богиносгох'}
          </button>
        </>
      }
    >
      <form id="cut-leave-form" onSubmit={save} className="space-y-3">
        <div className="text-sm">
          <p className="font-medium">{r.user.fullName}</p>
          <div className="mt-1">
            <MarkChip mark={r.kind} />
          </div>
          <p className="mt-1">
            {r.fromDate === r.toDate ? r.fromDate : `${r.fromDate} – ${r.toDate}`}{' '}
            <span className="text-slate-500">({spanDays(r.fromDate, r.toDate)} хоног)</span>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={mode === 'shorten' ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
            disabled={!canShorten}
            onClick={() => setMode('shorten')}
          >
            Эрт ирсэн
          </button>
          <button type="button" className={mode === 'cancel' ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setMode('cancel')}>
            Бүхэлд нь цуцлах
          </button>
        </div>
        {mode === 'shorten' ? (
          <label className="block text-xs text-slate-400">
            Чөлөөний сүүлийн өдөр
            <input type="date" className="mt-1 w-full" min={r.fromDate} max={lastAllowed} value={toDate} onChange={(e) => setToDate(e.target.value)} required />
            <span className="mt-1 block text-[11px] text-slate-500">
              {/^\d{4}-\d{2}-\d{2}$/.test(toDate) && nextDay(toDate) <= r.toDate
                ? `${nextDay(toDate)}-с хойшхи өдрүүдийн «${MARK[r.kind].label}» төлөв арилна.`
                : ''}
            </span>
          </label>
        ) : (
          <p className="text-xs text-slate-400">Бүх өдрийн «{MARK[r.kind].label}» төлөв арилна. Цалин нь олгогдсон сарын өдөр орсон бол өөрчлөх боломжгүй.</p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          Шалтгаан
          <input
            className="mt-1 w-full"
            maxLength={300}
            required
            placeholder={mode === 'cancel' ? 'Ажилдаа гарсан…' : 'Эрт ирсэн…'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}

function DecideModal(props: { request: LeaveRow; approve: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const { request: r, approve } = props;
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!approve && note.trim().length < 3) return setError('Татгалзсан шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    setSaving(true);
    try {
      await api(`/hr/leave/${r.id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      props.onDone(approve ? `${r.user.fullName}: хүсэлт зөвшөөрөгдлөө` : `${r.user.fullName}: хүсэлт татгалзлаа`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title={approve ? 'Хүсэлт зөвшөөрөх' : 'Хүсэлт татгалзах'}
      size="sm"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="decide-form" className={approve ? 'btn-primary' : 'btn-danger'} disabled={saving}>
            {saving ? 'Хадгалж байна…' : approve ? 'Зөвшөөрөх' : 'Татгалзах'}
          </button>
        </>
      }
    >
      <form id="decide-form" onSubmit={save} className="space-y-3">
        <div className="text-sm">
          <p className="font-medium">{r.user.fullName}</p>
          <div className="mt-1">
            <MarkChip mark={r.kind} />
          </div>
          <p className="mt-1">
            {r.fromDate === r.toDate ? r.fromDate : `${r.fromDate} – ${r.toDate}`}{' '}
            <span className="text-slate-500">({spanDays(r.fromDate, r.toDate)} хоног)</span>
          </p>
          <p className="mt-1 break-words text-slate-300">{r.reason}</p>
        </div>
        {approve && (
          <p className="text-xs text-slate-400">
            Тэр хугацааны ажлын өдрүүдэд «{MARK[r.kind].label}» төлөв тавигдана (амралтын, баярын өдөр алгасна). Цалин автоматаар өөрчлөгдөхгүй.
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          {approve ? 'Тайлбар (заавал биш)' : 'Татгалзах шалтгаан'}
          <input
            className="mt-1 w-full"
            maxLength={300}
            required={!approve}
            autoFocus={!approve}
            placeholder={approve ? 'Ажлаа хүлээлгэж өгөөрэй…' : 'Тэр өдөр хүн дутна, өөр өдөр сонгоно уу…'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}

// ───────── Dialogs: day status, add / remove / fix a record, settings ─────────

/** A day's status for a person, set or cleared by a manager. */
function MarkModal(props: { target: MarkTarget; onClose: () => void; onDone: (msg: string) => void }) {
  const t = props.target;
  const [mark, setMark] = useState<DayMark | null>(t.mark);
  const [note, setNote] = useState(t.note ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<'save' | 'clear' | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!mark) return setError('Төлөв сонгоно уу');
    setSaving('save');
    try {
      await api('/hr/attendance/days', {
        method: 'PUT',
        body: JSON.stringify({ userId: t.userId, date: t.date, mark, note: note.trim() || undefined }),
      });
      props.onDone(`${t.who} ${t.date}: ${MARK[mark].label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(null);
    }
  }

  async function clear() {
    setError('');
    setSaving('clear');
    try {
      await api(`/hr/attendance/days/${t.userId}/${t.date}`, { method: 'DELETE' });
      props.onDone(`${t.who} ${t.date}: төлөв арилгалаа`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Арилгаж чадсангүй');
    } finally {
      setSaving(null);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title="Өдрийн төлөв"
      busy={saving !== null}
      footer={
        <>
          {t.mark && (
            <button type="button" className="btn-ghost mr-auto text-red-300" disabled={saving !== null} onClick={() => void clear()}>
              {saving === 'clear' ? 'Арилгаж байна…' : 'Төлөв арилгах'}
            </button>
          )}
          <button type="button" className="btn-ghost" disabled={saving !== null} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="mark-form" className="btn-primary" disabled={saving !== null}>
            {saving === 'save' ? 'Хадгалж байна…' : 'Хадгалах'}
          </button>
        </>
      }
    >
      <form id="mark-form" onSubmit={save} className="space-y-3">
        <p className="-mt-2 text-xs text-slate-400">
          {t.who} · {t.date} {weekday(t.date)}
        </p>
        {t.fromRequest && <p className="text-xs text-slate-400">Одоогийн төлөвийг ажилтны хүсэлтээр зөвшөөрсөн.</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MARKS.map((k) => (
            <label
              key={k}
              className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                mark === k ? 'border-amber-brand bg-steel-800' : 'border-slate-700'
              }`}
            >
              <input type="radio" name="mark" className="h-4 w-4" checked={mark === k} onChange={() => setMark(k)} />
              <span className={`inline-flex h-6 w-8 items-center justify-center rounded border text-xs font-semibold ${MARK[k].tone}`}>{MARK[k].code}</span>
              {MARK[k].label}
            </label>
          ))}
        </div>
        <label className="block text-xs text-slate-400">
          Тайлбар (заавал биш)
          <input className="mt-1 w-full" maxLength={300} placeholder="Утсаар мэдэгдсэн, эмчийн магадлагаатай…" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="text-[11px] text-slate-500">Төлөв цалинг автоматаар өөрчлөхгүй — хасах, нэмэх бол «Цалин» хэсэгт гараар бичнэ.</p>
      </form>
    </Modal>
  );
}

/** A day someone worked but nobody pressed «Ирсэн»: person, date, times and why. */
function AddRecordModal(props: {
  people: Person[];
  userId?: string;
  date?: string;
  today: string;
  shiftStart: string;
  shiftEnd: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { today } = props;
  const firstDay = props.date && props.date <= today ? props.date : today;
  const [who, setWho] = useState(props.userId ?? '');
  const [day, setDay] = useState(firstDay);
  const [inTime, setInTime] = useState(props.shiftStart);
  const [outTime, setOutTime] = useState(firstDay < today ? props.shiftEnd : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const overnight = Boolean(outTime && inTime && outTime <= inTime);
  const inIso = day && inTime ? fromUbLocal(`${day}T${inTime}`) : null;
  const outIso = day && outTime ? fromUbLocal(`${overnight ? nextDay(day) : day}T${outTime}`) : null;
  const workedMin = inIso && outIso ? Math.round((Date.parse(outIso) - Date.parse(inIso)) / 60_000) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!who) return setError('Ажилтнаа сонгоно уу');
    if (!day || !inIso) return setError('Өдөр, ирсэн цагаа оруулна уу');
    if (!outIso && day < today) return setError('Өмнөх өдрийн бүртгэлд явсан цагийг оруулна уу');
    if (Date.parse(inIso) > Date.now() || (outIso && Date.parse(outIso) > Date.now())) return setError('Ирээдүйн цаг оруулахгүй');
    if (workedMin !== null && workedMin > 24 * 60) return setError('Нэг бүртгэл 24 цагаас урт байж болохгүй');
    if (reason.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    setSaving(true);
    try {
      await api('/hr/attendance', {
        method: 'POST',
        body: JSON.stringify({ userId: who, checkIn: inIso, ...(outIso ? { checkOut: outIso } : {}), reason: reason.trim() }),
      });
      const name = props.people.find((p) => p.id === who)?.fullName ?? '';
      props.onDone(`${name} ${day}: ирц нэмэгдлээ`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title="Ирц нэмэх"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="add-form" className="btn-primary" disabled={saving}>
            {saving ? 'Хадгалж байна…' : 'Нэмэх'}
          </button>
        </>
      }
    >
      <form id="add-form" onSubmit={save} className="space-y-3">
        <p className="-mt-2 text-xs text-slate-400">Ажилласан ч бүртгэгдээгүй өдрийг нэмнэ. Улаанбаатарын цагаар. Шалтгаан засварын тайланд үлдэнэ.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          Ажилтан
          <select className="mt-1 w-full" required value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">— сонгох —</option>
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-400">
          Өдөр
          <input type="date" className="mt-1 w-full" required max={today} value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            Ирсэн цаг
            <input type="time" className="mt-1 w-full" required value={inTime} onChange={(e) => setInTime(e.target.value)} />
          </label>
          <label className="block text-xs text-slate-400">
            Явсан цаг
            <input type="time" className="mt-1 w-full" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
          </label>
        </div>
        <p className="text-[11px] text-slate-500">
          {day === today ? 'Явсан цагийг хоосон орхивол «одоо ч ажил дээр» гэж үлдэнэ. ' : ''}
          {overnight ? 'Явсан цаг ирсэн цагаас өмнө тул дараагийн өдөр гэж тооцно. ' : ''}
          {workedMin !== null && workedMin > 0 && `Ажилласан: ${Math.floor(workedMin / 60)} ц ${workedMin % 60} мин`}
        </p>
        <label className="block text-xs text-slate-400">
          Шалтгаан
          <input
            className="mt-1 w-full"
            required
            minLength={3}
            maxLength={200}
            placeholder="Ирсэн ч товч дараагүй, утас нь унтарсан…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}

/** A wrong record (the wrong person pressed, a test) removed with a reason. */
function DeleteRecordModal(props: { target: RecordTarget; onClose: () => void; onDone: (msg: string) => void }) {
  const t = props.target;
  const day = ubDay(t.checkIn);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function remove(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (reason.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    setSaving(true);
    try {
      await api(`/hr/attendance/${t.id}`, { method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }) });
      props.onDone(`${t.who} ${day}: бүртгэл устгагдлаа`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Устгаж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title="Бүртгэл устгах"
      size="sm"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="delete-form" className="btn-danger" disabled={saving}>
            {saving ? 'Устгаж байна…' : 'Устгах'}
          </button>
        </>
      }
    >
      <form id="delete-form" onSubmit={remove} className="space-y-3">
        <div className="text-sm">
          <p className="font-medium">{t.who}</p>
          <p className="font-mono text-slate-300">
            {day} {weekday(day)} · {ubTime(t.checkIn)} – {t.checkOut ? ubTime(t.checkOut) : '…'}
          </p>
        </div>
        <p className="text-xs text-slate-400">Буруу хүн дарсан, туршилт гэх мэт буруу бүртгэлийг устгана. Шалтгаан засварын тайланд үлдэнэ.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          Шалтгаан
          <input
            className="mt-1 w-full"
            required
            minLength={3}
            maxLength={200}
            autoFocus
            placeholder="Өөр хүн дарсан, давхар бүртгэгдсэн…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}

/**
 * Correct a check-in/out (forgotten check-out, button pressed late). Inputs are Ulaanbaatar time; only the
 * changed times are sent. A forgotten check-out of an earlier day starts at the end of the shift.
 */
function FixModal(props: { target: FixTarget; shiftEnd?: string; onClose: () => void; onSaved: () => void }) {
  const t = props.target;
  const day = ubDay(t.checkIn);
  // Forgotten, by the same 16-hour rule as the rest of the page (a shift running past midnight is not).
  const forgot = !t.checkOut && isStale(t.checkIn, ubDay(new Date()));
  const [checkIn, setCheckIn] = useState(toUbLocal(t.checkIn));
  const [atWork, setAtWork] = useState(!t.checkOut && !forgot);
  const [checkOut, setCheckOut] = useState(t.checkOut ? toUbLocal(t.checkOut) : forgot ? `${day}T${props.shiftEnd ?? '18:00'}` : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const now = toUbLocal(new Date());

  const inMs = checkIn ? Date.parse(fromUbLocal(checkIn)) : NaN;
  const outMs = !atWork && checkOut ? Date.parse(fromUbLocal(checkOut)) : NaN;
  const workedMin = Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs ? Math.round((outMs - inMs) / 60_000) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!checkIn) return setError('Ирсэн цагаа оруулна уу');
    if (!atWork && !checkOut) return setError('Гарсан цагаа оруулна уу, эсвэл «Одоо ч ажил дээр»-г сонгоно уу');
    if (!atWork && outMs <= inMs) return setError('Гарсан цаг ирсэн цагаас хойш байна');
    if (!atWork && outMs - inMs > 24 * 3_600_000) return setError('Нэг бүртгэл 24 цагаас урт байж болохгүй');
    if (Math.max(inMs, Number.isFinite(outMs) ? outMs : 0) > Date.now()) return setError('Ирээдүйн цаг оруулахгүй');
    if (reason.trim().length < 3) return setError('Шалтгаанаа бичнэ үү (3-аас доошгүй тэмдэгт)');
    const body: { checkIn?: string; checkOut?: string | null; reason: string } = { reason: reason.trim() };
    if (checkIn !== toUbLocal(t.checkIn)) body.checkIn = fromUbLocal(checkIn);
    if (atWork) {
      if (t.checkOut) body.checkOut = null;
    } else if (!t.checkOut || checkOut !== toUbLocal(t.checkOut)) {
      body.checkOut = fromUbLocal(checkOut);
    }
    if (body.checkIn === undefined && body.checkOut === undefined) return setError('Өөрчлөлт алга');
    setSaving(true);
    try {
      await api(`/hr/attendance/${t.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={props.onClose}
      title="Ирц засах"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={props.onClose}>
            Болих
          </button>
          <button type="submit" form="fix-form" className="btn-primary" disabled={saving}>
            {saving ? 'Хадгалж байна…' : 'Хадгалах'}
          </button>
        </>
      }
    >
      <form id="fix-form" onSubmit={save} className="space-y-3">
        <div className="-mt-2">
          <p className="text-xs text-slate-400">
            {t.who} · {day} {weekday(day)} · Улаанбаатарын цагаар
          </p>
          {t.notes && <p className={`mt-1 text-[11px] ${t.notes.includes(AUTO_CLOSED) ? 'text-amber-300' : 'text-slate-500'}`}>{t.notes}</p>}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <label className="block text-xs text-slate-400">
          Ирсэн
          <input type="datetime-local" className="mt-1 w-full" required max={now} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
        </label>
        <label className="block text-xs text-slate-400">
          Гарсан
          <input
            type="datetime-local"
            className="mt-1 w-full"
            disabled={atWork}
            max={now}
            value={atWork ? '' : checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
          />
        </label>
        <label className="flex min-h-[40px] items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={atWork} onChange={(e) => setAtWork(e.target.checked)} />
          Одоо ч ажил дээр
        </label>
        {workedMin !== null && (
          <p className="text-xs text-slate-500">
            Ажилласан: {Math.floor(workedMin / 60)} ц {workedMin % 60} мин
          </p>
        )}
        <label className="block text-xs text-slate-400">
          Шалтгаан
          <input
            className="mt-1 w-full"
            required
            minLength={3}
            maxLength={200}
            placeholder="Гарахдаа бүртгүүлээгүй, товч хожуу дарсан…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-slate-500">Засварын тайланд хуучин, шинэ цагтай хамт үлдэнэ.</span>
        </label>
      </form>
    </Modal>
  );
}

/** Admin: the working day that decides late and overtime, self check-in, and public holidays. */
function SettingsModal({ hours, onClose, onSaved }: { hours: WorkHours; onClose: () => void; onSaved: (next: WorkHours) => void }) {
  const [form, setForm] = useState<WorkHours>({ ...hours, selfCheckIn: hours.selfCheckIn ?? 'CONFIRM', holidays: hours.holidays ?? [] });
  const [newHoliday, setNewHoliday] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const holidays = form.holidays ?? [];

  function addHoliday() {
    setMsg('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newHoliday)) return setMsg('Өдрөө сонгоно уу');
    if (holidays.includes(newHoliday)) return setMsg('Энэ өдөр нэмэгдсэн байна');
    if (holidays.length >= 60) return setMsg('60-аас олон өдөр нэмэхгүй — өнгөрсөн жилийнхийг хасна уу');
    setForm({ ...form, holidays: [...holidays, newHoliday].sort() });
    setNewHoliday('');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    if (form.shiftEnd <= form.shiftStart) return setMsg('Ажлын төгсгөл эхлэлээс хойш байна');
    setSaving(true);
    try {
      onSaved(await api<WorkHours>('/hr/attendance/settings', { method: 'PUT', body: JSON.stringify(form) }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="Ирцийн тохиргоо"
      size="lg"
      busy={saving}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>
            Болих
          </button>
          <button type="submit" form="settings-form" className="btn-primary" disabled={saving}>
            {saving ? 'Хадгалж байна…' : 'Хадгалах'}
          </button>
        </>
      }
    >
      <form id="settings-form" onSubmit={save} className="space-y-4">
        {msg && <p className="text-sm text-red-400">{msg}</p>}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Ажлын цаг</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-xs text-slate-400">
              Эхлэх
              <input type="time" className="mt-1 block w-full" required value={form.shiftStart} onChange={(e) => setForm({ ...form, shiftStart: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400">
              Дуусах
              <input type="time" className="mt-1 block w-full" required value={form.shiftEnd} onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400">
              Хүлцэл, мин (хоцролт биш)
              <input
                type="number"
                inputMode="numeric"
                className="mt-1 block w-full"
                min={0}
                max={180}
                required
                value={form.graceMinutes}
                onChange={(e) => setForm({ ...form, graceMinutes: Math.round(Number(e.target.value)) })}
              />
            </label>
            <label className="text-xs text-slate-400">
              Илүү цаг — хэдэн цагаас дээш
              <input
                type="number"
                inputMode="decimal"
                className="mt-1 block w-full"
                min={1}
                max={24}
                step="0.5"
                required
                value={form.overtimeAfterHours}
                onChange={(e) => setForm({ ...form, overtimeAfterHours: Number(e.target.value) })}
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Ажилтан ирцээ өөрөө бүртгүүлэх</legend>
          <p className="mb-2 text-xs text-slate-400">«Миний ирц» хуудсанд «Ирлээ / Явлаа» товч гарах эсэх.</p>
          <div className="grid gap-2">
            {(Object.keys(SELF_MODE) as SelfMode[]).map((k) => (
              <label
                key={k}
                className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border px-3 py-2 ${
                  form.selfCheckIn === k ? 'border-amber-brand bg-steel-800' : 'border-slate-700'
                }`}
              >
                <input type="radio" name="selfCheckIn" className="mt-1 h-4 w-4" checked={form.selfCheckIn === k} onChange={() => setForm({ ...form, selfCheckIn: k })} />
                <span>
                  <span className="block text-sm font-medium">{SELF_MODE[k].label}</span>
                  <span className="block text-xs text-slate-400">{SELF_MODE[k].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Нийтийн амралтын өдрүүд</legend>
          <p className="mb-2 text-xs text-slate-400">Цагаан сар, Наадам гэх мэт. Эдгээр өдөр ажлын өдөрт тооцогдохгүй, ирээгүй гэж харагдахгүй.</p>
          <div className="flex flex-wrap gap-2">
            <input type="date" className="w-full sm:w-48" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} aria-label="Нэмэх өдөр" />
            <button type="button" className="btn-ghost" onClick={addHoliday}>
              Нэмэх
            </button>
          </div>
          {holidays.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Өдөр нэмээгүй.</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {holidays.map((h) => (
                <li key={h} className="flex items-center rounded-md border border-slate-600 bg-steel-800 pl-2 text-sm">
                  <span className="font-mono">
                    {h} <span className="text-slate-400">{weekday(h)}</span>
                  </span>
                  <button
                    type="button"
                    className="ml-1 h-9 w-9 rounded-md text-slate-300 hover:bg-steel-700 hover:text-red-300"
                    aria-label={`${h} хасах`}
                    onClick={() => setForm({ ...form, holidays: holidays.filter((x) => x !== h) })}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-slate-500">«Хадгалах» дарсны дараа хүчинтэй болно.</p>
        </fieldset>
      </form>
    </Modal>
  );
}
