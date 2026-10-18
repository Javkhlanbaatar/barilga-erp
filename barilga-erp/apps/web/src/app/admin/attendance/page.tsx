'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { can, savedUser, useCan } from '@/lib/permissions';
import { AttendanceBoard, AuthUser, ROLE_LABEL, Role } from '@/lib/types';

const ATTENDANCE_STATUS_LABEL: Record<string, string> = { ON_TIME: 'Цагтаа', LATE: 'Хоцорсон', OVERTIME: 'Илүү цаг' };
const STATUS_TONE: Record<string, string> = { ON_TIME: 'text-emerald-300', LATE: 'text-amber-300', OVERTIME: 'text-sky-300' };
const WEEKDAY = ['Ня', 'Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя'];
const AUTO_CLOSED = 'Гарсан цаг бүртгээгүй';

type AttendanceStatus = 'ON_TIME' | 'LATE' | 'OVERTIME';
type MonthRecord = { id: string; checkIn: string; checkOut: string | null; status: AttendanceStatus; notes: string | null };
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
};
/** GET /hr/attendance/month */
type AttendanceMonth = { periodMonth: string; workingDays: number; people: MonthPerson[] };
/** GET/PUT /hr/attendance/settings */
type WorkHours = { shiftStart: string; graceMinutes: number; shiftEnd: string; overtimeAfterHours: number };
/** The record being corrected and whose it is. */
type FixTarget = { id: string; checkIn: string; checkOut: string | null; notes?: string | null; who: string };

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
const weekday = (day: string) => WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()];

function fmt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' });
}

function hoursLine(h: WorkHours) {
  return `Ажил ${h.shiftStart}–${h.shiftEnd}, ${h.graceMinutes} мин хүлцэл, ${h.overtimeAfterHours} цагаас илүү бол илүү цаг`;
}

function leaveFor(user: AuthUser | null) {
  return user?.role === 'ACHIGCH_BELTGEGCH' ? '/warehouse/tickets' : '/pos';
}

export default function AttendanceAdminPage() {
  const router = useRouter();
  const canDo = useCan();
  const mayManage = canDo('ATTENDANCE_MANAGE');
  const [me, setMe] = useState<AuthUser | null>(null);
  const [tab, setTab] = useState<'today' | 'month'>('today');
  const [board, setBoard] = useState<AttendanceBoard | null>(null);
  const [period, setPeriod] = useState(thisMonth);
  const [month, setMonth] = useState<AttendanceMonth | null>(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [hours, setHours] = useState<WorkHours | null>(null);
  const [showHours, setShowHours] = useState(false);
  const [fixing, setFixing] = useState<FixTarget | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const ready = me !== null;
  const isAdmin = me?.role === 'ADMIN';
  // The API refuses correcting your own attendance unless you are the admin.
  const mayFix = (userId: string) => isAdmin || userId !== me?.id;

  const loadBoard = useCallback(async () => {
    try {
      setBoard(await api<AttendanceBoard>('/hr/attendance'));
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
      router.replace(leaveFor(user));
      return;
    }
    setMe(user);
  }, [router, mayManage]);

  useEffect(() => {
    if (!ready) return;
    void loadBoard();
    void loadHours();
  }, [ready, loadBoard, loadHours]);

  useEffect(() => {
    if (ready && tab === 'month') void loadMonth(period);
  }, [ready, tab, period, loadMonth]);

  async function punch(userId: string, kind: 'in' | 'out') {
    setBusyId(userId);
    setError('');
    try {
      await api(kind === 'in' ? '/hr/check-in' : '/hr/check-out', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      await loadBoard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Бүртгэж чадсангүй');
    } finally {
      setBusyId(null);
    }
  }

  function afterFix() {
    setFixing(null);
    void loadBoard();
    if (month) void loadMonth(period);
  }

  if (!me) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  const today = board?.date ?? ubDay(new Date());
  // Still checked in from an earlier day: the check-out was forgotten.
  const staleOpen = (board?.staff ?? []).filter((m) => m.open && ubDay(m.open.checkIn) < today);

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Хүний нөөц</p>
          <h2 className="text-xl font-bold">Ирц</h2>
          <p className="text-slate-400 text-sm mt-1">Менежер ажилтны ирэх, явах цагийг бүртгэнэ. Улаанбаатарын цагаар.</p>
          {hours && <p className="text-slate-500 text-xs mt-0.5">{hoursLine(hours)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && hours && (
            <button className="btn-ghost" onClick={() => setShowHours((v) => !v)}>
              Ажлын цаг
            </button>
          )}
          <button className="btn-ghost" onClick={() => void (tab === 'today' ? loadBoard() : loadMonth(period))}>
            Шинэчлэх
          </button>
        </div>
      </div>

      {isAdmin && showHours && hours && (
        <WorkHoursForm
          hours={hours}
          onSaved={(next) => {
            setHours(next);
            setShowHours(false);
          }}
        />
      )}

      <div className="mb-4 flex gap-2">
        {(
          [
            ['today', 'Өнөөдөр'],
            ['month', 'Сарын ирц'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 mb-3">{error}</p>}

      {tab === 'today' && (
        <>
          {staleOpen.length > 0 && (
            <p className="mb-3 rounded border border-amber-700 bg-amber-900/20 p-3 text-xs text-amber-200">
              {staleOpen.length} ажилтны өмнөх өдрийн гарсан цаг бүртгээгүй. Дахин «Ирсэн» дарвал тэр өдрийг ажлын төгсгөлийн цагаар хаана; зөв
              цагийг «засах»-аар оруулна уу.
            </p>
          )}
          <div className="card overflow-auto p-0 mb-6">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="text-left text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="p-3">Ажилтан</th>
                  <th>Албан тушаал</th>
                  <th>Төлөв</th>
                  <th>Ирсэн цаг</th>
                  <th className="pr-3 text-right">Үйлдэл</th>
                </tr>
              </thead>
              <tbody>
                {(board?.staff ?? []).map((member) => {
                  const stale = Boolean(member.open && ubDay(member.open.checkIn) < today);
                  return (
                    <tr key={member.id} className="border-t border-slate-800">
                      <td className="p-3">
                        <p className="font-medium">{member.fullName}</p>
                        <p className="text-xs text-slate-500">@{member.username}</p>
                      </td>
                      <td>{ROLE_LABEL[member.role]}</td>
                      <td>
                        {stale ? (
                          <>
                            <span className="text-amber-300 font-semibold">{AUTO_CLOSED}</span>
                            <p className="text-[11px] text-slate-500">Өмнөх өдрөөс нээлттэй</p>
                          </>
                        ) : member.open ? (
                          <span className="text-emerald-300 font-semibold">Ажил дээр · {ATTENDANCE_STATUS_LABEL[member.open.status] ?? member.open.status}</span>
                        ) : (
                          <span className="text-slate-500">Гарсан</span>
                        )}
                      </td>
                      <td>{fmt(member.open?.checkIn ?? null)}</td>
                      <td className="pr-3">
                        <div className="flex justify-end gap-1">
                          {stale && member.open && mayFix(member.id) && (
                            <button
                              className="btn-ghost text-xs px-3 py-1"
                              onClick={() => member.open && setFixing({ ...member.open, who: member.fullName })}
                            >
                              засах
                            </button>
                          )}
                          <button
                            className="btn-primary text-xs px-3 py-1"
                            disabled={(Boolean(member.open) && !stale) || busyId === member.id}
                            onClick={() => void punch(member.id, 'in')}
                          >
                            Ирсэн
                          </button>
                          <button
                            className="btn-ghost text-xs px-3 py-1"
                            disabled={!member.open || stale || busyId === member.id}
                            title={stale ? 'Өмнөх өдрийнх — гарсан цагийг «засах»-аар оруулна' : undefined}
                            onClick={() => void punch(member.id, 'out')}
                          >
                            Явсан
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h3 className="font-semibold mb-2">Өнөөдрийн бүртгэл</h3>
          <div className="card overflow-auto p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="p-3">Ажилтан</th>
                  <th>Ирсэн</th>
                  <th>Явсан</th>
                  <th>Төлөв</th>
                  <th className="pr-3" />
                </tr>
              </thead>
              <tbody>
                {(board?.recent ?? []).map((row) => (
                  <tr key={row.id} className="border-t border-slate-800">
                    <td className="p-3">{row.user?.fullName ?? row.userId}</td>
                    <td>{fmt(row.checkIn)}</td>
                    <td>{fmt(row.checkOut)}</td>
                    <td>{ATTENDANCE_STATUS_LABEL[row.status] ?? row.status}</td>
                    <td className="pr-3 text-right">
                      {mayFix(row.userId) && (
                        <button
                          className="btn-ghost text-xs px-2 py-0.5"
                          onClick={() => setFixing({ ...row, who: row.user?.fullName ?? row.userId })}
                        >
                          засах
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(board?.recent.length ?? 0) === 0 && <p className="p-3 text-slate-500">Өнөөдөр бүртгэл алга.</p>}
          </div>
        </>
      )}

      {tab === 'month' && (
        <MonthView
          period={period}
          onPeriod={setPeriod}
          data={month?.periodMonth === period ? month : null}
          loading={monthLoading}
          today={today}
          mayFix={mayFix}
          onFix={setFixing}
        />
      )}

      {fixing && <FixModal target={fixing} shiftEnd={hours?.shiftEnd} onClose={() => setFixing(null)} onSaved={afterFix} />}
    </Shell>
  );
}

/** One month per person; a click opens their records with a correction button on each. */
function MonthView(props: {
  period: string;
  onPeriod: (p: string) => void;
  data: AttendanceMonth | null;
  loading: boolean;
  today: string;
  mayFix: (userId: string) => boolean;
  onFix: (t: FixTarget) => void;
}) {
  const { data } = props;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <label className="text-xs text-slate-400">
          Сар
          <input type="month" className="mt-1 block" value={props.period} max={thisMonth()} onChange={(e) => e.target.value && props.onPeriod(e.target.value)} />
        </label>
        {data && <p className="pb-2 text-xs text-slate-400">Ажлын өдөр: {data.workingDays}</p>}
      </div>
      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-left text-xs text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Ажилтан</th>
              <th className="text-right">Ирсэн өдөр</th>
              <th className="text-right">Хоцорсон</th>
              <th className="text-right">Илүү цаг</th>
              <th className="pr-3 text-right">Нийт цаг</th>
            </tr>
          </thead>
          <tbody>
            {(data?.people ?? []).map((p) => (
              <PersonRows
                key={p.id}
                p={p}
                workingDays={data?.workingDays ?? 0}
                open={open === p.id}
                onToggle={() => setOpen(open === p.id ? null : p.id)}
                today={props.today}
                mayFix={props.mayFix(p.id)}
                onFix={(r) => props.onFix({ ...r, who: p.fullName })}
              />
            ))}
          </tbody>
        </table>
        {props.loading && <p className="p-3 text-sm text-slate-500">Уншиж байна…</p>}
        {!props.loading && data && data.people.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ сард бүртгэл алга.</p>}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Мөр дээр дарж өдөр бүрийн бүртгэлийг харна. Засвар шалтгаантайгаа засварын тайланд үлдэнэ; цалин олгосон сарыг засахгүй.
      </p>
    </>
  );
}

function PersonRows(props: {
  p: MonthPerson;
  workingDays: number;
  open: boolean;
  onToggle: () => void;
  today: string;
  mayFix: boolean;
  onFix: (r: MonthRecord) => void;
}) {
  const { p } = props;
  return (
    <>
      <tr className="border-t border-slate-800 hover:bg-steel-800 cursor-pointer" onClick={props.onToggle}>
        <td className="p-3">
          <p className="font-medium">
            {p.fullName}
            {!p.isActive && <span className="ml-1 text-[10px] text-slate-500">(ажлаас гарсан)</span>}
          </p>
          <p className="text-[11px] text-slate-500">{ROLE_LABEL[p.role]}</p>
          {p.unclosed.length > 0 && (
            <span className="mt-1 inline-block rounded-full border border-red-700 bg-red-900/70 px-2 py-0.5 text-[11px] text-red-200">
              {AUTO_CLOSED}: {p.unclosed.length}
            </span>
          )}
        </td>
        <td className="text-right whitespace-nowrap">
          {p.presentDays}/{props.workingDays}
        </td>
        <td className={`text-right ${p.lateDays ? 'text-amber-300' : 'text-slate-500'}`}>{p.lateDays || '—'}</td>
        <td className={`text-right ${p.overtimeDays ? 'text-sky-300' : 'text-slate-500'}`}>{p.overtimeDays || '—'}</td>
        <td className="pr-3 text-right whitespace-nowrap">{p.hours} ц</td>
      </tr>
      {props.open && (
        <tr className="border-t border-slate-800 bg-steel-900/60">
          <td colSpan={5} className="p-3">
            {p.records.length === 0 ? (
              <p className="text-xs text-slate-500">Энэ сард бүртгэл алга.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1">Огноо</th>
                    <th>Ирсэн</th>
                    <th>Гарсан</th>
                    <th>Төлөв</th>
                    <th>Тэмдэглэл</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {p.records.map((r) => {
                    const day = ubDay(r.checkIn);
                    const outDay = r.checkOut ? ubDay(r.checkOut) : null;
                    return (
                      <tr key={r.id} className="border-t border-slate-800">
                        <td className="py-1.5 whitespace-nowrap font-mono">
                          {day} <span className="text-slate-500">{weekday(day)}</span>
                        </td>
                        <td className="font-mono">{ubTime(r.checkIn)}</td>
                        <td className="font-mono whitespace-nowrap">
                          {r.checkOut ? (
                            `${outDay !== day ? `${outDay?.slice(5)} ` : ''}${ubTime(r.checkOut)}`
                          ) : day < props.today ? (
                            <span className="font-sans text-red-300">бүртгээгүй</span>
                          ) : (
                            <span className="font-sans text-emerald-300">ажил дээр</span>
                          )}
                        </td>
                        <td className={STATUS_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status] ?? r.status}</td>
                        <td className={r.notes?.includes(AUTO_CLOSED) ? 'text-amber-300' : 'text-slate-500'}>{r.notes || '—'}</td>
                        <td className="text-right">
                          {props.mayFix && (
                            <button className="btn-ghost text-xs px-2 py-0.5" onClick={() => props.onFix(r)}>
                              засах
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Correct a check-in/out (forgotten check-out, button pressed late). Inputs are Ulaanbaatar time; only the
 * changed times are sent. A forgotten check-out of an earlier day starts at the end of the shift.
 */
function FixModal(props: { target: FixTarget; shiftEnd?: string; onClose: () => void; onSaved: () => void }) {
  const t = props.target;
  const day = ubDay(t.checkIn);
  const forgot = !t.checkOut && day < ubDay(new Date());
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <form onSubmit={save} className="card w-full max-w-md space-y-3">
        <div>
          <h3 className="font-semibold text-lg">Ирц засах</h3>
          <p className="text-xs text-slate-400">
            {t.who} · {day} {weekday(day)} · Улаанбаатарын цагаар
          </p>
          {t.notes && <p className={`mt-1 text-[11px] ${t.notes.includes(AUTO_CLOSED) ? 'text-amber-300' : 'text-slate-500'}`}>{t.notes}</p>}
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={atWork} onChange={(e) => setAtWork(e.target.checked)} />
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

/** Admin: the working day that decides late and overtime. */
function WorkHoursForm({ hours, onSaved }: { hours: WorkHours; onSaved: (next: WorkHours) => void }) {
  const [form, setForm] = useState(hours);
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    if (form.shiftEnd <= form.shiftStart) return setMsg('Ажлын төгсгөл эхлэлээс хойш байна');
    try {
      onSaved(await api<WorkHours>('/hr/attendance/settings', { method: 'PUT', body: JSON.stringify(form) }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    }
  }
  return (
    <form onSubmit={save} className="card mb-4 grid gap-3 sm:grid-cols-4">
      <p className="sm:col-span-4 font-semibold">Ажлын цаг</p>
      <label className="text-xs text-slate-400">
        Эхлэх
        <input type="time" className="mt-1 block w-full" required value={form.shiftStart} onChange={(e) => setForm({ ...form, shiftStart: e.target.value })} />
      </label>
      <label className="text-xs text-slate-400">
        Хүлцэл, мин (хоцролт биш)
        <input
          type="number"
          className="mt-1 block w-full"
          min={0}
          max={180}
          required
          value={form.graceMinutes}
          onChange={(e) => setForm({ ...form, graceMinutes: Math.round(Number(e.target.value)) })}
        />
      </label>
      <label className="text-xs text-slate-400">
        Дуусах
        <input type="time" className="mt-1 block w-full" required value={form.shiftEnd} onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })} />
      </label>
      <label className="text-xs text-slate-400">
        Илүү цаг — хэдэн цагаас дээш
        <input
          type="number"
          className="mt-1 block w-full"
          min={1}
          max={24}
          step="0.5"
          required
          value={form.overtimeAfterHours}
          onChange={(e) => setForm({ ...form, overtimeAfterHours: Number(e.target.value) })}
        />
      </label>
      <div className="sm:col-span-4 flex items-center gap-3">
        <button className="btn-primary text-sm">Хадгалах</button>
        {msg && <span className="text-xs text-red-400">{msg}</span>}
      </div>
    </form>
  );
}
