'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { CustomerPicker } from '@/components/customer-picker';
import { isUnknownBuyer, paymentReference } from '@/components/invoice-doc';
import { Customer, INVOICE_STATE_LABEL, Invoice, Order } from '@/lib/types';

const plusDays = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(Date.now() + n * 86_400_000));
const day = (iso: string) => new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(iso));
const when = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const VIA_MN: Record<string, string> = { LINK: 'холбоосоор', EMAIL: 'имэйлээр', PRINT: 'хэвлэж' };

type Via = 'LINK' | 'EMAIL' | 'PRINT';
/** POST /invoices/:id/cancel also cancels the order when nothing on it was paid. */
type CancelResult = Invoice & { orderCancelled?: boolean; orderNote?: string | null };

export const STATE_CLASS: Record<string, string> = {
  PAID: 'border-emerald-600 text-emerald-300',
  OVERDUE: 'border-red-600 text-red-300',
  PARTIAL: 'border-amber-600 text-amber-300',
  VIEWED: 'border-sky-600 text-sky-300',
  SENT: 'border-indigo-600 text-indigo-300',
  DRAFT: 'border-slate-600 text-slate-300',
  CANCELLED: 'border-slate-700 text-slate-500',
};

/**
 * The order's invoice: make it, send it (share, SMS, link, e-mail, print), put the buyer on it later, and see
 * whether the buyer opened and paid it. The payment reference is always the invoice number (NH-…).
 */
export function InvoicePanel({ order, canManage, onOrder }: { order: Order; canManage: boolean; onOrder: (o: Order) => void }) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [changingBuyer, setChangingBuyer] = useState(false);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState(order.customerPhone ?? '');
  const [due, setDue] = useState(plusDays(7));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const row = await api<Invoice | null>(`/invoices/order/${order.id}`);
      setInv(row);
      if (row) {
        setEmail(row.recipientEmail ?? '');
        setPhone(row.recipientPhone ?? '');
        setDue(row.dueDate ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(row.dueDate)) : plusDays(7));
        setNote(row.note ?? '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoaded(true);
    }
  }, [order.id]);

  useEffect(() => {
    void load();
  }, [load, order.status, order.customerId]);

  const link = inv?.token ? `${window.location.origin}/invoice/${inv.token}` : '';
  const reference = inv ? paymentReference(inv, order) : '';
  const amount = inv && inv.owedMnt > 0 ? inv.owedMnt : order.totalMnt;
  /** The message that goes with the link (share sheet, SMS, copied text). */
  const shareText = inv
    ? [
        `Нэхэмжлэх ${inv.invoiceNumber} — ${tugrik(amount)}.`,
        inv.dueDate ? `Төлөх хугацаа: ${day(inv.dueDate)}.` : '',
        `Гүйлгээний утга: ${reference}.`,
      ]
        .filter(Boolean)
        .join(' ')
    : '';

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/invoices', {
        method: 'POST',
        body: JSON.stringify({ orderId: order.id, recipientEmail: email.trim(), recipientPhone: phone.trim(), dueDate: due, note }),
      });
      setEditing(false);
      setMsg(inv ? 'Хадгаллаа.' : 'Нэхэмжлэх үүслээ — доорх товчоор илгээнэ үү.');
      await load();
      // A new invoice changes the page too: the transfer to look for now carries its NH number. (If only this
      // refresh fails, the invoice is still made: no error for it.)
      if (!inv) await api<Order>(`/orders/${order.id}`).then(onOrder, () => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  /** Records how it was sent (the server sends nothing itself). */
  async function sent(via: Via) {
    if (!inv) return;
    try {
      await api(`/invoices/${inv.id}/sent`, { method: 'POST', body: JSON.stringify({ via }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Бүртгэж чадсангүй');
    }
  }

  async function copyLink() {
    if (!inv || !link) return;
    setError('');
    const text = `${shareText} ${link}`;
    try {
      await navigator.clipboard.writeText(text);
      setMsg('Холбоос хуулагдлаа — Viber, Messenger, SMS-д буулгаж (paste) илгээнэ үү.');
    } catch {
      window.prompt('Холбоосыг хуулж илгээнэ үү:', text);
    }
    await sent('LINK');
  }

  /** The phone's own share sheet (Viber, Messenger, Gmail…); where there is none, the link is copied instead. */
  async function share() {
    if (!inv || !link) return;
    setError('');
    if (typeof navigator.share !== 'function') {
      await copyLink();
      return;
    }
    try {
      await navigator.share({ title: `Нэхэмжлэх ${inv.invoiceNumber}`, text: shareText, url: link });
      setMsg('Хуваалцлаа.');
      await sent('LINK');
    } catch (err) {
      // Closed the share sheet: nothing was sent.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      await copyLink();
    }
  }

  async function sms() {
    if (!inv || !link) return;
    setError('');
    const to = (inv.recipientPhone ?? order.customerPhone ?? '').replace(/[^\d+]/g, '');
    // «?&body=» works on both Android and iPhone.
    window.location.href = `sms:${to}?&body=${encodeURIComponent(`${shareText} ${link}`)}`;
    await sent('LINK');
  }

  async function mail() {
    if (!inv || !link) return;
    if (!inv.recipientEmail) {
      setEditing(true);
      setMsg('');
      setError('Имэйлээр илгээхийн тулд эхлээд имэйл хаяг оруулаад «Хадгалах» дарна уу.');
      return;
    }
    setError('');
    const subject = `Нэхэмжлэх ${inv.invoiceNumber}`;
    const body = [
      `Сайн байна уу${isUnknownBuyer(order.customerName) ? '' : `, ${order.customerName}`}.`,
      '',
      `${inv.invoiceNumber} дугаартай ${tugrik(amount)} дүнтэй нэхэмжлэхийг илгээж байна.`,
      inv.dueDate ? `Төлөх хугацаа: ${day(inv.dueDate)}.` : '',
      `Гүйлгээний утга: ${reference}`,
      '',
      `Нэхэмжлэх: ${link}`,
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n');
    // Opens the staff member's own mail program with the message ready; nothing is sent by the server.
    window.location.href = `mailto:${encodeURIComponent(inv.recipientEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await sent('EMAIL');
  }

  async function print() {
    window.open(`/print/orders/${order.id}?doc=invoice`, '_blank', 'noopener');
    await sent('PRINT');
  }

  /** Puts the buyer (new or replacing the earlier one) on the order and the invoice. */
  async function attach(c: Customer | null) {
    if (!c) return;
    setError('');
    setMsg('');
    try {
      onOrder(await api<Order>(`/orders/${order.id}/customer`, { method: 'PATCH', body: JSON.stringify({ customerId: c.id }) }));
      setChangingBuyer(false);
      await load();
      setMsg(`«${c.name}» төлөгчөөр орлоо.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Төлөгч оноож чадсангүй');
    }
  }

  async function extend() {
    if (!inv) return;
    setError('');
    try {
      await api(`/invoices/${inv.id}/extend`, { method: 'POST', body: JSON.stringify({ days: 7 }) });
      await load();
      setMsg('Төлөх хугацааг 7 хоногоор сунгалаа.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сунгаж чадсангүй');
    }
  }

  async function cancel() {
    if (!inv) return;
    const nothingPaid = order.status === 'PENDING_PAYMENT' && inv.paidMnt === 0;
    const question = `${inv.invoiceNumber} нэхэмжлэхийг цуцлах уу? Илгээсэн холбоос ажиллахаа болино.${
      nothingPaid ? '\nТөлбөр ороогүй тул захиалга ч мөн цуцлагдана.' : ''
    }`;
    if (!window.confirm(question)) return;
    setError('');
    try {
      const res = await api<CancelResult>(`/invoices/${inv.id}/cancel`, { method: 'POST' });
      // The page shows the invoice number as the transfer reference: refresh it either way.
      await api<Order>(`/orders/${order.id}`).then(onOrder, () => undefined);
      setMsg(res.orderCancelled ? 'Нэхэмжлэх болон захиалга цуцлагдлаа.' : (res.orderNote ?? 'Нэхэмжлэх цуцлагдлаа.'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Цуцалж чадсангүй');
    }
  }

  if (!loaded) return null;
  if (!inv && order.status === 'CANCELLED') return null;

  const live = !!inv && inv.state !== 'CANCELLED';
  const noBuyer = !order.customerId;
  const blankOnPaper = noBuyer && isUnknownBuyer(order.customerName);

  const form = (
    <form onSubmit={save} className="grid gap-2 sm:grid-cols-2">
      {!inv && <p className="text-xs text-slate-400 sm:col-span-2">Төлөгч мөнгөө шилжүүлэх нэхэмжлэх. Бүх талбар заавал биш — хоосон орхиж болно.</p>}
      <label className="text-xs text-slate-400">
        Имэйл (имэйлээр илгээх бол)
        <input className="mt-1 block w-full" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="buh@company.mn" />
      </label>
      <label className="text-xs text-slate-400">
        Утас (SMS илгээх бол)
        <input className="mt-1 block w-full" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label className="text-xs text-slate-400">
        Төлөх хугацаа
        <input className="mt-1 block w-full" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <label className="text-xs text-slate-400">
        Тайлбар (нэхэмжлэх дээр гарна)
        <input className="mt-1 block w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ж: гэрээ Г-12" />
      </label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button className="btn-primary text-sm" disabled={busy}>
          {busy ? 'Хадгалж байна…' : inv ? 'Хадгалах' : 'Нэхэмжлэх үүсгэх'}
        </button>
        {inv && (
          <button type="button" className="btn-ghost text-sm" onClick={() => setEditing(false)}>
            Болих
          </button>
        )}
      </div>
    </form>
  );

  const buyer = (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-steel-800/40 p-3 text-sm">
      {noBuyer && !changingBuyer ? (
        <>
          <p>
            Төлөгч:{' '}
            {blankOnPaper ? (
              <>
                <b className="tracking-widest">……</b> <span className="text-xs text-amber-300">(хоосон — хэвлэхэд гараар бөглөнө)</span>
              </>
            ) : (
              <>
                <b>{order.customerName}</b> <span className="text-xs text-slate-400">(бүртгэлгүй)</span>
              </>
            )}
          </p>
          {live && (
            <div className="text-xs text-slate-400">
              Төлөгчийг хайж сонгоно. Бүртгэлгүй бол «+ Шинэ» дарж байгууллага эсвэл хүн бүртгэнэ:
              <div className="mt-1 w-full sm:max-w-md">
                <CustomerPicker value={null} onChange={(c) => void attach(c)} allowCreate />
              </div>
            </div>
          )}
        </>
      ) : changingBuyer ? (
        <div className="text-xs text-slate-400">
          Шинэ төлөгчийг хайж сонгоно (эсвэл «+ Шинэ» дарж бүртгэнэ):
          <div className="mt-1 w-full sm:max-w-md">
            <CustomerPicker value={null} onChange={(c) => void attach(c)} allowCreate />
          </div>
          <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setChangingBuyer(false)}>
            Болих
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0">
            Төлөгч: <b>{order.customerName}</b>
            <span className="block text-xs text-slate-400">
              {[order.customerPhone, order.customerRegNumber ? `РД ${order.customerRegNumber}` : '', inv?.recipientEmail ?? ''].filter(Boolean).join(' · ') || '—'}
            </span>
          </p>
          {live && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setChangingBuyer(true)}>
              Солих
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="card mb-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          Нэхэмжлэх {inv && <span className="font-mono text-amber-brand">{inv.invoiceNumber}</span>}
        </h3>
        {inv && <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_CLASS[inv.state]}`}>{INVOICE_STATE_LABEL[inv.state]}</span>}
      </div>

      {!inv || editing ? (
        form
      ) : (
        <>
          {live && inv.owedMnt > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2">
              <p className="min-w-0 text-sm">
                <span className="block text-xs text-slate-400">Гүйлгээний утга — төлөгч шилжүүлэхдээ үүнийг бичнэ</span>
                <b className="break-all font-mono text-amber-brand">{reference}</b>
              </p>
              <p className="text-right text-sm">
                <span className="block text-xs text-slate-400">Төлөх үлдэгдэл</span>
                <b>{tugrik(inv.owedMnt)}</b>
              </p>
            </div>
          )}

          {buyer}

          <p className="text-xs text-slate-400">
            {inv.dueDate && (
              <>
                Төлөх хугацаа <b className={inv.state === 'OVERDUE' ? 'text-red-300' : 'text-slate-200'}>{day(inv.dueDate)}</b>
                {inv.state === 'OVERDUE' && <span className="text-red-300"> (хэтэрсэн)</span>}
                {' · '}
              </>
            )}
            Үлдэгдэл {tugrik(inv.owedMnt)} / {tugrik(order.totalMnt)}
            {inv.sentAt ? ` · сүүлд ${when(inv.sentAt)}-д ${VIA_MN[inv.lastSentVia ?? ''] ?? ''} илгээсэн (${inv.sendCount} удаа)` : ' · хараахан илгээгээгүй'}
            {inv.viewedAt && ` · төлөгч ${when(inv.viewedAt)}-д нээсэн`}
          </p>

          {live && (
            <>
              <div>
                <p className="mb-1.5 text-xs font-semibold text-slate-400">Төлөгчид илгээх</p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <button type="button" className="btn-primary col-span-2 text-sm sm:col-span-1" onClick={() => void share()}>
                    📤 Хуваалцах
                  </button>
                  <button type="button" className="btn-ghost text-sm" onClick={() => void sms()}>
                    SMS
                  </button>
                  <button type="button" className="btn-ghost text-sm" onClick={() => void copyLink()}>
                    Холбоос хуулах
                  </button>
                  <button type="button" className="btn-ghost text-sm" onClick={() => void mail()}>
                    Имэйл
                  </button>
                  <button type="button" className="btn-ghost text-sm" onClick={() => void print()}>
                    Хэвлэх / PDF
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  «Хуваалцах» — утсан дээр Viber, Messenger, Gmail-ээр шууд илгээнэ. PDF: хэвлэх цонхонд «Save as PDF»-ийг сонгоно.
                  {!inv.recipientEmail && ' Имэйлээр илгээхэд эхлээд «Засах»-аас имэйл хаяг оруулна.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3">
                {inv.state !== 'PAID' && (
                  <button type="button" className="btn-ghost text-sm" onClick={() => void extend()}>
                    Хугацаа +7 хоног
                  </button>
                )}
                <button type="button" className="btn-ghost text-sm" onClick={() => setEditing(true)}>
                  Засах (имэйл, утас, хугацаа)
                </button>
                {canManage && (
                  <button type="button" className="btn-ghost text-sm text-red-300" onClick={() => void cancel()}>
                    Цуцлах
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {msg && <p className="text-xs text-emerald-300">{msg}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
