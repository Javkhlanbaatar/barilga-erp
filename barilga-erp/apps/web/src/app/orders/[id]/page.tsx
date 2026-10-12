'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { GatherPanel } from '@/components/gather-panel';
import { Shell } from '@/components/shell';
import { api, orderTrackingUrl, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { AuthUser, ebarimtStatusLabel, isHiredTransport, Order, PaymentSplit, VEHICLE_LABEL } from '@/lib/types';
import { POS_ROLES, TRANSPORT_ROLES, hasRole } from '@/lib/rbac';

function channel(p: PaymentSplit) {
  return p.method ?? p.provider ?? 'QPAY';
}

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
  const [refundMethod, setRefundMethod] = useState<'CASH' | 'QPAY' | 'CARD'>('CASH');
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [assignItemId, setAssignItemId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [supplierReason, setSupplierReason] = useState('');
  const features = useFeatures();
  const canDispatch = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const canTransport = hasRole(user?.role, TRANSPORT_ROLES);
  const canOverrideFees = user?.role === 'BORLUULAGCH';
  // The mock "mark paid" button exists only for local development: it is compiled out of production
  // builds and additionally depends on the server saying simulation is enabled (dev + QPay mock).
  const [simulateEnabled, setSimulateEnabled] = useState(false);
  const canSimulatePaid =
    process.env.NODE_ENV !== 'production' && simulateEnabled && (user?.role === 'ADMIN' || user?.role === 'MANAGER');
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
  const canEditFees = canOverrideFees && order.status === 'PENDING_PAYMENT' && !hasPaidSplit;
  const canReturn =
    (user?.role === 'ADMIN' || user?.role === 'MANAGER' || user?.role === 'BORLUULAGCH') &&
    (order.status === 'COMPLETED' || order.status === 'READY_FOR_LOADING');

  function openReturn() {
    if (!order) return;
    const next: Record<string, number> = {};
    for (const item of order.items) next[item.id] = 0;
    setReturnQty(next);
    setReturnReason('');
    setRefundMethod('CASH');
    setReturnOpen(true);
  }

  async function submitReturn(e: FormEvent) {
    e.preventDefault();
    if (!order) return;
    const items = Object.entries(returnQty)
      .filter(([, qty]) => qty > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (!items.length) {
      setError('Select at least one quantity to return');
      setToast('Select at least one quantity to return');
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
      setToast('Return recorded — refund money is NOT paid out by the system');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Return failed';
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
      setError(err instanceof Error ? err.message : 'Override failed');
    }
  }

  async function simulatePaid() {
    if (!order) return;
    setError('');
    try {
      await api(`/payments/${order.id}/simulate-paid`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed');
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
      const message = err instanceof Error ? err.message : 'Cancel failed';
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
      setToast('Hired transport saved');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Assign failed';
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
      setToast('External supplier assigned; stock reconciled');
      window.setTimeout(() => setToast(''), 4000);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Assign failed';
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
      setError(err instanceof Error ? err.message : 'E-Barimt failed');
    }
  }

  return (
    <Shell>
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-amber-brand text-xs">{order.status}</p>
          <h2 className="text-2xl font-bold">{order.orderNumber}</h2>
          <p className="text-slate-400">
            {order.customerName} · {order.customerPhone} · {order.zone.nameMn} · {order.deliveryMethod}
            {order.warehouse ? ` · ${order.warehouse.name}` : ''}
          </p>
          {(order.preparedBy || order.completedBy) && (
            <p className="text-sm mt-1">
              Fulfillment staff:{' '}
              <span className="font-semibold text-amber-brand">
                {order.preparedBy?.fullName ?? order.completedBy?.fullName ?? order.completedBy?.name}
              </span>
            </p>
          )}
          <p className="text-sm text-slate-400">
            Size class:{' '}
            <span className="font-medium text-slate-200">
              {order.assignedVehicle ? VEHICLE_LABEL[order.assignedVehicle] ?? order.assignedVehicle : '—'}
            </span>
            <span className="text-slate-500"> (capacity match, not the hired plate)</span>
          </p>
          {isHiredTransport(order.deliveryMethod) && (
            <p className="text-sm">
              Hired truck plate:{' '}
              <span className="font-semibold">{order.vehicleNumber ?? '—'}</span>
              {order.driverPhone ? ` · ${order.driverPhone}` : ''}
            </p>
          )}
          {order.trackingToken && (
            <p className="text-sm text-slate-400 mt-1">
              Tracking:{' '}
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
          {canReturn && (
            <button className="btn-ghost text-sm" onClick={openReturn}>
              Return Items
            </button>
          )}
          {canCancel && (
            <button className="btn-danger text-sm" onClick={cancelOrder}>
              Захиалга цуцлах
            </button>
          )}
        </div>
      </div>
      {canDispatch && order.status === 'READY_FOR_LOADING' && features.enabled('STOCK_TRANSFERS') && (
        <GatherPanel orderId={order.id} />
      )}
      <div className="grid grid-cols-2 gap-6">
        <div className="card space-y-4">
          <h3 className="font-semibold">Төлбөрийн хуваарилалт</h3>
          {splits.map((p) => (
            <div key={p.id ?? `${channel(p)}-${p.amountMnt}`} className="border border-slate-800 rounded-lg p-3 text-sm">
              <p className="font-medium">
                {channel(p)} — {tugrik(p.amountMnt)} — {p.status}
              </p>
              {channel(p) === 'QPAY' && p.qpayQrImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.qpayQrImage} alt="QPay QR" className="w-48 h-48 bg-white rounded mt-2" />
              )}
              {channel(p) !== 'QPAY' && p.status === 'PAID' && (
                <p className="text-emerald-400 text-xs mt-1">Касс дээр бүртгэгдсэн</p>
              )}
            </div>
          ))}
          {canSimulatePaid && order.status === 'PENDING_PAYMENT' && qpaySplits.some((p) => p.status !== 'PAID') && (
            <button className="btn-ghost" onClick={simulatePaid}>
              Mock: үлдсэн QPay PAID
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
                    <p className="text-xs text-slate-500">
                      {Number(item.quantity)} × {tugrik(item.unitPrice)}
                      {item.sourceType === 'EXTERNAL_SUPPLIER' ? ` · External (${item.supplierName ?? 'Other store'})` : ' · Internal'}
                      {taken > 0 ? ` · returned ${taken}` : ''}
                      {oversold ? ` · warehouse stock ${Number(item.product.stockQty)}` : ''}
                    </p>
                    {oversold && (
                      <span className="mt-1 inline-flex rounded-full border border-rose-600 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-100">
                        Oversold
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
                        Assign External Supplier
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
              <h4 className="text-sm font-semibold">Returns</h4>
              {(order.returns ?? []).map((r) => (
                <p key={r.id} className="text-xs text-slate-400">
                  {tugrik(r.refundAmount)} {r.refundMethod} — {r.reason}
                  {r.ebarimtRefundId ? ` · E-Barimt ${r.ebarimtRefundId}` : ''}
                  {r.refundStatus === 'PAID_OUT' ? ' · мөнгө буцаагдсан' : ' · мөнгө буцаагдаагүй (гараар олгоно)'}
                </p>
              ))}
            </div>
          )}
          <h3 className="font-semibold pt-2">Төлбөрийн задаргаа</h3>
          <p>
            Size class:{' '}
            {order.assignedVehicle ? VEHICLE_LABEL[order.assignedVehicle] ?? order.assignedVehicle : '—'}
          </p>
          <p>
            Жин {Number(order.totalWeightKg)}кг · урт {Number(order.maxLengthM)}м · эзлэхүүн {Number(order.totalVolumeM3)}м³
          </p>
          <p>Бараа {tugrik(order.subtotalMnt)}</p>
          <p>Хүргэлт {tugrik(order.deliveryFeeMnt)}</p>
          <p>Буулгалт {tugrik(order.unloadingFeeMnt)}</p>
          <p>Цагийн нэмэгдэл {tugrik(order.timeAdjustmentMnt)}</p>
          {order.feesOverridden && <p className="text-amber-brand">Гараар засагдсан</p>}

          {canEditFees && (
            <div className="border-t border-slate-700 pt-3 space-y-2">
              <h4 className="text-sm font-semibold">Борлуулагч — төлбөр засаж оруулах</h4>
              <input type="number" value={delivery} onChange={(e) => setDelivery(Number(e.target.value))} />
              <input type="number" value={unloading} onChange={(e) => setUnloading(Number(e.target.value))} />
              <input type="number" value={timeAdj} onChange={(e) => setTimeAdj(Number(e.target.value))} />
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Шалтгаан" />
              <button className="btn-primary" onClick={override}>
                Audit-тай хадгалах
              </button>
            </div>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}

          {canTransport && isHiredTransport(order.deliveryMethod) && (
            <div className="border-t border-slate-700 pt-3 space-y-2">
              <h4 className="text-sm font-semibold">Hired truck plate &amp; phone</h4>
              <p className="text-xs text-slate-500">
                Separate from size class above. No internal staff drivers — plate and phone of the hired truck.
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
                Save transport
              </button>
            </div>
          )}

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
                {order.ebarimtStatus === 'ISSUED' ? ' (ISSUED)' : ''}
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
                Retry E-Barimt
              </button>
            )}
          </div>
          {order.feeOverrides?.map((a) => (
            <p key={a.id} className="text-xs text-slate-400">
              {a.actor.fullName ?? a.actor.name}: {tugrik(a.previousTotal)} → {tugrik(a.newTotal)} — {a.reason}
            </p>
          ))}
          {canDispatch && (order.stockReconciliations ?? []).length > 0 && (
            <div className="border-t border-slate-700 pt-3 space-y-1">
              <h4 className="text-sm font-semibold">Stock reconciliation</h4>
              {(order.stockReconciliations ?? []).map((a) => (
                <p key={a.id} className="text-xs text-slate-400">
                  {a.actor.fullName ?? a.actor.name}: {a.supplierName} · restored {Number(a.quantityRestored)} · stock{' '}
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
            <h3 className="font-semibold text-lg">Assign External Supplier</h3>
            <p className="text-sm text-slate-300">
              Convert this internal line to an external supplier purchase. Completed orders restore warehouse stock and open a supplier payable.
            </p>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <label className="block text-xs text-slate-400">
              Supplier / other store
              <input
                className="mt-1 w-full"
                required
                minLength={2}
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Supplier name"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Reason (optional)
              <input
                className="mt-1 w-full"
                value={supplierReason}
                onChange={(e) => setSupplierReason(e.target.value)}
                placeholder="Sold from another yard / missed checkbox"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setAssignItemId(null)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Reconcile'}
              </button>
            </div>
          </form>
        </div>
      )}

      {returnOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={submitReturn} className="card w-full max-w-lg space-y-3 max-h-[90vh] overflow-auto">
            <h3 className="font-semibold text-lg">Return Items</h3>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {order.items.map((item) => {
              const remaining = Number(item.quantity) - (returnedByItem[item.id] ?? 0);
              if (remaining <= 0) {
                return (
                  <p key={item.id} className="text-xs text-slate-500">
                    {item.product.nameMn} — fully returned
                  </p>
                );
              }
              return (
                <label key={item.id} className="block text-xs text-slate-400">
                  {item.product.nameMn} (remaining {remaining})
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
              Reason
              <input className="mt-1 w-full" required minLength={3} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} />
            </label>
            <label className="block text-xs text-slate-400">
              Refund method
              <select className="mt-1 w-full" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as 'CASH' | 'QPAY' | 'CARD')}>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="QPAY">QPay</option>
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setReturnOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Refund'}
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
