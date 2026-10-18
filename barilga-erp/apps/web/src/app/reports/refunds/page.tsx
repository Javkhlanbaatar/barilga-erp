'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

type Payout = {
  id: string;
  refundAmount: number;
  refundMethod: string;
  refundStatus: 'PENDING_PAYOUT' | 'PAID_OUT';
  refundAccount: string | null;
  reason: string;
  createdAt: string;
  paidOutAt: string | null;
  createdBy: { fullName: string } | null;
  order: { id: string; orderNumber: string; customerName: string; customerPhone: string };
};
type Feed = { pending: Payout[]; sent: Payout[]; pendingMnt: number };

const METHOD: Record<string, string> = { TRANSFER: 'Банкны шилжүүлэг', CARD: 'Карт', QPAY: 'QPay', CASH: 'Бэлэн' };
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

/**
 * Буцаах мөнгө: returns whose money still has to go back to the customer. Send it from the bank app to the
 * account shown, then press «Шилжүүлсэн» so it is recorded who sent it and when.
 */
export default function RefundPayoutsPage() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const me = raw ? (JSON.parse(raw) as AuthUser) : null;
    if (!hasRole(me?.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(me?.role));
      return;
    }
    setOk(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      setError('');
      setFeed(await api<Feed>('/orders/returns/payouts'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, []);

  useEffect(() => {
    if (ok) void load();
  }, [ok, load]);

  async function sent(p: Payout) {
    if (!window.confirm(`${p.order.customerName}-д ${tugrik(p.refundAmount)} шилжүүлсэн үү?`)) return;
    try {
      await api(`/orders/returns/${p.id}/paid-out`, { method: 'POST', body: '{}' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    }
  }

  async function copy(p: Payout) {
    const text = `${p.refundAccount ?? ''} — ${p.refundAmount}₮ — ${p.order.orderNumber} буцаалт`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(p.id);
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      window.prompt('Хуулна уу:', text);
    }
  }

  return (
    <Shell>
      <ReportsNav />
      <div className="mb-4">
        <h2 className="text-xl font-bold">Буцаах мөнгө</h2>
        <p className="text-sm text-slate-400">
          Банкны апп-аар доорх данс руу мөнгийг шилжүүлээд «Шилжүүлсэн» дарна. Гүйлгээний утгад захиалгын дугаарыг бичнэ.
        </p>
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <article className="card">
          <p className="text-xs text-slate-400">Шилжүүлэх ёстой</p>
          <p className="text-xl font-bold text-amber-brand">{tugrik(feed?.pendingMnt ?? 0)}</p>
          <p className="text-xs text-slate-500">{feed?.pending.length ?? 0} буцаалт</p>
        </article>
        <article className="card">
          <p className="text-xs text-slate-400">Сүүлийн 30 хоногт шилжүүлсэн</p>
          <p className="text-xl font-bold text-emerald-300">{tugrik((feed?.sent ?? []).reduce((s, r) => s + r.refundAmount, 0))}</p>
        </article>
      </div>

      <div className="card mb-6 overflow-auto p-0">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
            <tr>
              <th className="p-3">Захиалга / харилцагч</th>
              <th>Хэлбэр</th>
              <th>Хүлээн авах данс</th>
              <th className="text-right">Дүн</th>
              <th>Бүртгэсэн</th>
              <th className="pr-3 text-right" />
            </tr>
          </thead>
          <tbody>
            {(feed?.pending ?? []).map((p) => (
              <tr key={p.id} className="border-t border-slate-800 align-top">
                <td className="p-3">
                  <Link className="font-mono text-amber-brand hover:underline" href={`/orders/${p.order.id}`}>
                    {p.order.orderNumber}
                  </Link>
                  <p className="text-xs text-slate-400">
                    {p.order.customerName} · {p.order.customerPhone}
                  </p>
                  <p className="text-[11px] text-slate-500">{p.reason}</p>
                </td>
                <td className="text-xs">{METHOD[p.refundMethod] ?? p.refundMethod}</td>
                <td className="text-xs">
                  {p.refundAccount ??
                    (p.refundMethod === 'CASH' ? (
                      <span className="text-slate-400">кассаас бэлнээр (хуучин бүртгэл — өгсөн бол «Шилжүүлсэн» дарна)</span>
                    ) : (
                      <span className="text-amber-300">данс бичээгүй — харилцагчаас асууна</span>
                    ))}
                </td>
                <td className="text-right font-semibold">{tugrik(p.refundAmount)}</td>
                <td className="text-xs text-slate-400">
                  {when(p.createdAt)}
                  <br />
                  {p.createdBy?.fullName ?? ''}
                </td>
                <td className="pr-3 text-right">
                  <div className="flex justify-end gap-1">
                    {p.refundAccount && (
                      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void copy(p)}>
                        {copied === p.id ? 'Хуулсан ✓' : 'Хуулах'}
                      </button>
                    )}
                    <button className="btn-primary px-2 py-1 text-xs" onClick={() => void sent(p)}>
                      Шилжүүлсэн
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {feed && feed.pending.length === 0 && <p className="p-3 text-sm text-slate-500">Шилжүүлэх буцаалт алга ✓</p>}
      </div>

      {(feed?.sent.length ?? 0) > 0 && (
        <>
          <h3 className="mb-2 font-semibold">Шилжүүлсэн (30 хоног)</h3>
          <div className="card overflow-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <tbody>
                {feed!.sent.map((p) => (
                  <tr key={p.id} className="border-t border-slate-800">
                    <td className="p-3 font-mono text-xs">
                      <Link className="hover:underline" href={`/orders/${p.order.id}`}>
                        {p.order.orderNumber}
                      </Link>
                    </td>
                    <td className="text-xs">{p.order.customerName}</td>
                    <td className="text-xs text-slate-400">{p.refundAccount ?? METHOD[p.refundMethod]}</td>
                    <td className="text-right">{tugrik(p.refundAmount)}</td>
                    <td className="pr-3 text-right text-xs text-emerald-300">✓ {when(p.paidOutAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}
