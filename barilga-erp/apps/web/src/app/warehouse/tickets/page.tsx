'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api, orderTrackingUrl, tugrik } from '@/lib/api';
import { AuthUser, DELIVERY_LABEL, isHiredTransport, Order, VEHICLE_LABEL } from '@/lib/types';
import { TRANSPORT_ROLES, hasRole } from '@/lib/rbac';

type TicketTab = 'pending' | 'done';

function vehicleLabel(code?: string | null) {
  if (!code) return 'Unassigned';
  return VEHICLE_LABEL[code] ?? code;
}

function deliveryLabel(method: string) {
  return DELIVERY_LABEL[method] ?? method;
}

function formatTs(iso?: string | null) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('mn-MN', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function preparedName(o: Order) {
  return o.preparedBy?.fullName ?? o.completedBy?.fullName ?? o.completedBy?.name ?? '—';
}

function vehicleInfo(o: Order) {
  const size = vehicleLabel(o.assignedVehicle);
  if (isHiredTransport(o.deliveryMethod) && o.vehicleNumber) {
    return `${size} · ${o.vehicleNumber}${o.driverPhone ? ` · ${o.driverPhone}` : ''}`;
  }
  return `${size} · ${deliveryLabel(o.deliveryMethod)}`;
}

export default function WarehouseTicketsPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [recent, setRecent] = useState<Order[]>([]);
  const [tab, setTab] = useState<TicketTab>('pending');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const staffName = user?.fullName ?? user?.name ?? '';
  const canManageTransport = hasRole(user?.role, TRANSPORT_ROLES);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [queue, done] = await Promise.all([
        api<Order[]>('/orders/tickets'),
        api<Order[]>('/orders/tickets/recent').catch(() => [] as Order[]),
      ]);
      setOrders(queue);
      setRecent(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const token = localStorage.getItem('barilga_token');
    if (!raw || !token) {
      router.replace('/login');
      return;
    }
    const parsed = JSON.parse(raw) as AuthUser;
    const allowed = ['ACHIGCH_BELTGEGCH', 'ADMIN', 'MANAGER', 'BORLUULAGCH'];
    if (!allowed.includes(parsed.role)) {
      router.replace('/pos');
      return;
    }
    setUser(parsed);
  }, [router]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  async function complete(id: string) {
    setError('');
    const order = orders.find((o) => o.id === id);
    if (order && isHiredTransport(order.deliveryMethod)) {
      const vehicleNumber = order.vehicleNumber?.trim() ?? '';
      const driverPhone = (order.driverPhone ?? '').replace(/\s+/g, '');
      if (vehicleNumber.length < 2 || driverPhone.length < 8) {
        setError('Hired delivery needs plate and driver phone from the web form or tracking link');
        return;
      }
    }
    setBusyId(id);
    try {
      await api(`/warehouse/tickets/${id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      setTab('done');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot complete order');
    } finally {
      setBusyId(null);
    }
  }

  if (!user) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Warehouse loader</p>
          <h2 className="text-xl font-bold">Loading tickets</h2>
          <p className="text-slate-400 text-sm mt-1">
            Paid orders ready to load. Completing records you as preparedBy.
          </p>
          <p className="text-sm text-white mt-2">
            On duty:{' '}
            <span className="font-semibold text-amber-brand">{staffName}</span>
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          className={tab === 'pending' ? 'btn-primary text-sm px-4' : 'btn-ghost text-sm px-4'}
          onClick={() => setTab('pending')}
        >
          Бэлтгэх захиалгууд
          {orders.length > 0 ? ` (${orders.length})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'done' ? 'btn-primary text-sm px-4' : 'btn-ghost text-sm px-4'}
          onClick={() => setTab('done')}
        >
          Бэлдэж дууссан
          {recent.length > 0 ? ` (${recent.length})` : ''}
        </button>
      </div>

      {error && <p className="text-red-400 mb-3">{error}</p>}
      {loading && orders.length === 0 && recent.length === 0 && (
        <p className="text-slate-500">Loading tickets…</p>
      )}

      {tab === 'pending' && (
        <div className="grid gap-3">
          {orders.map((o) => (
            <article key={o.id} className="card grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-amber-brand text-xs uppercase tracking-wide">Release ticket</span>
                  <span className="rounded-full bg-emerald-900/60 border border-emerald-700 px-2 py-0.5 text-[11px] text-emerald-300">
                    {o.status}
                  </span>
                </div>
                <h3 className="font-bold text-lg">{o.orderNumber}</h3>
                <p className="text-sm text-slate-300">
                  {o.customerName} · {o.customerPhone}
                </p>
                <p className="text-sm">
                  <span className="text-slate-500">Size class (capacity): </span>
                  <span className="font-semibold text-white">{vehicleLabel(o.assignedVehicle)}</span>
                  <span className="text-slate-400">
                    {' '}
                    · {Number(o.totalWeightKg)} кг · {Number(o.maxLengthM)} м · {Number(o.totalVolumeM3)} м³
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    Quote match only — not the hired truck plate.
                  </span>
                </p>
                <p className="text-sm">
                  <span className="text-slate-500">Delivery: </span>
                  {deliveryLabel(o.deliveryMethod)}
                  {o.zone?.nameMn ? ` · ${o.zone.nameMn}` : ''}
                </p>
                <p className="text-sm">
                  <span className="text-slate-500">Address: </span>
                  <span className="text-white">{o.deliveryAddress?.trim() || 'No address on file'}</span>
                </p>
                <ul className="text-sm text-slate-300 mt-1">
                  {o.items.map((i) => (
                    <li key={i.id}>
                      {i.product.nameMn} × {Number(i.quantity)}
                    </li>
                  ))}
                </ul>
                {isHiredTransport(o.deliveryMethod) ? (
                  <div className="rounded-lg border border-slate-700 p-3 space-y-1">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Web / tracking transport</p>
                    <p className="text-sm">
                      Plate: <span className="font-semibold text-white">{o.vehicleNumber?.trim() || '—'}</span>
                    </p>
                    <p className="text-sm">
                      Driver phone: <span className="font-semibold text-white">{o.driverPhone?.trim() || '—'}</span>
                    </p>
                    {o.trackingToken && (
                      <p className="text-xs text-slate-400 break-all">
                        Tracking: {orderTrackingUrl(o.trackingToken) || `/track/${o.trackingToken}`}
                      </p>
                    )}
                    {!(o.vehicleNumber && o.driverPhone) && (
                      <p className="text-amber-300 text-xs">
                        Waiting on customer or hired driver via tracking link
                        {canManageTransport ? ' (staff can still save from the order page).' : '.'}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">
                    {o.deliveryMethod === 'CUSTOMER_DRIVER'
                      ? 'Customer driver — no hired truck details.'
                      : 'Self pickup — no hired truck details.'}
                  </p>
                )}
                <p className="text-xs text-slate-500">{tugrik(o.totalMnt)} paid in full</p>
              </div>
              <button
                className="btn-primary whitespace-nowrap"
                disabled={
                  busyId === o.id ||
                  (isHiredTransport(o.deliveryMethod) && !(o.vehicleNumber && o.driverPhone))
                }
                onClick={() => void complete(o.id)}
              >
                {busyId === o.id ? 'Saving…' : 'Би бэлдлээ'}
              </button>
            </article>
          ))}
          {!loading && orders.length === 0 && (
            <p className="text-slate-500">No paid orders waiting to load.</p>
          )}
        </div>
      )}

      {tab === 'done' && (
        <div className="overflow-auto card p-0">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-left text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-3">Order ID</th>
                <th className="p-3">Customer / vehicle</th>
                <th className="p-3">Completed</th>
                <th className="p-3">Prepared by</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="p-3">
                    <p className="font-semibold text-white">{o.orderNumber}</p>
                    <p className="text-[11px] text-emerald-300">{o.status}</p>
                  </td>
                  <td className="p-3">
                    <p className="text-white">
                      {o.customerName}
                      {o.customerPhone ? ` · ${o.customerPhone}` : ''}
                    </p>
                    <p className="text-xs text-slate-400">{vehicleInfo(o)}</p>
                  </td>
                  <td className="p-3 text-slate-300">{formatTs(o.completedAt ?? o.preparedAt)}</td>
                  <td className="p-3">
                    <span className="font-semibold text-amber-brand">{preparedName(o)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && recent.length === 0 && (
            <p className="p-4 text-slate-500">No completed tickets yet.</p>
          )}
        </div>
      )}
    </Shell>
  );
}
