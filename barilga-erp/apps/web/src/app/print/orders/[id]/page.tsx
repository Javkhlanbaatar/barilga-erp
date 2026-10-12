'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api, tugrik } from '@/lib/api';
import type { CompanySettings, Order } from '@/lib/types';

type Doc = 'invoice' | 'receipt' | 'picklist';

const DELIVERY_MN: Record<string, string> = {
  OUR_DELIVERY: 'Манай хүргэлт',
  DELIVERY: 'Манай хүргэлт',
  SELF_PICKUP: 'Өөрөө авах',
  CUSTOMER_DRIVER: 'Жолооч явуулах',
};
const PAY_MN: Record<string, string> = { CASH: 'Бэлэн', CARD: 'Карт', QPAY: 'QPay' };

const qty = (v: number | string) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
const dateTime = (iso?: string | null) =>
  new Intl.DateTimeFormat('mn-MN', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(iso ? new Date(iso) : new Date());

/** Printable invoice (нэхэмжлэх), sales receipt (баримт) or picking sheet for one order. Opens the print dialog. */
export default function PrintOrderPage() {
  return (
    <Suspense fallback={<p className="p-6 text-slate-500">Уншиж байна…</p>}>
      <PrintOrder />
    </Suspense>
  );
}

function PrintOrder() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const doc = (['invoice', 'receipt', 'picklist'].includes(search.get('doc') ?? '') ? search.get('doc') : 'invoice') as Doc;
  const [order, setOrder] = useState<Order | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<Order>(`/orders/${params.id}`), api<CompanySettings>('/settings/company')])
      .then(([o, c]) => {
        setOrder(o);
        setCompany(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
  }, [params.id]);

  useEffect(() => {
    if (order && company) {
      const t = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(t);
    }
  }, [order, company]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!order || !company) return <p className="p-6 text-slate-500">Уншиж байна…</p>;

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх
        </button>
        {(['invoice', 'receipt', 'picklist'] as Doc[]).map((d) => (
          <a
            key={d}
            href={`?doc=${d}`}
            className={`rounded px-3 py-1 ${d === doc ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white'}`}
          >
            {d === 'invoice' ? 'Нэхэмжлэх' : d === 'receipt' ? 'Баримт' : 'Бэлтгэх хуудас'}
          </a>
        ))}
        {!company.configured && (
          <span className="ml-auto text-amber-700">Компанийн мэдээлэл тохируулаагүй байна (Админ → Тохиргоо).</span>
        )}
      </div>
      {doc === 'invoice' && <Invoice order={order} company={company} />}
      {doc === 'receipt' && <Receipt order={order} company={company} />}
      {doc === 'picklist' && <Picklist order={order} company={company} />}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          aside, nav { display: none !important; }
          body { background: #fff !important; }
          @page { margin: 12mm; }
        }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
      `}</style>
    </div>
  );
}

function SellerBlock({ company }: { company: CompanySettings }) {
  return (
    <div className="text-xs leading-5">
      <p className="text-sm font-bold">{company.name || '—'}</p>
      {company.regNumber && <p>РД: {company.regNumber}</p>}
      {company.address && <p>{company.address}</p>}
      {(company.phone || company.email) && <p>{[company.phone, company.email].filter(Boolean).join(' · ')}</p>}
    </div>
  );
}

function FeeRows({ order, cols }: { order: Order; cols: number }) {
  const fees: Array<[string, number]> = [
    ['Хүргэлтийн төлбөр', order.deliveryFeeMnt],
    ['Буулгалт', order.unloadingFeeMnt],
    ['Цагийн нэмэгдэл/хөнгөлөлт', order.timeAdjustmentMnt],
  ];
  return (
    <>
      {fees
        .filter(([, v]) => v !== 0)
        .map(([label, v]) => (
          <tr key={label}>
            <td colSpan={cols - 1}>{label}</td>
            <td className="text-right">{tugrik(v)}</td>
          </tr>
        ))}
    </>
  );
}

function paidAndDue(order: Order) {
  const live = (order.payments ?? []).filter((p) => p.status !== 'EXPIRED' && p.status !== 'FAILED');
  const paid = live.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amountMnt, 0);
  return { live, paid, due: Math.max(0, order.totalMnt - paid) };
}

function Invoice({ order, company }: { order: Order; company: CompanySettings }) {
  const { paid, due } = paidAndDue(order);
  return (
    <div className="mx-auto max-w-[800px] p-8 space-y-5">
      <div className="flex items-start justify-between gap-6">
        <SellerBlock company={company} />
        <div className="text-right">
          <h1 className="text-2xl font-bold tracking-wide">НЭХЭМЖЛЭХ</h1>
          <p className="text-sm">№ {order.orderNumber}</p>
          <p className="text-xs">Огноо: {dateTime(order.createdAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-xs">
        <div className="rounded border border-slate-400 p-3">
          <p className="mb-1 font-semibold">Нэхэмжлэгч</p>
          <p>{company.name || '—'}</p>
          {company.bankAccounts.map((b) => (
            <p key={b.accountNumber}>
              {b.bankName}: <span className="font-mono">{b.accountNumber}</span>
              {b.accountName ? ` (${b.accountName})` : ''}
            </p>
          ))}
        </div>
        <div className="rounded border border-slate-400 p-3">
          <p className="mb-1 font-semibold">Төлөгч</p>
          <p>{order.customerName}</p>
          {order.customerRegNumber && <p>РД: {order.customerRegNumber}</p>}
          <p>Утас: {order.customerPhone}</p>
          {order.deliveryAddress && <p>Хаяг: {order.deliveryAddress}</p>}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th className="w-8">№</th>
            <th>Барааны нэр</th>
            <th>Код</th>
            <th>Нэгж</th>
            <th className="text-right">Тоо</th>
            <th className="text-right">Нэгж үнэ</th>
            <th className="text-right">Дүн</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i, idx) => (
            <tr key={i.id}>
              <td>{idx + 1}</td>
              <td>{i.product.nameMn}</td>
              <td className="font-mono">{i.product.sku}</td>
              <td>{i.product.unit}</td>
              <td className="text-right">{qty(i.quantity)}</td>
              <td className="text-right">{tugrik(i.unitPrice)}</td>
              <td className="text-right">{tugrik(i.lineTotal)}</td>
            </tr>
          ))}
          <FeeRows order={order} cols={7} />
          <tr>
            <td colSpan={6} className="text-right font-bold">
              Нийт дүн
            </td>
            <td className="text-right font-bold">{tugrik(order.totalMnt)}</td>
          </tr>
          {paid > 0 && (
            <tr>
              <td colSpan={6} className="text-right">
                Төлсөн
              </td>
              <td className="text-right">{tugrik(paid)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={6} className="text-right font-bold">
              Төлөх үлдэгдэл
            </td>
            <td className="text-right font-bold">{tugrik(due)}</td>
          </tr>
        </tbody>
      </table>

      {company.invoiceNote && <p className="whitespace-pre-line text-xs">{company.invoiceNote}</p>}

      <div className="grid grid-cols-2 gap-10 pt-8 text-xs">
        <p>Нэхэмжилсэн: ______________________ /{order.createdBy?.fullName ?? order.createdBy?.name ?? ''}/</p>
        <p>Хүлээн авсан: ______________________</p>
      </div>
      <p className="pt-4 text-[10px] text-slate-500">Энэ нэхэмжлэх нь И-баримт биш. Албан ёсны баримтыг И-баримтын системээс авна.</p>
    </div>
  );
}

function Receipt({ order, company }: { order: Order; company: CompanySettings }) {
  const { live, paid, due } = paidAndDue(order);
  return (
    <div className="mx-auto w-[300px] p-3 font-mono text-[12px] leading-5">
      <p className="text-center text-sm font-bold">{company.name || 'Борлуулалтын баримт'}</p>
      {company.regNumber && <p className="text-center">РД: {company.regNumber}</p>}
      {company.phone && <p className="text-center">{company.phone}</p>}
      <p className="my-1 border-t border-dashed border-black" />
      <p>Баримт: {order.orderNumber}</p>
      <p>Огноо: {dateTime(order.createdAt)}</p>
      <p>Кассчин: {order.createdBy?.fullName ?? order.createdBy?.name ?? ''}</p>
      <p>Харилцагч: {order.customerName}</p>
      <p className="my-1 border-t border-dashed border-black" />
      {order.items.map((i) => (
        <div key={i.id}>
          <p>{i.product.nameMn}</p>
          <p className="flex justify-between">
            <span>
              {qty(i.quantity)} × {tugrik(i.unitPrice)}
            </span>
            <span>{tugrik(i.lineTotal)}</span>
          </p>
        </div>
      ))}
      {order.deliveryFeeMnt !== 0 && (
        <p className="flex justify-between">
          <span>Хүргэлт</span>
          <span>{tugrik(order.deliveryFeeMnt)}</span>
        </p>
      )}
      {order.unloadingFeeMnt !== 0 && (
        <p className="flex justify-between">
          <span>Буулгалт</span>
          <span>{tugrik(order.unloadingFeeMnt)}</span>
        </p>
      )}
      {order.timeAdjustmentMnt !== 0 && (
        <p className="flex justify-between">
          <span>Цагийн нөхцөл</span>
          <span>{tugrik(order.timeAdjustmentMnt)}</span>
        </p>
      )}
      <p className="my-1 border-t border-dashed border-black" />
      <p className="flex justify-between font-bold">
        <span>НИЙТ</span>
        <span>{tugrik(order.totalMnt)}</span>
      </p>
      {live
        .filter((p) => p.status === 'PAID')
        .map((p) => (
          <p key={p.id} className="flex justify-between">
            <span>{PAY_MN[p.method ?? p.provider ?? ''] ?? p.method}</span>
            <span>{tugrik(p.amountMnt)}</span>
          </p>
        ))}
      {due > 0 && (
        <p className="flex justify-between">
          <span>Үлдэгдэл</span>
          <span>{tugrik(due)}</span>
        </p>
      )}
      {paid >= order.totalMnt && <p className="text-center">Төлбөр бүрэн төлөгдсөн</p>}
      {order.lottery && <p className="mt-1">И-баримт сугалаа: {order.lottery}</p>}
      <p className="my-1 border-t border-dashed border-black" />
      {company.receiptFooter && <p className="whitespace-pre-line text-center">{company.receiptFooter}</p>}
      <p className="text-center">Баярлалаа!</p>
    </div>
  );
}

function Picklist({ order, company }: { order: Order; company: CompanySettings }) {
  return (
    <div className="mx-auto max-w-[800px] p-8 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">БАРАА БЭЛТГЭХ ХУУДАС</h1>
          <p className="text-sm">
            Захиалга № {order.orderNumber} · {dateTime(order.createdAt)}
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="font-semibold">{company.name}</p>
          <p>Агуулах: {order.warehouse?.name ?? '—'}</p>
          <p>Хэвлэсэн: {dateTime()}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs">
        <div className="rounded border border-slate-400 p-3">
          <p>
            Харилцагч: <b>{order.customerName}</b> · {order.customerPhone}
          </p>
          <p>Хүргэлт: {DELIVERY_MN[order.deliveryMethod] ?? order.deliveryMethod}</p>
          {order.deliveryAddress && <p>Хаяг: {order.deliveryAddress}</p>}
        </div>
        <div className="rounded border border-slate-400 p-3">
          <p>
            Нийт жин: {qty(order.totalWeightKg)} кг · Эзлэхүүн: {qty(order.totalVolumeM3)} м³
          </p>
          {order.vehicleNumber && (
            <p>
              Машин: {order.vehicleNumber} {order.driverPhone ? `· ${order.driverPhone}` : ''}
            </p>
          )}
          {order.notes && <p>Тэмдэглэл: {order.notes}</p>}
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th className="w-10">✓</th>
            <th className="w-8">№</th>
            <th>Код</th>
            <th>Барааны нэр</th>
            <th className="text-right">Тоо</th>
            <th>Нэгж</th>
            <th>Бэлдсэн</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i, idx) => (
            <tr key={i.id}>
              <td className="text-center text-lg">{i.pickedAt ? '☑' : '☐'}</td>
              <td>{idx + 1}</td>
              <td className="font-mono">{i.product.sku}</td>
              <td>
                {i.product.nameMn}
                {i.sourceType === 'EXTERNAL_SUPPLIER' ? ' (нийлүүлэгчээс)' : ''}
              </td>
              <td className="text-right text-base font-bold">{qty(i.quantity)}</td>
              <td>{i.product.unit}</td>
              <td className="w-32">{i.pickedBy?.fullName ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-3 gap-6 pt-10 text-xs">
        <p>Бэлтгэсэн: __________________</p>
        <p>Шалгасан: __________________</p>
        <p>Хүлээн авсан: __________________</p>
      </div>
    </div>
  );
}
