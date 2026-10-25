'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { Order, VEHICLE_LABEL } from '@/lib/types';

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => {
    api<Order[]>('/orders').then(setOrders);
  }, []);

  return (
    <Shell>
      <h2 className="text-xl font-bold mb-4">Захиалгууд</h2>
      <div className="overflow-auto card p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Дугаар</th>
              <th>Харилцагч</th>
              <th>Бүс</th>
              <th>Төлөв</th>
              <th>Хэмжээ / ангилал</th>
              <th>Гадна тээвэр (дугаар)</th>
              <th>Ачигч</th>
              <th>Дүн</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-slate-800 hover:bg-steel-800">
                <td className="p-3">
                  <Link className="text-amber-brand" href={`/orders/${o.id}`}>
                    {o.orderNumber}
                  </Link>
                </td>
                <td>{o.customerName}</td>
                <td>{o.zone?.nameMn}</td>
                <td>
                  {o.status}
                  {o.items?.some(
                    (item) =>
                      item.sourceType !== 'EXTERNAL_SUPPLIER' && Number(item.product?.stockQty) < 0,
                  ) ? (
                    <span className="ml-2 inline-flex rounded-full border border-rose-600 bg-rose-950/70 px-2 py-0.5 text-[10px] font-semibold text-rose-100">
                      Oversold
                    </span>
                  ) : null}
                </td>
                <td>{o.assignedVehicle ? VEHICLE_LABEL[o.assignedVehicle] ?? o.assignedVehicle : '—'}</td>
                <td>
                  {o.deliveryMethod === 'SELF_PICKUP' || o.deliveryMethod === 'CUSTOMER_DRIVER'
                    ? '—'
                    : o.vehicleNumber
                      ? `${o.vehicleNumber}${o.driverPhone ? ` · ${o.driverPhone}` : ''}`
                      : '—'}
                </td>
                <td>{o.preparedBy?.fullName ?? o.completedBy?.fullName ?? '—'}</td>
                <td>{tugrik(o.totalMnt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
