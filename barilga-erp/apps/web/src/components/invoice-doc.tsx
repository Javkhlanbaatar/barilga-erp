'use client';

import { tugrik } from '@/lib/api';
import type { CompanySettings } from '@/lib/types';

/** The order fields an invoice needs — both the staff order and the buyer's public view provide them. */
export type InvoiceDocOrder = {
  orderNumber: string;
  createdAt?: string;
  customerName: string;
  customerPhone: string;
  customerRegNumber?: string | null;
  deliveryAddress?: string | null;
  deliveryFeeMnt: number;
  unloadingFeeMnt: number;
  timeAdjustmentMnt: number;
  totalMnt: number;
  payments?: Array<{ status: string; amountMnt: number }>;
  createdBy?: { fullName?: string | null; name?: string | null } | null;
  items: Array<{ id: string; quantity: number | string; unitPrice: number; lineTotal: number; product: { nameMn: string; sku: string; unit?: string | null } }>;
};

export type InvoiceMeta = { invoiceNumber: string; createdAt: string; dueDate?: string | null; note?: string | null };

const qty = (v: number | string) => Number(v).toLocaleString('mn-MN', { maximumFractionDigits: 3 });
export const dateTime = (iso?: string | null) =>
  new Intl.DateTimeFormat('mn-MN', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(iso ? new Date(iso) : new Date());
const dateOnly = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export function SellerBlock({ company }: { company: CompanySettings }) {
  return (
    <div className="text-xs leading-5">
      <p className="text-sm font-bold">{company.name || '—'}</p>
      {company.regNumber && <p>РД: {company.regNumber}</p>}
      {company.address && <p>{company.address}</p>}
      {(company.phone || company.email) && <p>{[company.phone, company.email].filter(Boolean).join(' · ')}</p>}
    </div>
  );
}

export function FeeRows({ order, cols }: { order: InvoiceDocOrder; cols: number }) {
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

export function paidAndDue<P extends { status: string; amountMnt: number }>(order: { payments?: P[]; totalMnt: number }) {
  const live = (order.payments ?? []).filter((p) => p.status !== 'EXPIRED' && p.status !== 'FAILED');
  const paid = live.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amountMnt, 0);
  return { live, paid, due: Math.max(0, order.totalMnt - paid) };
}

export function InvoiceDoc({ order, company, invoice }: { order: InvoiceDocOrder; company: CompanySettings; invoice?: InvoiceMeta | null }) {
  const { paid, due } = paidAndDue(order);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-6">
        <SellerBlock company={company} />
        <div className="text-right">
          <h1 className="text-2xl font-bold tracking-wide">НЭХЭМЖЛЭХ</h1>
          <p className="text-sm">№ {invoice?.invoiceNumber ?? order.orderNumber}</p>
          {invoice && <p className="text-xs">Захиалга: {order.orderNumber}</p>}
          <p className="text-xs">Огноо: {dateTime(invoice?.createdAt ?? order.createdAt)}</p>
          {invoice?.dueDate && <p className="text-xs font-semibold">Төлөх хугацаа: {dateOnly(invoice.dueDate)}</p>}
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

      {invoice?.note && <p className="whitespace-pre-line text-xs">{invoice.note}</p>}
      {company.invoiceNote && <p className="whitespace-pre-line text-xs">{company.invoiceNote}</p>}
      {company.bankAccounts.length > 0 && due > 0 && (
        <p className="text-xs">
          Гүйлгээний утга: <b>{invoice?.invoiceNumber ?? order.orderNumber}</b>
        </p>
      )}

      <div className="grid grid-cols-2 gap-10 pt-8 text-xs">
        <p>Нэхэмжилсэн: ______________________ /{order.createdBy?.fullName ?? order.createdBy?.name ?? ''}/</p>
        <p>Хүлээн авсан: ______________________</p>
      </div>
      <p className="pt-4 text-[10px] text-slate-500">Энэ нэхэмжлэх нь И-баримт биш. Албан ёсны баримтыг И-баримтын системээс авна.</p>
    </div>
  );
}
