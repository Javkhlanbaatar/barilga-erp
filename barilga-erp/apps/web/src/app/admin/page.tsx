'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { useFeatures } from '@/lib/features';
import { api, tugrik } from '@/lib/api';
import Link from 'next/link';
import { AuthUser, ReconciliationReport, Vehicle, Zone } from '@/lib/types';
import { OVERSIGHT_ROLES, hasRole, homeForRole } from '@/lib/rbac';

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [zones, setZones] = useState<Zone[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [recon, setRecon] = useState<ReconciliationReport | null>(null);
  const isAdmin = user?.role === 'ADMIN';
  const delivery = useFeatures().enabled('DELIVERY');

  async function load() {
    setZones(await api('/zones'));
    setVehicles(await api('/vehicles'));
    try {
      setRecon(await api<ReconciliationReport>('/inventory/reconciliation'));
    } catch {
      setRecon(null);
    }
  }

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const parsed = raw ? (JSON.parse(raw) as AuthUser) : null;
    if (!hasRole(parsed?.role, OVERSIGHT_ROLES)) {
      router.replace(homeForRole(parsed?.role));
      return;
    }
    setUser(parsed);
    setAllowed(true);
    void load();
  }, [router]);

  async function saveZone(z: Zone) {
    await api(`/zones/${z.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        baseDeliveryFeeMnt: Number(z.baseDeliveryFeeMnt),
        nightDiscountApplies: z.nightDiscountApplies,
      }),
    });
    await load();
  }

  async function saveVehicle(v: Vehicle) {
    await api(`/vehicles/${v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        maxWeightKg: Number(v.maxWeightKg),
        maxLengthM: Number(v.maxLengthM),
        maxVolumeM3: Number(v.maxVolumeM3),
      }),
    });
    await load();
  }

  if (!allowed) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <h2 className="text-xl font-bold mb-4">Хяналт самбар</h2>
      <div className="grid gap-6">
        <section className="card">
          <h3 className="font-semibold mb-1">Үлдэгдлээс илүү зарагдсан бараа</h3>
          <p className="text-sm text-slate-400 mb-3">
            Агуулахын үлдэгдлээс илүү зарагдсан мөрүүд. Захиалга дээр нийлүүлэгчийг сонгож тохируулна.
          </p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <article className="rounded-lg border border-slate-700 p-3">
              <p className="text-xs text-slate-400 uppercase">Хасах үлдэгдэлтэй бараа</p>
              <p className="text-2xl font-bold text-rose-200">{recon?.summary.negativeProducts ?? 0}</p>
            </article>
            <article className="rounded-lg border border-slate-700 p-3">
              <p className="text-xs text-slate-400 uppercase">Шийдээгүй мөр</p>
              <p className="text-2xl font-bold text-amber-200">{recon?.summary.unassignedLines ?? 0}</p>
            </article>
          </div>
          {(recon?.lines.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">Илүү зарагдсан бараа алга.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-700">
                <tr>
                  <th className="py-2">Захиалга</th>
                  <th>Бараа</th>
                  <th className="text-right">Тоо</th>
                  <th className="text-right">Үлдэгдэл</th>
                </tr>
              </thead>
              <tbody>
                {recon!.lines.map((line) => (
                  <tr key={line.orderItemId} className="border-t border-slate-800">
                    <td className="py-2">
                      <Link className="text-amber-brand" href={`/orders/${line.orderId}`}>
                        {line.orderNumber}
                      </Link>
                      <p className="text-xs text-slate-500">{line.customerName}</p>
                    </td>
                    <td>
                      {line.sku}
                      <p className="text-xs text-slate-500">{line.nameMn}</p>
                    </td>
                    <td className="text-right">{line.remainingQty}</td>
                    <td className="text-right text-rose-300">{line.currentStock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {delivery && (
        <section className="card">
          <h3 className="font-semibold mb-3">Хүргэлтийн бүс</h3>
          {zones.map((z, idx) => (
            <div key={z.id} className="grid grid-cols-[2fr_1fr_auto] gap-2 items-center mb-2">
              <div>
                <p className="font-medium">{z.nameMn}</p>
                <p className="text-xs text-slate-400">{z.description}</p>
              </div>
              <input
                type="number"
                disabled={!isAdmin}
                value={z.baseDeliveryFeeMnt}
                onChange={(e) => {
                  const next = [...zones];
                  next[idx] = { ...z, baseDeliveryFeeMnt: Number(e.target.value) };
                  setZones(next);
                }}
              />
              {isAdmin ? (
                <button className="btn-ghost" onClick={() => saveZone(z)}>
                  Хадгалах {tugrik(z.baseDeliveryFeeMnt)}
                </button>
              ) : (
                <p className="text-xs text-slate-500 text-right">{tugrik(z.baseDeliveryFeeMnt)}</p>
              )}
            </div>
          ))}
        </section>
        )}
        {delivery && (
        <section className="card">
          <h3 className="font-semibold mb-3">Машины хязгаар (Porter 1.5т · Dump 5т · Manipulator 10т)</h3>
          {vehicles.map((v, idx) => (
            <div key={v.id} className="grid grid-cols-5 gap-2 items-center mb-2 text-sm">
              <p>{v.nameMn}</p>
              <input
                type="number"
                disabled={!isAdmin}
                value={v.maxWeightKg}
                onChange={(e) => {
                  const next = [...vehicles];
                  next[idx] = { ...v, maxWeightKg: Number(e.target.value) };
                  setVehicles(next);
                }}
              />
              <input
                type="number"
                disabled={!isAdmin}
                value={Number(v.maxLengthM)}
                onChange={(e) => {
                  const next = [...vehicles];
                  next[idx] = { ...v, maxLengthM: Number(e.target.value) };
                  setVehicles(next);
                }}
              />
              <input
                type="number"
                disabled={!isAdmin}
                value={Number(v.maxVolumeM3)}
                onChange={(e) => {
                  const next = [...vehicles];
                  next[idx] = { ...v, maxVolumeM3: Number(e.target.value) };
                  setVehicles(next);
                }}
              />
              {isAdmin ? (
                <button className="btn-ghost" onClick={() => saveVehicle(v)}>
                  Хадгалах
                </button>
              ) : (
                <span className="text-xs text-slate-500">Зөвхөн харах</span>
              )}
            </div>
          ))}
        </section>
        )}
        <section className="card flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Ирц</h3>
            <p className="text-sm text-slate-400 mt-1">Менежер ажилтны ирэх, явах цагийг бүртгэнэ.</p>
          </div>
          <Link href="/admin/attendance" className="btn-ghost">
            Ирц нээх
          </Link>
        </section>
        <section className="card flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Цалин</h3>
            <p className="text-sm text-slate-400 mt-1">Сарын үндсэн цалин, бэлтгэлийн урамшуулал, кассын борлуулалтын шагнал.</p>
          </div>
          <Link href="/admin/payroll" className="btn-ghost">
            Цалин нээх
          </Link>
        </section>
        {isAdmin && (
        <section className="card flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Дэлгүүр / агуулах</h3>
            <p className="text-sm text-slate-400 mt-1">Дэлгүүр, агуулах нэмэх. Үлдэгдэл, захиалга, ажилтан агуулах тус бүрээр.</p>
          </div>
          <Link href="/admin/warehouses" className="btn-primary">
            Агуулах удирдах
          </Link>
        </section>
        )}
        {isAdmin && (
        <section className="card flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Хэрэглэгчид</h3>
            <p className="text-sm text-slate-400 mt-1">Ажилтны эрх үүсгэх, засах, идэвхгүй болгох.</p>
          </div>
          <Link href="/admin/users" className="btn-primary">
            Хэрэглэгчид
          </Link>
        </section>
        )}
      </div>
    </Shell>
  );
}
