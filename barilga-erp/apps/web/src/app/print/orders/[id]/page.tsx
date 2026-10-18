'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api, tugrik } from '@/lib/api';
import { Blank, BlankRows, DocNote, FeeRows, InvoiceDoc, InvoiceMeta, LogoMark, SellerBlock, Signatures, Watermark, paidAndDue } from '@/components/invoice-doc';
import { TOP_ROLES, hasRole } from '@/lib/rbac';
import { companionLines, type AuthUser, type CompanySettings, type DocTemplate, type Order } from '@/lib/types';

type Doc = 'invoice' | 'receipt' | 'issueNote' | 'picklist';
type Layout = { paper: 'A4' | 'A5' | '80MM'; orientation: 'portrait' | 'landscape'; copies: number };
type PrintSettings = Record<Doc, Layout>;

const DOCS: Array<[Doc, string]> = [
  ['invoice', 'Нэхэмжлэх'],
  ['receipt', 'Баримт'],
  ['issueNote', 'Зарлагын баримт'],
  ['picklist', 'Бэлтгэх хуудас'],
];

const DELIVERY_MN: Record<string, string> = {
  OUR_DELIVERY: 'Манай хүргэлт',
  DELIVERY: 'Манай хүргэлт',
  SELF_PICKUP: 'Өөрөө авах',
  CUSTOMER_DRIVER: 'Харилцагчийн жолооч',
};
const PAY_MN: Record<string, string> = { CASH: 'Бэлэн', CARD: 'Карт', QPAY: 'QPay', CREDIT: 'Дараа төлөх', TRANSFER: 'Шилжүүлэг', OFFSET: 'Тооцоонд хасагдсан' };

/** Printable width (mm) inside the page margins, and the CSS @page size, per paper layout. */
function pageGeometry(l: Layout) {
  if (l.paper === '80MM') return { width: 72, page: '80mm auto', margin: '3mm', small: true };
  const landscape = l.orientation === 'landscape';
  if (l.paper === 'A5') return { width: landscape ? 190 : 128, page: `A5 ${l.orientation}`, margin: '10mm', small: true };
  return { width: landscape ? 273 : 186, page: `A4 ${l.orientation}`, margin: '12mm', small: false };
}

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

/**
 * Printable invoice (нэхэмжлэх), receipt (баримт), goods issue note (зарлагын баримт) or picking sheet for one
 * order. Paper size, orientation and copies come from the admin print settings, so nobody picks them per print.
 */
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
  const doc = (DOCS.some(([d]) => d === search.get('doc')) ? search.get('doc') : 'invoice') as Doc;
  const [order, setOrder] = useState<Order | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [layouts, setLayouts] = useState<PrintSettings | null>(null);
  const [invoice, setInvoice] = useState<InvoiceMeta | null>(null);
  const [templates, setTemplates] = useState<Record<Doc, DocTemplate> | null>(null);
  const [error, setError] = useState('');
  // ?edit=1: the page can be typed on before printing (one-off changes, nothing is saved) and does not print
  // by itself. ?blank=1: the buyer's details and a few extra rows are left empty to fill in by hand.
  const [editing, setEditing] = useState(search.get('edit') === '1');
  // Changing the wording (one-off edits, blank copies) is for admin and the general manager.
  const [canCustomize, setCanCustomize] = useState(false);
  useEffect(() => {
    try {
      const me = JSON.parse(localStorage.getItem('barilga_user') ?? 'null') as AuthUser | null;
      const allowed = hasRole(me?.role, TOP_ROLES);
      setCanCustomize(allowed);
      if (!allowed) setEditing(false);
    } catch {
      setEditing(false);
    }
  }, []);
  const blank = search.get('blank') === '1' && canCustomize;

  useEffect(() => {
    Promise.all([
      api<Order>(`/orders/${params.id}`),
      api<CompanySettings>('/settings/company'),
      api<PrintSettings>('/settings/print'),
      api<Record<Doc, DocTemplate>>('/settings/documents').catch(() => null),
    ])
      .then(([o, c, p, t]) => {
        setOrder(o);
        setCompany(c);
        setLayouts(p);
        setTemplates(t);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй'));
    // The invoice number and due date, when one was sent for this order (the module may be off).
    api<InvoiceMeta | null>(`/invoices/order/${params.id}`).then(setInvoice).catch(() => setInvoice(null));
  }, [params.id]);

  useEffect(() => {
    if (order && company && layouts && search.get('edit') !== '1') {
      const t = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(t);
    }
  }, [order, company, layouts, search]);

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!order || !company || !layouts) return <p className="p-6 text-slate-500">Уншиж байна…</p>;

  const layout = layouts[doc];
  const geo = pageGeometry(layout);
  const base: DocTemplate = templates?.[doc] ?? { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: [], stamp: false, showPrices: true };
  const tpl: DocTemplate = blank ? { ...base, blankBuyer: true, blankRows: Math.max(base.blankRows, 5) } : base;
  const body = (
    <>
      {doc === 'invoice' && <InvoiceDoc order={order} company={company} invoice={invoice} template={tpl} />}
      {doc === 'receipt' && <Receipt order={order} company={company} t={tpl} />}
      {doc === 'issueNote' && <IssueNote order={order} company={company} t={tpl} />}
      {doc === 'picklist' && <Picklist order={order} company={company} t={tpl} />}
    </>
  );

  return (
    <div className="print-doc min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1" onClick={() => window.print()}>
          Хэвлэх
        </button>
        {DOCS.map(([d, label]) => (
          <a
            key={d}
            href={`?doc=${d}`}
            className={`rounded px-3 py-1 ${d === doc ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white'}`}
          >
            {label}
          </a>
        ))}
        {canCustomize && (
        <button
          className={`rounded px-3 py-1 ${editing ? 'bg-amber-500 text-black' : 'border border-slate-300 bg-white'}`}
          onClick={() => setEditing((v) => !v)}
          title="Хэвлэхийн өмнө баримт дээрх аль ч бичгийг шууд засна (хадгалагдахгүй)"
        >
          ✎ {editing ? 'Засаж байна — дуусгах' : 'Засаад хэвлэх'}
        </button>
        )}
        {canCustomize && (
        <a className="rounded border border-slate-300 bg-white px-3 py-1" href={`?doc=${doc}${blank ? '' : '&blank=1'}&edit=1`}>
          {blank ? 'Энгийн хувилбар' : 'Хоосон талбартай'}
        </a>
        )}
        <span className="text-slate-500">
          {layout.paper === '80MM' ? '80мм' : `${layout.paper} ${layout.orientation === 'landscape' ? 'хэвтээ' : 'босоо'}`} ·{' '}
          {layout.copies} хувь
        </span>
        {!company.configured && (
          <span className="ml-auto text-amber-700">Компанийн мэдээлэл тохируулаагүй байна (Админ → Компанийн мэдээлэл).</span>
        )}
      </div>
      {Array.from({ length: layout.copies }, (_, i) => (
        <section
          key={i}
          className={`print-copy mx-auto py-6 ${geo.small ? 'print-small' : ''} ${editing ? 'editing' : ''}`}
          style={{ width: `${geo.width}mm`, breakAfter: i < layout.copies - 1 ? 'page' : 'auto' }}
          contentEditable={editing}
          suppressContentEditableWarning
        >
          {body}
        </section>
      ))}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          aside, nav { display: none !important; }
          body { background: #fff !important; }
          .print-copy { padding: 0 !important; }
          @page { size: ${geo.page}; margin: ${geo.margin}; }
        }
        .print-doc table { border-collapse: collapse; width: 100%; }
        .print-doc th, .print-doc td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
        .print-doc .print-small th, .print-doc .print-small td { padding: 2px 4px; font-size: 10px; }
        .print-doc th { background: #f1f5f9; text-align: left; }
        @media screen { .print-copy.editing { outline: 2px dashed #f59e0b; outline-offset: 6px; cursor: text; } }
      `}</style>
      {editing && (
        <p className="no-print fixed bottom-3 left-1/2 -translate-x-1/2 rounded bg-amber-500 px-3 py-1.5 text-xs text-black shadow">
          Баримт дээр дарж бичгийг засна. Засвар хадгалагдахгүй — зөвхөн энэ удаагийн хэвлэлтэд.
        </p>
      )}
    </div>
  );
}

function Receipt({ order, company, t }: { order: Order; company: CompanySettings; t: DocTemplate }) {
  const { live, paid, due } = paidAndDue(order);
  return (
    <div className="relative font-mono text-[12px] leading-5">
      <Watermark company={company} />
      <div className="flex justify-center">
        <LogoMark company={company} className="h-10" />
      </div>
      <p className="text-center text-sm font-bold">{company.name || 'Борлуулалтын баримт'}</p>
      {t.title && <p className="text-center font-bold">{t.title}</p>}
      {company.regNumber && <p className="text-center">РД: {company.regNumber}</p>}
      {company.phone && <p className="text-center">{company.phone}</p>}
      <p className="my-1 border-t border-dashed border-black" />
      <p>Баримт: {order.orderNumber}</p>
      <p>Огноо: {dateTime(order.createdAt)}</p>
      <p>Кассчин: {order.createdBy?.fullName ?? order.createdBy?.name ?? ''}</p>
      {t.blankBuyer ? <Blank label="Харилцагч" wide /> : <p>Харилцагч: {order.customerName}</p>}
      {t.headerNote && <p className="whitespace-pre-line">{t.headerNote}</p>}
      <p className="my-1 border-t border-dashed border-black" />
      {order.items.map((i) => (
        <div key={i.id}>
          <p>{i.product.nameMn}</p>
          {companionLines(i.product.companions, Number(i.quantity)).map((c) => (
            <p key={c} className="pl-2">+ {c}</p>
          ))}
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
        .filter((p) => p.status === 'PAID' && p.amountMnt > 0)
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
      {t.footerNote && <p className="whitespace-pre-line text-center">{t.footerNote}</p>}
      {t.signatures.map((s) => (
        <p key={s} className="pt-3">
          {s}: ____________
        </p>
      ))}
      <p className="text-center">Баярлалаа!</p>
    </div>
  );
}

function Picklist({ order, company, t }: { order: Order; company: CompanySettings; t: DocTemplate }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">{t.title || 'БАРАА БЭЛТГЭХ ХУУДАС'}</h1>
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
                {companionLines(i.product.companions, Number(i.quantity)).map((c) => (
                  <p key={c} className="font-semibold">+ дагалдах: {c}</p>
                ))}
              </td>
              <td className="text-right text-base font-bold">{qty(i.quantity)}</td>
              <td>{i.product.unit}</td>
              <td className="w-32">{i.pickedBy?.fullName ?? ''}</td>
            </tr>
          ))}
          <BlankRows n={t.blankRows} cols={7} />
        </tbody>
      </table>
      <DocNote text={t.footerNote} />
      <Signatures names={t.signatures} stamp={t.stamp} />
    </div>
  );
}

/** Goods issue note: what leaves the warehouse for this order, numbered like the invoice. */
function IssueNote({ order, company, t }: { order: Order; company: CompanySettings; t: DocTemplate }) {
  const goods = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  const prices = t.showPrices;
  const cols = prices ? 7 : 5;
  return (
    <div className="relative space-y-3">
      <Watermark company={company} />
      <div className="flex items-start justify-between gap-4">
        <SellerBlock company={company} />
        <div className="text-right">
          <h1 className="text-xl font-bold tracking-wide">{t.title || 'ЗАРЛАГЫН БАРИМТ'}</h1>
          <p className="text-sm">№ {order.orderNumber}</p>
          <p className="text-xs">Огноо: {dateTime(order.completedAt ?? order.createdAt)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <p>
          Зарлагадсан агуулах: <b>{order.warehouse?.name ?? '—'}</b>
        </p>
        {t.blankBuyer ? (
          <Blank label="Хүлээн авагч" wide />
        ) : (
          <p>
            Хүлээн авагч: <b>{order.customerName}</b>
            {order.customerRegNumber ? ` (РД ${order.customerRegNumber})` : ''} · {order.customerPhone}
          </p>
        )}
        <p>Хүргэлт: {DELIVERY_MN[order.deliveryMethod] ?? order.deliveryMethod}</p>
        {order.vehicleNumber && (
          <p>
            Машин: {order.vehicleNumber}
            {order.driverPhone ? ` · ${order.driverPhone}` : ''}
          </p>
        )}
      </div>
      <DocNote text={t.headerNote} />
      <table>
        <thead>
          <tr>
            <th className="w-8">№</th>
            <th>Барааны нэр</th>
            <th>Код</th>
            <th>Нэгж</th>
            <th className="text-right">Тоо</th>
            {prices && <th className="text-right">Нэгж үнэ</th>}
            {prices && <th className="text-right">Дүн</th>}
          </tr>
        </thead>
        <tbody>
          {order.items.map((i, idx) => (
            <tr key={i.id}>
              <td>{idx + 1}</td>
              <td>
                {i.product.nameMn}
                {companionLines(i.product.companions, Number(i.quantity)).map((c) => (
                  <p key={c} className="text-[10px]">+ дагалдах: {c}</p>
                ))}
              </td>
              <td className="font-mono">{i.product.sku}</td>
              <td>{i.product.unit}</td>
              <td className="text-right font-semibold">{qty(i.quantity)}</td>
              {prices && <td className="text-right">{tugrik(i.unitPrice)}</td>}
              {prices && <td className="text-right">{tugrik(i.lineTotal)}</td>}
            </tr>
          ))}
          <BlankRows n={t.blankRows} cols={cols} />
          {prices && (
            <tr>
              <td colSpan={6} className="text-right font-bold">
                Барааны дүн
              </td>
              <td className="text-right font-bold">{tugrik(goods)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <DocNote text={t.footerNote} />
      <Signatures names={t.signatures} stamp={t.stamp} />
    </div>
  );
}
