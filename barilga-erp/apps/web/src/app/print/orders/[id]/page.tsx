'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { InvoiceDoc, InvoiceMeta } from '@/components/invoice-doc';
import { IssueNote, Picklist, Receipt } from '@/components/print-docs';
import { TOP_ROLES, hasRole } from '@/lib/rbac';
import type { AuthUser, CompanySettings, DocTemplate, Order } from '@/lib/types';

type Doc = 'invoice' | 'receipt' | 'issueNote' | 'picklist';
type Layout = { paper: 'A4' | 'A5' | '80MM'; orientation: 'portrait' | 'landscape'; copies: number };
type PrintSettings = Record<Doc, Layout>;

const DOCS: Array<[Doc, string]> = [
  ['invoice', 'Нэхэмжлэх'],
  ['receipt', 'Баримт'],
  ['issueNote', 'Зарлагын баримт'],
  ['picklist', 'Бэлтгэх хуудас'],
];


/** Printable width (mm) inside the page margins, and the CSS @page size, per paper layout. */
function pageGeometry(l: Layout) {
  if (l.paper === '80MM') return { width: 72, page: '80mm auto', margin: '3mm', small: true };
  const landscape = l.orientation === 'landscape';
  if (l.paper === 'A5') return { width: landscape ? 190 : 128, page: `A5 ${l.orientation}`, margin: '10mm', small: true };
  return { width: landscape ? 273 : 186, page: `A4 ${l.orientation}`, margin: '12mm', small: false };
}


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
  const base: DocTemplate = templates?.[doc] ?? { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: [], stamp: false, showPrices: true, hidden: [] };
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
