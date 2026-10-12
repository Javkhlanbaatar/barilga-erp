'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PickList, unpickedCount } from '@/components/pick-list';
import { Shell } from '@/components/shell';
import { api, orderTrackingUrl, tugrik } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { TRANSPORT_ROLES, hasRole } from '@/lib/rbac';
import { AuthUser, DELIVERY_LABEL, isHiredTransport, Order, VEHICLE_LABEL } from '@/lib/types';

/** queue = paid, nobody started · preparing = someone pressed «Би бэлдье» · done = completed recently. */
type TicketTab = 'queue' | 'preparing' | 'done';

const DELIVERY_MN: Record<string, string> = {
  OUR_DELIVERY: 'Манай хүргэлт',
  DELIVERY: 'Манай хүргэлт',
  SELF_PICKUP: 'Өөрөө авах',
  CUSTOMER_DRIVER: 'Харилцагчийн жолооч',
};

function vehicleLabel(code?: string | null) {
  if (!code) return '—';
  return VEHICLE_LABEL[code] ?? code;
}

function formatTs(iso?: string | null) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('mn-MN', {
    timeZone: 'Asia/Ulaanbaatar',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "12 мин" / "1 ц 05 мин" since `iso`. */
function elapsed(iso: string | null | undefined, now: number) {
  if (!iso) return '';
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ц ${String(min % 60).padStart(2, '0')} мин`;
}

function vehicleInfo(o: Order) {
  if (isHiredTransport(o.deliveryMethod) && o.vehicleNumber) {
    return `${vehicleLabel(o.assignedVehicle)} · ${o.vehicleNumber}${o.driverPhone ? ` · ${o.driverPhone}` : ''}`;
  }
  return DELIVERY_MN[o.deliveryMethod] ?? DELIVERY_LABEL[o.deliveryMethod] ?? o.deliveryMethod;
}

export default function WarehouseTicketsPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [recent, setRecent] = useState<Order[]>([]);
  const [tab, setTab] = useState<TicketTab>('queue');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const staffName = user?.fullName ?? user?.name ?? '';
  const canManageTransport = hasRole(user?.role, TRANSPORT_ROLES);
  const features = useFeatures();
  const picking = features.enabled('PICKING');

  // Without the picking module there is no "being prepared" step: everything waits in the queue.
  const queue = orders.filter((o) => !picking || !o.pickingStartedAt);
  const preparing = picking ? orders.filter((o) => o.pickingStartedAt) : [];

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [open, done] = await Promise.all([
        api<Order[]>('/orders/tickets'),
        api<Order[]>('/orders/tickets/recent').catch(() => [] as Order[]),
      ]);
      setOrders(open);
      setRecent(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Тасалбар ачаалж чадсангүй');
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
    if (!['ACHIGCH_BELTGEGCH', 'ADMIN', 'MANAGER', 'BORLUULAGCH'].includes(parsed.role)) {
      router.replace('/pos');
      return;
    }
    setUser(parsed);
  }, [router]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // Several people work the same queue: refresh so everyone sees who took what and each other's ticks.
  useEffect(() => {
    if (!user || tab === 'done') return;
    const timer = window.setInterval(() => {
      if (!busyId) void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [user, tab, busyId, load]);

  // Keeps the "preparing for N min" clocks moving.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function start(o: Order) {
    setBusyId(o.id);
    setError('');
    try {
      const updated = await api<Order>(`/orders/${o.id}/start-picking`, { method: 'PATCH' });
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, ...updated } : x)));
      setTab('preparing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Эхлүүлж чадсангүй');
    } finally {
      setBusyId(null);
    }
  }

  async function complete(o: Order) {
    setError('');
    if (isHiredTransport(o.deliveryMethod)) {
      const vehicleNumber = o.vehicleNumber?.trim() ?? '';
      const driverPhone = (o.driverPhone ?? '').replace(/\s+/g, '');
      if (vehicleNumber.length < 2 || driverPhone.length < 8) {
        setError('Хөлсний машинтай хүргэлтэд машины дугаар, жолоочийн утас шаардлагатай');
        return;
      }
    }
    if (picking) {
      const left = unpickedCount(o);
      if (left > 0 && !window.confirm(`${left} бараа «бэлдсэн» гэж чагтлагдаагүй байна. Бүгдийг ачихад бэлэн гэж үзээд дуусгах уу?`)) {
        return;
      }
    }
    setBusyId(o.id);
    try {
      await api(`/warehouse/tickets/${o.id}/complete`, { method: 'PATCH', body: JSON.stringify({}) });
      setTab('done');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Дуусгаж чадсангүй');
    } finally {
      setBusyId(null);
    }
  }

  if (!user) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  const transportBlock = (o: Order) =>
    isHiredTransport(o.deliveryMethod) ? (
      <div className="rounded-lg border border-slate-700 p-3 space-y-1 text-sm">
        <p>
          Машин: <span className="font-semibold text-white">{o.vehicleNumber?.trim() || '—'}</span> · Жолооч:{' '}
          <span className="font-semibold text-white">{o.driverPhone?.trim() || '—'}</span>
        </p>
        {o.trackingToken && (
          <p className="text-xs text-slate-400 break-all">Tracking: {orderTrackingUrl(o.trackingToken) || `/track/${o.trackingToken}`}</p>
        )}
        {!(o.vehicleNumber && o.driverPhone) && (
          <p className="text-amber-300 text-xs">
            Машины мэдээлэл хүлээгдэж байна{canManageTransport ? ' (захиалгын хуудаснаас оруулж болно).' : '.'}
          </p>
        )}
      </div>
    ) : null;

  const header = (o: Order) => (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold text-lg">{o.orderNumber}</h3>
        <span className="text-xs text-slate-400">төлсөн {tugrik(o.totalMnt)}</span>
      </div>
      <p className="text-sm text-slate-300">
        {o.customerName} · {o.customerPhone}
      </p>
      {features.enabled('DELIVERY') && (
      <p className="text-sm">
        <span className="text-slate-500">Хүргэлт: </span>
        {DELIVERY_MN[o.deliveryMethod] ?? o.deliveryMethod}
        {o.deliveryMethod === 'OUR_DELIVERY' && o.zone?.nameMn ? ` · ${o.zone.nameMn}` : ''}
        {o.deliveryAddress?.trim() ? ` · ${o.deliveryAddress}` : ''}
      </p>
      )}
      {features.enabled('DELIVERY') && (
      <p className="text-xs text-slate-500">
        {Number(o.totalWeightKg).toLocaleString('mn-MN')} кг · {Number(o.totalVolumeM3)} м³ · урт {Number(o.maxLengthM)} м · машин:{' '}
        {vehicleLabel(o.assignedVehicle)}
      </p>
      )}
    </>
  );

  const printLink = (o: Order) => (
    <a className="btn-ghost whitespace-nowrap text-center text-sm" href={`/print/orders/${o.id}?doc=picklist`} target="_blank" rel="noreferrer">
      Бэлтгэх хуудас хэвлэх
    </a>
  );

  const tabs: Array<[TicketTab, string, number]> = [
    ['queue', 'Бэлтгэх', queue.length],
    ...(picking ? ([['preparing', 'Бэлдэгдэж буй', preparing.length]] as Array<[TicketTab, string, number]>) : []),
    ['done', 'Бэлдэж дууссан', recent.length],
  ];

  return (
    <Shell>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Агуулах</p>
          <h2 className="text-xl font-bold">Бэлтгэх тасалбар</h2>
          <p className="text-sm text-white mt-1">
            Ээлжинд: <span className="font-semibold text-amber-brand">{staffName}</span>
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Шинэчлэх
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'btn-primary text-sm px-4' : 'btn-ghost text-sm px-4'}
            onClick={() => setTab(key)}
          >
            {label}
            {count > 0 ? ` (${count})` : ''}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 mb-3">{error}</p>}
      {loading && orders.length === 0 && recent.length === 0 && <p className="text-slate-500">Уншиж байна…</p>}

      {tab === 'queue' && (
        <div className="grid gap-3">
          {queue.map((o) => (
            <article key={o.id} className="card grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
              <div className="space-y-2">
                {header(o)}
                <ul className="text-sm text-slate-300">
                  {o.items.map((i) => (
                    <li key={i.id}>
                      {i.product.nameMn} × {Number(i.quantity)} {i.product.unit}
                    </li>
                  ))}
                </ul>
                {transportBlock(o)}
              </div>
              <div className="flex flex-col gap-2">
                {picking ? (
                  <button className="btn-primary whitespace-nowrap" disabled={busyId === o.id} onClick={() => void start(o)}>
                    {busyId === o.id ? '…' : 'Би бэлдье'}
                  </button>
                ) : (
                  <button
                    className="btn-primary whitespace-nowrap"
                    disabled={busyId === o.id || (isHiredTransport(o.deliveryMethod) && !(o.vehicleNumber && o.driverPhone))}
                    onClick={() => void complete(o)}
                  >
                    {busyId === o.id ? '…' : 'Бэлдэж дууслаа'}
                  </button>
                )}
                {printLink(o)}
              </div>
            </article>
          ))}
          {!loading && queue.length === 0 && <p className="text-slate-500">Бэлтгэх захиалга алга.</p>}
        </div>
      )}

      {tab === 'preparing' && (
        <div className="grid gap-3">
          {preparing.map((o) => (
            <article key={o.id} className="card grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
              <div className="space-y-2">
                <span className="inline-flex rounded-full border border-amber-600 bg-amber-950/60 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
                  {o.pickingStartedBy?.fullName ?? '—'} бэлдэж байна · {elapsed(o.pickingStartedAt, now)}
                </span>
                {header(o)}
                <PickList
                  order={o}
                  onChange={(items) => setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, items } : x)))}
                />
                {transportBlock(o)}
              </div>
              <div className="flex flex-col gap-2">
                <button
                  className="btn-primary whitespace-nowrap"
                  disabled={busyId === o.id || (isHiredTransport(o.deliveryMethod) && !(o.vehicleNumber && o.driverPhone))}
                  onClick={() => void complete(o)}
                >
                  {busyId === o.id ? '…' : 'Бэлдэж дууслаа'}
                </button>
                {printLink(o)}
              </div>
            </article>
          ))}
          {!loading && preparing.length === 0 && (
            <p className="text-slate-500">Одоо бэлдэгдэж буй захиалга алга. «Бэлтгэх» табаас «Би бэлдье» дарна уу.</p>
          )}
        </div>
      )}

      {tab === 'done' && (
        <div className="overflow-auto card p-0">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-left text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-3">Захиалга</th>
                <th className="p-3">Харилцагч / тээвэр</th>
                <th className="p-3">Эхэлсэн</th>
                <th className="p-3">Дууссан</th>
                <th className="p-3">Бэлдсэн</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="p-3 font-semibold text-white">{o.orderNumber}</td>
                  <td className="p-3">
                    <p className="text-white">
                      {o.customerName}
                      {o.customerPhone ? ` · ${o.customerPhone}` : ''}
                    </p>
                    <p className="text-xs text-slate-400">{vehicleInfo(o)}</p>
                  </td>
                  <td className="p-3 text-slate-300">{formatTs(o.pickingStartedAt)}</td>
                  <td className="p-3 text-slate-300">{formatTs(o.completedAt ?? o.preparedAt)}</td>
                  <td className="p-3">
                    <span className="font-semibold text-amber-brand">
                      {o.preparedBy?.fullName ?? o.completedBy?.fullName ?? o.completedBy?.name ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && recent.length === 0 && <p className="p-4 text-slate-500">Дууссан захиалга алга.</p>}
        </div>
      )}
    </Shell>
  );
}
