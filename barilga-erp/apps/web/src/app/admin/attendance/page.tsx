'use client';

import { isManager } from '@/lib/rbac';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { AttendanceBoard, AuthUser, ROLE_LABEL } from '@/lib/types';

const ATTENDANCE_STATUS_LABEL: Record<string, string> = { ON_TIME: 'Цагтаа', LATE: 'Хоцорсон', OVERTIME: 'Илүү цаг' };

function fmt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar' });
}

export default function AttendanceAdminPage() {
  const router = useRouter();
  const [board, setBoard] = useState<AttendanceBoard | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await api<AttendanceBoard>('/hr/attendance'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ирц ачаалж чадсангүй');
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const role = raw ? (JSON.parse(raw) as AuthUser).role : null;
    if (!isManager(role)) {
      router.replace(role === 'ACHIGCH_BELTGEGCH' ? '/warehouse/tickets' : '/pos');
      return;
    }
    setAllowed(true);
    void load();
  }, [load, router]);

  async function punch(userId: string, kind: 'in' | 'out') {
    setBusyId(userId);
    setError('');
    try {
      await api(kind === 'in' ? '/hr/check-in' : '/hr/check-out', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Бүртгэж чадсангүй');
    } finally {
      setBusyId(null);
    }
  }

  if (!allowed) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Хүний нөөц</p>
          <h2 className="text-xl font-bold">Ирц</h2>
          <p className="text-slate-400 text-sm mt-1">
            Менежер ажилтны ирэх, явах цагийг бүртгэнэ. Улаанбаатарын цагаар · 09:15-аас хойш ирвэл хоцролт.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()}>
          Шинэчлэх
        </button>
      </div>
      {error && <p className="text-red-400 mb-3">{error}</p>}
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
            {(board?.staff ?? []).map((member) => (
              <tr key={member.id} className="border-t border-slate-800">
                <td className="p-3">
                  <p className="font-medium">{member.fullName}</p>
                  <p className="text-xs text-slate-500">@{member.username}</p>
                </td>
                <td>{ROLE_LABEL[member.role]}</td>
                <td>
                  {member.open ? (
                    <span className="text-emerald-300 font-semibold">Ажил дээр · {ATTENDANCE_STATUS_LABEL[member.open.status] ?? member.open.status}</span>
                  ) : (
                    <span className="text-slate-500">Гарсан</span>
                  )}
                </td>
                <td>{fmt(member.open?.checkIn ?? null)}</td>
                <td className="pr-3">
                  <div className="flex justify-end gap-1">
                    <button
                      className="btn-primary text-xs px-3 py-1"
                      disabled={Boolean(member.open) || busyId === member.id}
                      onClick={() => void punch(member.id, 'in')}
                    >
                      Ирсэн
                    </button>
                    <button
                      className="btn-ghost text-xs px-3 py-1"
                      disabled={!member.open || busyId === member.id}
                      onClick={() => void punch(member.id, 'out')}
                    >
                      Явсан
                    </button>
                  </div>
                </td>
              </tr>
            ))}
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
            </tr>
          </thead>
          <tbody>
            {(board?.recent ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-800">
                <td className="p-3">{row.user?.fullName ?? row.userId}</td>
                <td>{fmt(row.checkIn)}</td>
                <td>{fmt(row.checkOut)}</td>
                <td>{ATTENDANCE_STATUS_LABEL[row.status] ?? row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(board?.recent.length ?? 0) === 0 && <p className="p-3 text-slate-500">Өнөөдөр бүртгэл алга.</p>}
      </div>
    </Shell>
  );
}
