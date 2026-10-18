'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

type Edit = {
  id: string;
  at: string;
  entityType: string;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  actor: string;
  actorRole: string;
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
const monthAgo = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(Date.now() - 30 * 86_400_000));

/** What kind of thing changed. */
const TYPE_LABEL: Record<string, string> = {
  RECEIPT_ITEM: 'Худалдан авсан үнэ',
  ACCOUNT_ENTRY: 'Харилцагчийн тооцоо',
  PRODUCT_PRICE: 'Барааны үнэ',
  PRICE_LIST_PRICE: 'Үнийн жагсаалт',
  SALARY: 'Цалин',
  USER: 'Хэрэглэгч, эрх',
  SETTINGS: 'Тохиргоо',
  DOC_TEMPLATE: 'Баримтын загвар',
  MODULE: 'Модуль',
  WAREHOUSE: 'Дэлгүүр / агуулах',
  USER_PERMISSIONS: 'Хүний эрх',
  ATTENDANCE: 'Ирц',
  RECEIPT_PARTNER: 'Орлогын нийлүүлэгч',
};

const hm = (v: unknown) =>
  typeof v === 'string' ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : '—';

const MONEY_KEYS = ['unitCostMnt', 'amountMnt', 'priceMnt'];

/** Money changes as "old → new"; other changes are described in the summary. */
function change(e: Edit) {
  // Attendance corrections: old and new times.
  if ('checkIn' in e.before || 'checkIn' in e.after) {
    return `${hm(e.before.checkIn)}–${hm(e.before.checkOut)} → ${hm(e.after.checkIn)}–${hm(e.after.checkOut)}`;
  }
  const key = MONEY_KEYS.find((k) => k in e.before || k in e.after);
  if (!key) return '';
  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : tugrik(Number(v)));
  const desc = e.before.description !== e.after.description && e.after.description ? ` · «${String(e.after.description)}»` : '';
  return `${fmt(e.before[key])} → ${fmt(e.after[key])}${desc}`;
}

/** Admin: every later change to purchase prices and partner account lines — who, when, what, why. */
export default function EditsReportPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [startDate, setStartDate] = useState(monthAgo());
  const [endDate, setEndDate] = useState(today());
  const [edits, setEdits] = useState<Edit[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const res = await api<{ edits: Edit[] }>(`/reports/edits?startDate=${startDate}&endDate=${endDate}`);
      setEdits(res.edits);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [startDate, endDate]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (!hasRole(me.role, TOP_ROLES)) {
      router.replace(homeForRole(me.role));
      return;
    }
    setReady(true);
  }, [router]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  return (
    <Shell>
      <ReportsNav />
      <div className="mb-4">
        <h2 className="text-xl font-bold">Засварын түүх</h2>
        <p className="text-slate-400 text-sm mt-1">Үнэ, тооцоо, цалин, эрх, тохиргоо, баримтын загварыг дараа нь өөрчилсөн бүх тохиолдол.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        <label className="text-xs text-slate-400">
          Эхлэх
          <input type="date" className="mt-1 block" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Дуусах
          <input type="date" className="mt-1 block" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>
      {error && <p className="text-red-400 mb-3">{error}</p>}
      <div className="card p-0 overflow-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="text-left text-xs text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-2">Хэзээ</th>
              <th>Хэн</th>
              <th>Төрөл</th>
              <th>Юу</th>
              <th>Өөрчлөлт</th>
              <th className="pr-2">Шалтгаан</th>
            </tr>
          </thead>
          <tbody>
            {edits.map((e) => (
              <tr key={e.id} className="border-t border-slate-800 align-top">
                <td className="p-2 text-xs text-slate-300 whitespace-nowrap">{new Date(e.at).toLocaleString('mn-MN')}</td>
                <td className="text-xs">{e.actor}</td>
                <td className="text-xs text-slate-400 whitespace-nowrap">{TYPE_LABEL[e.entityType] ?? e.entityType}</td>
                <td className="text-xs">{e.summary}</td>
                <td className="text-xs font-semibold whitespace-nowrap">{change(e)}</td>
                <td className="text-xs pr-2">{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {edits.length === 0 && <p className="p-3 text-slate-500 text-sm">Энэ хугацаанд засвар алга.</p>}
      </div>
    </Shell>
  );
}
