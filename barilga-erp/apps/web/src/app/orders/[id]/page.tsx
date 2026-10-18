'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { CreditPanel, owedOnOrder } from '@/components/credit-panel';
import { GatherPanel } from '@/components/gather-panel';
import { InvoicePanel } from '@/components/invoice-panel';
import { Shell } from '@/components/shell';
import { api, orderTrackingUrl, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { AuthUser, DELIVERY_LABEL, ORDER_STATUS_LABEL, companionLines, ebarimtStatusLabel, isHiredTransport, Order, PaymentSplit, VEHICLE_LABEL } from '@/lib/types';
import { POS_ROLES, TRANSPORT_ROLES, hasRole, isManager } from '@/lib/rbac';

function channel(p: PaymentSplit) {
  return p.method ?? p.provider ?? 'QPAY';
}

const PAY_LABEL: Record<string, string> = {
  QPAY: 'QPay',
  CASH: 'Бэлэн',
  CARD: 'Карт',
  TRANSFER: 'Шилжүүлэг',
  CREDIT: 'Дараа төлөх',
  OFFSET: 'Тооцоонд хасагдсан',
};
const PAY_STATUS: Record<string, string> = { PAID: 'төлөгдсөн', UNPAID: 'хүлээгдэж буй', EXPIRED: 'хүчингүй', FAILED: 'амжилтгүй' };

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [reason, setReason] = useState('Харилцагчийн хөнгөлөлт');
  const [delivery, setDelivery] = useState(0);
  const [unloading, setUnloading] = useState(0);
  const [timeAdj, setTimeAdj] = useState(0);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<'CASH' | 'QPAY' | 'CARD' | 'TRANSFER' | 'CREDIT'>('CASH');
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [assignItemId, setAssignItemId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [supplierReason, setSupplierReason] = useState('');
  const features = useFeatures();
  const canDispatch = isManager(user?.role);
  const canTransport = hasRole(user?.role, TRANSPORT_ROLES);
  const canOverrideFees = user?.role === 'BORLUULAGCH';
  // The mock "mark paid" button exists only for local development: it is compiled out of production
  // builds and additionally depends on the server saying simulation is enabled (dev + QPay mock).
  const [simulateEnabled, setSimulateEnabled] = useState(false);
  const canSimulatePaid =
    process.env.NODE_ENV !== 'production' && simulateEnabled && isManager(user?.role);
  const canCancelRole = hasRole(user?.role, POS_ROLES);
  const isCashier = user?.role === 'BORLUULAGCH';

  async function load() {
    const o = await api<Order>(`/orders/${params.id}`);
    setOrder(o);
    setDelivery(o.deliveryFeeMnt);
    setUnloading(o.unloadingFeeMnt);
    setTimeAdj(o.timeAdjustmentMnt);
    setVehicleNumber(o.vehicleNumber ?? '');
    setDriverPhone(o.driverPhone ?? '');
  }

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (raw) setUser(JSON.parse(raw) as AuthUser);
    api<{ simulateEnabled: boolean }>('/payments/config')
      .then((c) => setSimulateEnabled(Boolean(c.simulateEnabled)))
      .catch(() => setSimulateEnabled(false));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const returnedByItem = useMemo(() => {
    const map: Record<string, number> = {};
    for (const ret of order?.returns ?? []) {
      for (const line of ret.items) {
        map[line.orderItemId] = (map[line.orderItemId] ?? 0) + Number(line.quantity);
      }
    }
    return map;
  }, [order]);

  if (!order) return <Shell>Уншиж байна…</Shell>;

  const splits = order.payments?.length ? order.payments : order.payment ? [order.payment] : [];
  const qpaySplits = splits.filter((p) => channel(p) === 'QPAY');
  const hasPaidSplit = splits.some((p) => p.status === 'PAID');
  const canCancel = canCancelRole && order.status === 'PENDING_PAYMENT' && !hasPaidSplit;
  // Fees can only change before any money is received; the server re-issues the QPay invoice.
  // Only delivery/unloading/time fees exist, so there is nothing to edit while delivery is switched off.
  const canEditFees = canOverrideFees && order.status === 'PENDING_PAYMENT' && !hasPaidSplit && features.enabled('DELIVERY');
  // A waiting QPay invoice or awaited transfer that the customer settled another way at the till.
  const waitingMnt =
    order.status === 'PENDING_PAYMENT'
      ? (order.payments ?? []).filter((p) => p.status === 'UNPAID' && (p.method === 'QPAY' || p.method === 'TRANSFER')).reduce((s, p) => s + p.amountMnt, 0)
      : 0;
  const canTakePayment = hasRole(user?.role, POS_ROLES);
  const canReturn =
    hasRole(user?.role, POS_ROLES) &&
    (order.status === 'COMPLETED' || order.status === 'READY_FOR_LOADING');

  function openReturn() {
    if (!order) return;
    const next: Record<string, number> = {};
    for (const item of order.items) next[item.id] = 0;
    setReturnQty(next);
    setReturnReason('');
    // While goods are still owed for, a return lowers the debt (no money is handed back).
    setRefundMethod(order && owedOnOrder(order) > 0 ? 'CREDIT' : 'CASH');
    setReturnOpen(true);
  }

  async function submitReturn(e: FormEvent) {
    e.preventDefault();
    if (!order) return;
    const items = Object.entries(returnQty)
      .filter(([, qty]) => qty > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (!items.length) {
      setError('Буцаах тоо хэмжээгээ оруулна уу');
      setToast('Буцаах тоо хэмжээгээ оруулна уу');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api(`/orders/${order.id}/return`, {
        method: 'POST',
        body: JSON.stringify({ reason: returnReason, refundMethod, items }),
      });
      setReturnOpen(false);
      setToast('Буцаалт бүртгэгдлээ — мөнгийг систем автоматаар олгохгүй');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Буцаалт хийж чадсангүй';
      setError(message);
      setToast(message);
    } finally {
      setSaving(false);
    }
  }

  async function override() {
    if (!order) return;
    setError('');
    try {
      await api(`/orders/${order.id}/override-fees`, {
        method: 'POST',
        body: JSON.stringify({
          deliveryFeeMnt: delivery,
          unloadingFeeMnt: unloading,
          timeAdjustmentMnt: timeAdj,
          reason,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Засварыг хадгалж чадсангүй');
    }
  }

  async function simulatePaid() {
    if (!order) return;
    setError('');
    try {
      await api(`/payments/${order.id}/simulate-paid`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Туршилтын төлбөр амжилтгүй');
    }
  }

  async function cancelOrder() {
    if (!order) return;
    if (!window.confirm('Төлбөр хийгдээгүй энэ захиалгыг цуцлах уу?')) return;
    setError('');
    try {
      await api(`/orders/${order.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      setToast('Захиалга цуцлагдлаа');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Цуцалж чадсангүй';
      setError(message);
      setToast(message);
    }
  }

  async function saveTransport() {
    if (!order) return;
    setError('');
    try {
      await api(`/orders/${order.id}/assign-transport`, {
        method: 'PATCH',
        body: JSON.stringify({ vehicleNumber, driverPhone }),
      });
      setToast('Хөлсний тээвэр хадгалагдлаа');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Оноож чадсангүй';
      setError(message);
      setToast(message);
    }
  }

  async function assignSupplier(e: FormEvent) {
    e.preventDefault();
    if (!order || !assignItemId) return;
    setSaving(true);
    setError('');
    try {
      await api(`/orders/${order.id}/items/${assignItemId}/assign-supplier`, {
        method: 'PATCH',
        body: JSON.stringify({ supplierName, reason: supplierReason || undefined }),
      });
      setAssignItemId(null);
      setToast('Гадны нийлүүлэгч оноогдож, үлдэгдэл тохирууллаа');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Оноож чадсангүй';
      setError(message);
      setToast(message);
    } finally {
      setSaving(false);
    }
  }

  async function retryEbarimt() {
    if (!order) return;
    setError('');
    try {
      await api(`/orders/${order.id}/ebarimt`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'И-баримт олгож чадсангүй');
    }
  }

  return (
    <Shell>
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-amber-brand text-xs">{ORDER_STATUS_LABEL[order.status] ?? order.status}</p>
          <h2 className="text-2xl font-bold">{order.orderNumber}</h2>
          <p className="text-slate-400">
            {order.customerName} · {order.customerPhone}
            {features.enabled('DELIVERY') ? ` · ${order.zone?.nameMn ?? ''} · ${DELIVERY_LABEL[order.deliveryMethod] ?? order.deliveryMethod}` : ''}
            {order.warehouse ? ` · ${order.warehouse.name}` : ''}
          </p>
          {(order.preparedBy || order.completedBy) && (
            <p className="text-sm mt-1">
              Бэлтгэсэн ажилтан:{' '}
              <span className="font-semibold text-amber-brand">
                {order.preparedBy?.fullName ?? order.completedBy?.fullName ?? order.completedBy?.name}
              </span>
            </p>
          )}
          {features.enabled('DELIVERY') && (
          <p className="text-sm text-slate-400">
            Хэмжээний ангилал:{' '}
            <span className="font-medium text-slate-200">
              {order.assignedVehicle ? VEHICLE_LABEL[order.assignedVehicle] ?? order.assignedVehicle : '—'}
            </span>
            <span className="text-slate-500"> (даацын ангилал, хөлсний машины дугаар биш)</span>
          </p>
          )}
          {features.enabled('DELIVERY') && isHiredTransport(order.deliveryMethod) && (
            <p className="text-sm">
              Хөлсний машины дугаар:{' '}
              <span className="font-semibold">{order.vehicleNumber ?? '—'}</span>
              {order.driverPhone ? ` · ${order.driverPhone}` : ''}
            </p>
          )}
          {features.enabled('DELIVERY') && order.trackingToken && (
            <p className="text-sm text-slate-400 mt-1">
              Хяналтын холбоос:{' '}
              <button
                type="button"
                className="text-amber-brand hover:underline"
                onClick={() => {
                  const url = orderTrackingUrl(order.trackingToken);
                  if (url) void navigator.clipboard.writeText(url);
                }}
              >
                {orderTrackingUrl(order.trackingToken) || `/track/${order.trackingToken}`}
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="text-2xl font-bold text-amber-brand">{tugrik(order.totalMnt)}</p>
          <div className="flex gap-1">
            {[
              ['invoice', 'Нэхэмжлэх'],
              ['receipt', 'Баримт'],
              ['issueNote', 'Зарлагын баримт'],
              ['picklist', 'Бэлтгэх хуудас'],
            ].map(([doc, label]) => (
              <a
                key={doc}
                className="btn-ghost text-xs px-2 py-1"
                href={`/print/orders/${order.id}?doc=${doc}`}
                target="_blank"
                rel="noreferrer"
              >
                🖨 {label}
              </a>
            ))}
          </div>
          {canReturn && (
            <button className="btn-ghost text-sm" onClick={openReturn}>
              Буцаалт
            </button>
          )}
          {canCancel && (
            <button className="btn-danger text-sm" onClick={cancelOrder}>
              Захиалга цуцлах
            </button>
          )}
          {canTakePayment && (
            <a href="/pos" className="btn-primary text-sm">
              + Шинэ борлуулалт
            </a>
          )}
        </div>
      </div>
      {canTakePayment && waitingMnt > 0 && (
        <div className="card mb-6 flex flex-wrap items-center justify-between gap-2 border-amber-700/60">
          <p className="text-sm">
            Хүлээгдэж буй төлбөр: <b>{tugrik(waitingMnt)}</b>. Харилцагч өөр хэлбэрээр төлсөн бол:
          </p>
          <div className="flex gap-2">
            {(['CASH', 'CARD', 'TRANSFER'] as const).map((m) => (
              <button
                key={m}
                className="btn-ghost text-sm"
                onClick={async () => {
                  if (!window.confirm(`${tugrik(waitingMnt)}-ийг ${PAY_LABEL[m]}-ээр авсан уу? QPay нэхэмжлэх хүчингүй болно.`)) return;
                  try {
                    setOrder(await api<Order>(`/orders/${order.id}/pay-remaining`, { method: 'POST', body: JSON.stringify({ method: m }) }));
                  } catch (err) {
                    window.alert(err instanceof Error ? err.message : 'Алдаа');
                  }
                }}
              >
                {PAY_LABEL[m]}-ээр авсан
              </button>
            ))}
          </div>
        </div>
      )}
      {canDispatch && order.status === 'READY_FOR_LOADING' && features.enabled('STOCK_TRANSFERS') && (
        <GatherPanel orderId={order.id} />
      )}
      {features.enabled('CREDIT_SALES') && order.status !== 'CANCELLED' && (
        <CreditPanel order={order} onPaid={setOrder} />
      )}
      {features.enabled('INVOICES') && <InvoicePanel order={order} canManage={canDispatch} onOrder={setOrder} />}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="card space-y-4">
          <h3 className="font-semibold">Төлбөрийн хуваарилалт</h3>
          {splits.map((p) => (
            <div key={p.id ?? `${channel(p)}-${p.amountMnt}`} className="border border-slate-800 rounded-lg p-3 text-sm">
              <p className="font-medium">
                {PAY_LABEL[channel(p)] ?? channel(p)} — {channel(p) === 'CREDIT' && p.status === 'PAID' ? 'бүрэн хаагдсан' : `${tugrik(p.amountMnt)} — ${PAY_STATUS[p.status] ?? p.status}`}
              </p>
              {channel(p) === 'QPAY' && p.qpayQrImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.qpayQrImage} alt="QPay QR" className="w-48 h-48 bg-white rounded mt-2" />
              )}
              {!['QPAY', 'CREDIT', 'OFFSET'].includes(channel(p)) && p.status === 'PAID' && (
                <p className="text-emerald-400 text-xs mt-1">Касс дээр бүртгэгдсэн</p>
              )}
            </div>
          ))}
          {canSimulatePaid && order.status === 'PENDING_PAYMENT' && qpaySplits.some((p) => p.status !== 'PAID') && (
            <button className="btn-ghost" onClick={simulatePaid}>
              Туршилт: үлдсэн QPay-г төлөгдсөн болгох
            </button>
          )}
        </div>
        <div className="card space-y-2">
          <h3 className="font-semibold">Бараа</h3>
          <ul className="text-sm space-y-2">
            {order.items.map((item) => {
              const taken = returnedByItem[item.id] ?? 0;
              const remaining = Number(item.quantity) - taken;
              const oversold =
                item.sourceType !== 'EXTERNAL_SUPPLIER' &&
                remaining > 0 &&
                Number(item.product.stockQty) < 0;
              return (
                <li key={item.id} className="flex justify-between gap-2 border-b border-slate-800 pb-2">
                  <div>
                    <p>{item.product.nameMn}</p>
                    {companionLines(item.product.companions, Number(item.quantity)).map((c) => (
                      <p key={c} className="text-xs text-amber-300">+ дагалдах: {c}</p>
                    ))}
                    <p className="text-xs text-slate-500">
                      {Number(item.quantity)} × {tugrik(item.unitPrice)}
                      {item.sourceType === 'EXTERNAL_SUPPLIER' ? ` · Гаднаас (${item.supplierName ?? 'өөр дэлгүүр'})` : ''}
                      {taken > 0 ? ` · буцаасан ${taken}` : ''}
                      {oversold ? ` · агуулахын үлдэгдэл ${Number(item.product.stockQty)}` : ''}
                    </p>
                    {oversold && (
                      <span className="mt-1 inline-flex rounded-full border border-rose-600 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-100">
                        Илүү зарагдсан
                      </span>
                    )}
                    {canDispatch && oversold && (
                      <button
                        type="button"
                        className="btn-ghost mt-2 text-xs px-3 py-1"
                        onClick={() => {
                          setAssignItemId(item.id);
                          setSupplierName(item.supplierName || '');
                          setSupplierReason('');
                        }}
                      >
                        Гадны нийлүүлэгч оноох
                      </button>
                    )}
                  </div>
                  <p>{tugrik(item.lineTotal)}</p>
                </li>
              );
            })}
          </ul>
          {(order.returns ?? []).length > 0 && (
            <div className="pt-2">
              <h4 className="text-sm font-semibold">Буцаалт</h4>
              {(order.returns ?? []).map((r) => (
                <p key={r.id} className="text-xs text-slate-400">
                  {tugrik(r.refundAmount)} {PAY_LABEL[r.refundMethod] ?? r.refundMethod} — {r.reason}
                  {features.enabled('EBARIMT') && r.ebarimtRefundId ? ` · И-баримт ${r.ebarimtRefundId}` : ''}
                  {r.refundStatus === 'PAID_OUT' ? ' · мөнгө буцаагдсан' : ' · мөнгө буцаагдаагүй (гараар олгоно)'}
                </p>
              ))}
            </div>
          )}
          <h3 className="font-semibold pt-2">Төлбөрийн задаргаа</h3>
          {features.enabled('DELIVERY') && (
            <p>
              Хэмжээний ангилал:{' '}
              {order.assignedVehicle ? VEHICLE_LABEL[order.assignedVehicle] ?? order.assignedVehicle : '—'}
            </p>
          )}
          {features.enabled('DELIVERY') && (
            <p>
              Жин {Number(order.totalWeightKg)}кг · урт {Number(order.maxLengthM)}м · эзлэхүүн {Number(order.totalVolumeM3)}м³
            </p>
          )}
          <p>Бараа {tugrik(order.subtotalMnt)}</p>
          {(features.enabled('DELIVERY') || order.deliveryFeeMnt > 0) && <p>Хүргэлт {tugrik(order.deliveryFeeMnt)}</p>}
          {(features.enabled('UNLOADING') || order.unloadingFeeMnt > 0) && <p>Буулгалт {tugrik(order.unloadingFeeMnt)}</p>}
          {(features.enabled('DELIVERY') || order.timeAdjustmentMnt !== 0) && <p>Цагийн нэмэгдэл {tugrik(order.timeAdjustmentMnt)}</p>}
          {order.feesOverridden && <p className="text-amber-brand">Гараар засагдсан</p>}

          {canEditFees && (
            <div className="border-t border-slate-700 pt-3 space-y-2">
              <h4 className="text-sm font-semibold">Борлуулагч — төлбөр засаж оруулах</h4>
              <input type="number" value={delivery} onChange={(e) => setDelivery(Number(e.target.value))} />
              <input type="number" value={unloading} onChange={(e) => setUnloading(Number(e.target.value))} />
              <input type="number" value={timeAdj} onChange={(e) => setTimeAdj(Number(e.target.value))} />
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Шалтгаан" />
              <button className="btn-primary" onClick={override}>
                Түүхэнд бүртгэж хадгалах
              </button>
            </div>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}

          {features.enabled('DELIVERY') && canTransport && isHiredTransport(order.deliveryMethod) && (
            <div className="border-t border-slate-700 pt-3 space-y-2">
              <h4 className="text-sm font-semibold">Хөлсний машины дугаар, утас</h4>
              <p className="text-xs text-slate-500">
                Дээрх хэмжээний ангиллаас тусдаа. Манай жолооч биш — хөлсөлсөн машины дугаар, утас.
              </p>
              <label className="block text-xs text-slate-400">
                Ачааны машины дугаар
                <input
                  className="mt-1 w-full"
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value)}
                  placeholder="7711 УБН"
                />
              </label>
              <label className="block text-xs text-slate-400">
                Гаднаас ирсэн жолоочийн утас
                <input
                  className="mt-1 w-full"
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  placeholder="99112233"
                />
              </label>
              <button type="button" className="btn-ghost" onClick={() => void saveTransport()}>
                Тээвэр хадгалах
              </button>
            </div>
          )}

          {features.enabled('EBARIMT') && (
          <div className="border-t border-slate-700 pt-3 space-y-2">
            <h4 className="text-sm font-semibold">И-Баримт</h4>
            <p className="text-sm">
              {order.billType === 'COMPANY' ? 'Байгууллага' : 'Хувь хүн'}
              {!isCashier && order.customerRegNumber ? ` · РД ${order.customerRegNumber}` : ''}
            </p>
            <p className="text-sm">
              Төлөв:{' '}
              <span className={order.ebarimtStatus === 'ISSUED' ? 'text-emerald-400' : order.ebarimtStatus === 'FAILED' ? 'text-red-400' : 'text-slate-300'}>
                {ebarimtStatusLabel(order.ebarimtStatus)}
                {order.ebarimtStatus === 'ISSUED' ? ' (олгосон)' : ''}
              </span>
            </p>
            {order.receiptId && (
              <p className="text-sm text-slate-300">
                Баримтын дугаар: <span className="font-medium text-white">{order.receiptId}</span>
              </p>
            )}
            {!isCashier && order.lottery && (
              <p className="text-lg font-bold text-amber-brand tracking-widest">{order.lottery}</p>
            )}
            {!isCashier && order.qrCode && (
              <div className="bg-white text-slate-950 rounded-lg p-3 text-[10px] break-all font-mono">
                {order.qrCode}
              </div>
            )}
            {!isCashier && order.ebarimtError && <p className="text-red-400 text-xs">{order.ebarimtError}</p>}
            {isCashier && order.ebarimtStatus === 'FAILED' && (
              <p className="text-red-400 text-sm">И-Баримт олгоход алдаа гарлаа</p>
            )}
            {order.status !== 'PENDING_PAYMENT' && order.ebarimtStatus !== 'ISSUED' && (
              <button className="btn-ghost" onClick={retryEbarimt}>
                И-баримт дахин илгээх
              </button>
            )}
          </div>
          )}
          {order.feeOverrides?.map((a) => (
            <p key={a.id} className="text-xs text-slate-400">
              {a.actor.fullName ?? a.actor.name}: {tugrik(a.previousTotal)} → {tugrik(a.newTotal)} — {a.reason}
            </p>
          ))}
          {canDispatch && (order.stockReconciliations ?? []).length > 0 && (
            <div className="border-t border-slate-700 pt-3 space-y-1">
              <h4 className="text-sm font-semibold">Үлдэгдлийн тохируулга</h4>
              {(order.stockReconciliations ?? []).map((a) => (
                <p key={a.id} className="text-xs text-slate-400">
                  {a.actor.fullName ?? a.actor.name}: {a.supplierName} · буцааж нэмсэн {Number(a.quantityRestored)} · үлдэгдэл{' '}
                  {Number(a.stockBefore)} → {Number(a.stockAfter)}
                  {a.reason ? ` — ${a.reason}` : ''}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {assignItemId && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={assignSupplier} className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">Гадны нийлүүлэгч оноох</h3>
            <p className="text-sm text-slate-300">
              Энэ мөрийг гадны нийлүүлэгчээс авсан болгоно. Олгосон захиалгын хувьд агуулахын үлдэгдэл сэргээгдэж, нийлүүлэгчид өглөг үүснэ.
            </p>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <label className="block text-xs text-slate-400">
              Нийлүүлэгч / өөр дэлгүүр
              <input
                className="mt-1 w-full"
                required
                minLength={2}
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Нийлүүлэгчийн нэр"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Шалтгаан (заавал биш)
              <input
                className="mt-1 w-full"
                value={supplierReason}
                onChange={(e) => setSupplierReason(e.target.value)}
                placeholder="Өөр талбайгаас зарсан / тэмдэглэхээ мартсан"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setAssignItemId(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Тохируулах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {returnOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submitReturn} className="card w-full max-w-lg space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">Буцаалт</h3>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {order.items.map((item) => {
              const remaining = Number(item.quantity) - (returnedByItem[item.id] ?? 0);
              if (remaining <= 0) {
                return (
                  <p key={item.id} className="text-xs text-slate-500">
                    {item.product.nameMn} — бүрэн буцаагдсан
                  </p>
                );
              }
              return (
                <label key={item.id} className="block text-xs text-slate-400">
                  {item.product.nameMn} (үлдсэн {remaining})
                  <input
                    type="number"
                    min={0}
                    max={remaining}
                    step={0.001}
                    className="mt-1 w-full"
                    value={returnQty[item.id] ?? 0}
                    onChange={(e) => setReturnQty({ ...returnQty, [item.id]: Number(e.target.value) })}
                  />
                </label>
              );
            })}
            <label className="block text-xs text-slate-400">
              Шалтгаан
              <input className="mt-1 w-full" required minLength={3} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} />
            </label>
            <label className="block text-xs text-slate-400">
              Буцаалтын төлбөрийн хэлбэр
              {owedOnOrder(order) > 0 ? (
                <p className="mt-1 text-amber-300">
                  Энэ захиалгад {tugrik(owedOnOrder(order))} өр байгаа тул буцаалт өрөөс хасагдана (мөнгө олгохгүй).
                </p>
              ) : (
                <select className="mt-1 w-full" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as 'CASH' | 'QPAY' | 'CARD' | 'TRANSFER')}>
                  <option value="CASH">Бэлэн</option>
                  <option value="CARD">Карт</option>
                  <option value="QPAY">QPay</option>
                  <option value="TRANSFER">Банкны шилжүүлэг</option>
                </select>
              )}
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setReturnOpen(false)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Буцаах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm ${error && toast === error ? 'border-red-700 bg-red-950 text-red-100' : 'border-emerald-700 bg-emerald-950 text-emerald-100'}`}>
          {toast}
        </div>
      )}
    </Shell>
  );
}
