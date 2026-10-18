'use client';

import { mediaUrl, tugrik } from '@/lib/api';
import { BlankRowsControl, EditText, FlagPart, Part, SignatureNames, shown, useDesign } from '@/components/doc-design';
import type { CompanySettings, DocTemplate } from '@/lib/types';

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

/**
 * The company logo printed faintly across a document (admin: Компанийн мэдээлэл → лого). Drawn above the
 * content with very low opacity so table backgrounds cannot hide it; it never catches clicks. The parent
 * must be positioned (relative).
 */
export function Watermark({ company }: { company: Pick<CompanySettings, 'logoUrl' | 'watermark'> }) {
  const url = company.watermark === false ? null : mediaUrl(company.logoUrl);
  if (!url) return null;
  return (
    <div aria-hidden className="watermark pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="w-[60%] max-w-[420px] -rotate-12 object-contain opacity-[0.08]" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }} />
    </div>
  );
}

/** Small logo at the top of documents, when one was uploaded. */
export function LogoMark({ company, className = 'h-12' }: { company: Pick<CompanySettings, 'logoUrl'>; className?: string }) {
  const url = mediaUrl(company.logoUrl);
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={`${className} w-auto object-contain`} />;
}

export function SellerBlock({ company }: { company: CompanySettings }) {
  return (
    <div className="text-xs leading-5">
      <LogoMark company={company} className="mb-1 h-10" />
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

/** Free text under the heading or above the signatures (typed in place in the template editor). */
export function DocNote({ field, t, className = '' }: { field: 'headerNote' | 'footerNote'; t?: DocTemplate; className?: string }) {
  const design = useDesign();
  const text = (design?.t ?? t)?.[field];
  if (!design && !text) return null;
  return (
    <Part k={field} label={field === 'headerNote' ? 'Дээд текст' : 'Доод текст'} t={t}>
      <p className={`text-xs ${className}`}>
        <EditText
          field={field}
          t={t}
          multiline
          placeholder={field === 'headerNote' ? 'Гарчгийн доор гарах текст…' : 'Доод талд гарах текст (нөхцөл, анхааруулга)…'}
        />
      </p>
    </Part>
  );
}

/** A line to fill in by hand. */
export function Blank({ label, wide = false }: { label: string; wide?: boolean }) {
  return (
    <p className="flex items-end gap-1">
      <span className="whitespace-nowrap">{label}:</span>
      <span className={`border-b border-dotted border-black ${wide ? 'flex-1' : 'w-40'}`}>&nbsp;</span>
    </p>
  );
}

/** Empty table rows after the goods, for lines added by hand. */
export function BlankRows({ n, cols }: { n: number; cols: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={`blank-${i}`}>
          {Array.from({ length: cols }, (_, j) => (
            <td key={j}>&nbsp;</td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Signature lines (and the stamp box) at the foot of a document; both can be switched off. */
export function Signatures({ t, fallback, signer }: { t?: DocTemplate; fallback?: string[]; signer?: string }) {
  const design = useDesign();
  const tpl = design?.t ?? t;
  const names = tpl?.signatures ?? fallback ?? [];
  if (!design && (!names.length || !shown(tpl, 'signatures')) && !tpl?.stamp) return null;
  return (
    <div className="flex items-end justify-between gap-6 pt-8 text-xs">
      <div className="flex-1">
        <Part k="signatures" label="Гарын үсэг" t={t}>
          <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${Math.max(1, names.length + (design ? 1 : 0))}, minmax(0, 1fr))` }}>
            <SignatureNames names={names} signer={signer} />
          </div>
        </Part>
      </div>
      <FlagPart field="stamp" label="Тэмдэг" t={t}>
        <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full border border-dashed border-slate-500 text-[10px] text-slate-500">Тэмдэг</div>
      </FlagPart>
    </div>
  );
}

export function InvoiceDoc({
  order,
  company,
  invoice,
  template,
}: {
  order: InvoiceDocOrder;
  company: CompanySettings;
  invoice?: InvoiceMeta | null;
  template?: DocTemplate;
}) {
  const { paid, due } = paidAndDue(order);
  const design = useDesign();
  const t = design?.t ?? template;
  // A walk-in sale has no real buyer: print dotted lines so the company name, РД… are written by hand.
  const unknownBuyer = !order.customerName?.trim() || order.customerName.trim() === 'Энгийн харилцагч';
  const blankBuyer = Boolean(t?.blankBuyer) || (unknownBuyer && !design);
  return (
    <div className="relative space-y-5">
      <Part k="watermark" label="Усан тэмдэг (лого)" t={template}>
        <Watermark company={company} />
      </Part>
      <div className="flex items-start justify-between gap-6">
        <Part k="seller" label="Компани" required t={template}>
          <SellerBlock company={company} />
        </Part>
        <div className="text-right">
          <Part k="title" label="Гарчиг" required t={template}>
            <h1 className="text-2xl font-bold tracking-wide">
              <EditText field="title" fallback="НЭХЭМЖЛЭХ" t={template} />
            </h1>
          </Part>
          <Part k="number" label="Дугаар, огноо" required t={template}>
            <p className="text-sm">№ {invoice?.invoiceNumber ?? order.orderNumber}</p>
            {invoice && <p className="text-xs">Захиалга: {order.orderNumber}</p>}
            <p className="text-xs">Огноо: {dateTime(invoice?.createdAt ?? order.createdAt)}</p>
          </Part>
          {invoice?.dueDate && (
            <Part k="dueDate" label="Төлөх хугацаа" t={template}>
              <p className="text-xs font-semibold">Төлөх хугацаа: {dateOnly(invoice.dueDate)}</p>
            </Part>
          )}
        </div>
      </div>

      <DocNote field="headerNote" t={template} />

      <div className="grid grid-cols-2 gap-4 text-xs">
        <Part k="bank" label="Нэхэмжлэгч, данс" t={template}>
          <div className="h-full rounded border border-slate-400 p-3">
            <p className="mb-1 font-semibold">Нэхэмжлэгч</p>
            <p>{company.name || '—'}</p>
            {company.bankAccounts.map((b) => (
              <p key={b.accountNumber}>
                {b.bankName}: <span className="font-mono">{b.accountNumber}</span>
                {b.accountName ? ` (${b.accountName})` : ''}
              </p>
            ))}
          </div>
        </Part>
        <Part k="buyer" label="Төлөгч" t={template}>
          <div className="h-full rounded border border-slate-400 p-3">
            <p className="mb-1 font-semibold">
              Төлөгч{' '}
              <FlagPart field="blankBuyer" label="Үргэлж хоосон (гараар)" t={template} inline indicator>
                <span className="text-[10px] font-normal text-slate-500">(гараар бөглөнө)</span>
              </FlagPart>
            </p>
            {blankBuyer ? (
              <div className="space-y-2 pt-1">
                <Blank label="Байгууллага / нэр" wide />
                <Blank label="РД" wide />
                <Blank label="Утас" wide />
                <Blank label="Хаяг" wide />
              </div>
            ) : (
              <>
                <p>{order.customerName}</p>
                {order.customerRegNumber && <p>РД: {order.customerRegNumber}</p>}
                <p>Утас: {order.customerPhone}</p>
                {order.deliveryAddress && <p>Хаяг: {order.deliveryAddress}</p>}
              </>
            )}
          </div>
        </Part>
      </div>

      <Part k="items" label="Бараа, дүн" required t={template}>
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
            <BlankRows n={t?.blankRows ?? 0} cols={7} />
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
        <BlankRowsControl />
      </Part>

      {invoice?.note && <p className="whitespace-pre-line text-xs">{invoice.note}</p>}
      {company.invoiceNote && (
        <Part k="companyNote" label="Компанийн тэмдэглэл" t={template}>
          <p className="whitespace-pre-line text-xs">{company.invoiceNote}</p>
        </Part>
      )}
      {company.bankAccounts.length > 0 && (due > 0 || design) && (
        <Part k="paymentRef" label="Гүйлгээний утга" t={template}>
          <p className="text-xs">
            Гүйлгээний утга: <b>{invoice?.invoiceNumber ?? order.orderNumber}</b>
          </p>
        </Part>
      )}

      <DocNote field="footerNote" t={template} />
      <Signatures t={template} fallback={['Нэхэмжилсэн', 'Хүлээн авсан']} signer={order.createdBy?.fullName ?? order.createdBy?.name ?? ''} />
      <Part k="disclaimer" label="«И-баримт биш» тайлбар" t={template}>
        <p className="pt-4 text-[10px] text-slate-500">Энэ нэхэмжлэх нь И-баримт биш. Албан ёсны баримтыг И-баримтын системээс авна.</p>
      </Part>
    </div>
  );
}
