'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReportsNav } from '@/components/reports-nav';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { hasRole, homeForRole, OVERSIGHT_ROLES } from '@/lib/rbac';
import { AuthUser } from '@/lib/types';

type Bucket = { key: string; count: number; amountMnt: number };
type Report = {
  totals: { count: number; amountMnt: number; pendingMnt: number };
  byMethod: Bucket[];
  byReason: Bucket[];
  byPerson: Bucket[];
  byProduct: Array<{ key: string; sku: string; nameMn: string; unit: string; quantity: number; amountMnt: number }>;
  returns: Array<{
    id: string;
    at: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
    warehouse: string | null;
    reason: string;
    refundAmount: number;
    refundMethod: string;
    refundStatus: string;
    refundAccount: string | null;
    by: string;
    items: Array<{ nameMn: string; sku: string; quantity: number; lineRefund: number }>;
  }>;
};

const METHOD: Record<string, string> = { CASH: 'Бэлэн', CARD: 'Карт', TRANSFER: 'Шилжүүлэг', QPAY: 'QPay', CREDIT: 'Өрөөс хассан' };
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
const when = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Буцаалтын тайлан: what came back, why, how much money went back and how, and what is still to pay out. */
export default function ReturnsReportPage() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => ymd(new Date()));
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

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
      setReport(await api<Report>(`/reports/returns?startDate=${from}&endDate=${to}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [from, to]);

  useEffect(() => {
    if (ok) void load();
  }, [ok, load]);

  function csv() {
    if (!report) return;
    const head = ['Огноо', 'Захиалга', 'Харилцагч', 'Бараа', 'Шалтгаан', 'Дүн', 'Хэлбэр', 'Төлөв', 'Хэн'];
    const rows = report.returns.map((r) => [
      when(r.at),
      r.orderNumber,
      r.customerName,
      r.items.map((i) => `${i.nameMn} × ${i.quantity}`).join('; '),
      r.reason,
      r.refundAmount,
      METHOD[r.refundMethod] ?? r.refundMethod,
      r.refundMethod === 'CREDIT' ? '' : r.refundStatus === 'PAID_OUT' ? 'Буцаасан' : 'Хүлээгдэж буй',
      r.by,
    ]);
    const text = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `butsaalt-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <ReportsNav />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Буцаалт</h2>
          <p className="text-sm text-slate-400">Буцаасан бараа, шалтгаан, буцаасан мөнгө ба хэлбэр, хэн хийсэн.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-400">
            Эхлэх
            <input type="date" className="mt-1 block" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">
            Дуусах
            <input type="date" className="mt-1 block" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="btn-ghost text-sm" onClick={csv} disabled={!report}>
            Excel (CSV)
          </button>
        </div>
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {report && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <article className="card">
              <p className="text-xs text-slate-400">Буцаалт</p>
              <p className="break-words text-lg font-bold sm:text-xl">{report.totals.count}</p>
            </article>
            <article className="card">
              <p className="text-xs text-slate-400">Буцаасан нийт дүн</p>
              <p className="break-words text-lg font-bold sm:text-xl text-amber-brand">{tugrik(report.totals.amountMnt)}</p>
            </article>
            <article className="card">
              <p className="text-xs text-slate-400">Хараахан буцааж өгөөгүй</p>
              <p className="break-words text-lg font-bold sm:text-xl text-red-300">{tugrik(report.totals.pendingMnt)}</p>
              {report.totals.pendingMnt > 0 && (
                <Link className="text-xs text-amber-brand hover:underline" href="/reports/refunds">
                  Шилжүүлэх жагсаалт →
                </Link>
              )}
            </article>
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <Summary title="Хэлбэрээр" rows={report.byMethod.map((b) => ({ ...b, label: METHOD[b.key] ?? b.key }))} />
            <Summary title="Шалтгаанаар" rows={report.byReason.slice(0, 8).map((b) => ({ ...b, label: b.key }))} />
            <Summary title="Хэн бүртгэсэн" rows={report.byPerson.slice(0, 8).map((b) => ({ ...b, label: b.key }))} />
          </div>

          {report.byProduct.length > 0 && (
            <div className="card mb-4 overflow-auto p-0">
              <p className="border-b border-slate-800 p-3 text-sm font-semibold">Хамгийн их буцаагдсан бараа</p>
              <table className="w-full text-sm">
                <tbody>
                  {report.byProduct.slice(0, 10).map((p) => (
                    <tr key={p.key} className="border-t border-slate-800">
                      <td className="p-2">
                        {p.nameMn} <span className="font-mono text-[11px] text-slate-500">{p.sku}</span>
                      </td>
                      <td className="text-right">
                        {p.quantity} {p.unit}
                      </td>
                      <td className="pr-3 text-right">{tugrik(p.amountMnt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card overflow-auto p-0">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-slate-700 text-left text-xs text-slate-400">
                <tr>
                  <th className="p-3">Огноо</th>
                  <th>Захиалга</th>
                  <th>Бараа</th>
                  <th>Шалтгаан</th>
                  <th className="text-right">Дүн</th>
                  <th>Хэлбэр</th>
                  <th className="pr-3">Хэн</th>
                </tr>
              </thead>
              <tbody>
                {report.returns.map((r) => (
                  <tr key={r.id} className="border-t border-slate-800 align-top">
                    <td className="p-3 text-xs whitespace-nowrap">{when(r.at)}</td>
                    <td className="text-xs">
                      <Link className="font-mono text-amber-brand hover:underline" href={`/orders/${r.orderId}`}>
                        {r.orderNumber}
                      </Link>
                      <p className="text-slate-400">{r.customerName}</p>
                      {r.warehouse && <p className="text-slate-500">{r.warehouse}</p>}
                    </td>
                    <td className="text-xs">
                      {r.items.map((i, idx) => (
                        <p key={idx}>
                          {i.nameMn} × {i.quantity}
                        </p>
                      ))}
                    </td>
                    <td className="text-xs">{r.reason}</td>
                    <td className="text-right font-semibold">{tugrik(r.refundAmount)}</td>
                    <td className="text-xs">
                      {METHOD[r.refundMethod] ?? r.refundMethod}
                      {r.refundMethod !== 'CREDIT' && (
                        <p className={r.refundStatus === 'PAID_OUT' ? 'text-emerald-300' : 'text-amber-300'}>
                          {r.refundStatus === 'PAID_OUT' ? '✓ буцаасан' : '⏳ хүлээгдэж буй'}
                        </p>
                      )}
                    </td>
                    <td className="pr-3 text-xs">{r.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.returns.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд буцаалт алга.</p>}
          </div>
        </>
      )}
    </Shell>
  );
}

function Summary({ title, rows }: { title: string; rows: Array<Bucket & { label: string }> }) {
  return (
    <article className="card space-y-1">
      <p className="text-sm font-semibold">{title}</p>
      {rows.length === 0 && <p className="text-xs text-slate-500">—</p>}
      {rows.map((r) => (
        <p key={r.key} className="flex justify-between gap-2 text-xs">
          <span className="truncate">
            {r.label} <span className="text-slate-500">({r.count})</span>
          </span>
          <span className="font-semibold">{tugrik(r.amountMnt)}</span>
        </p>
      ))}
    </article>
  );
}
