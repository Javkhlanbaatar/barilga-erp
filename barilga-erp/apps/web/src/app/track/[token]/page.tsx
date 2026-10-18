'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { publicApi, tugrik } from '@/lib/api';
import { DELIVERY_LABEL, ORDER_STATUS_LABEL, isHiredTransport } from '@/lib/types';

type PublicOrder = {
  orderNumber: string;
  status: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress?: string | null;
  deliveryMethod: string;
  zone: { nameMn: string };
  assignedVehicle?: string | null;
  vehicleNumber?: string | null;
  driverPhone?: string | null;
  totalMnt: number;
  items: Array<{ nameMn: string; quantity: number; unit: string; lineTotal: number }>;
  payments: Array<{
    method: string;
    status: string;
    amountMnt: number;
    qpayQrImage?: string | null;
  }>;
};

export default function TrackOrderPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    publicApi<PublicOrder>(`/public/orders/${token}`)
      .then((row) => {
        setOrder(row);
        setVehicleNumber(row.vehicleNumber ?? '');
        setDriverPhone(row.driverPhone ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Захиалга олдсонгүй'));
  }, [token]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk('');
    try {
      const row = await publicApi<PublicOrder>(`/public/orders/${token}/transport`, {
        method: 'PATCH',
        body: JSON.stringify({ vehicleNumber: vehicleNumber.trim(), driverPhone: driverPhone.trim() }),
      });
      setOrder(row);
      setOk('Хүргэлтийн мэдээлэл хадгалагдлаа');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  if (!order && !error) return <p className="p-8 text-slate-400">Уншиж байна…</p>;

  return (
    <main className="min-h-screen max-w-lg mx-auto px-4 py-10">
      <p className="text-amber-brand text-xs tracking-[0.2em] uppercase mb-2">Barilga</p>
      <h1 className="text-2xl font-bold mb-1">Захиалга хянах</h1>
      <p className="text-slate-400 text-sm mb-6">
        <Link href="/order" className="text-amber-brand hover:underline">
          Шинэ захиалга
        </Link>
      </p>
      {error && <p className="text-red-400 mb-3">{error}</p>}
      {order && (
        <div className="card space-y-3">
          <p className="text-amber-brand text-xs">{ORDER_STATUS_LABEL[order.status] ?? order.status}</p>
          <h2 className="text-xl font-bold">{order.orderNumber}</h2>
          <p className="text-sm text-slate-300">
            {order.customerName} · {order.customerPhone}
          </p>
          <p className="text-sm">
            {DELIVERY_LABEL[order.deliveryMethod] ?? order.deliveryMethod} · {order.zone.nameMn}
          </p>
          {order.deliveryAddress && <p className="text-sm">{order.deliveryAddress}</p>}
          <ul className="text-sm space-y-1">
            {order.items.map((item, i) => (
              <li key={`${item.nameMn}-${i}`}>
                {item.nameMn} × {Number(item.quantity)} {item.unit}
              </li>
            ))}
          </ul>
          <p className="font-bold text-amber-brand">{tugrik(order.totalMnt)}</p>
          {order.payments.map((p, i) => (
            <div key={`${p.method}-${i}`} className="text-sm">
              <p>
                {({ QPAY: 'QPay', CASH: 'Бэлэн', CARD: 'Карт', TRANSFER: 'Шилжүүлэг', CREDIT: 'Дараа төлөх', OFFSET: 'Тооцоонд хасагдсан' } as Record<string, string>)[p.method] ?? p.method} — {tugrik(p.amountMnt)} — {({ PAID: 'төлөгдсөн', UNPAID: 'хүлээгдэж буй', EXPIRED: 'хүчингүй', FAILED: 'амжилтгүй' } as Record<string, string>)[p.status] ?? p.status}
              </p>
              {p.method === 'QPAY' && p.qpayQrImage && p.status !== 'PAID' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.qpayQrImage} alt="QPay QR" className="w-48 h-48 bg-white rounded mt-2" />
              )}
            </div>
          ))}
          {isHiredTransport(order.deliveryMethod) && order.status !== 'CANCELLED' && (
            <form onSubmit={(e) => void save(e)} className="border-t border-slate-700 pt-3 space-y-2">
              <p className="text-sm font-semibold">Хүргэлтийн машин / жолооч</p>
              <label className="block text-sm">
                Ачааны машины дугаар
                <input className="mt-1 w-full" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} required minLength={2} />
              </label>
              <label className="block text-sm">
                Жолоочийн утас
                <input className="mt-1 w-full" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} required />
              </label>
              {ok && <p className="text-emerald-400 text-sm">{ok}</p>}
              <button className="btn-primary w-full" disabled={busy}>
                {busy ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </form>
          )}
        </div>
      )}
    </main>
  );
}
