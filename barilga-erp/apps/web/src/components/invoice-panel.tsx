'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { CustomerPicker } from '@/components/customer-picker';
import { Customer, INVOICE_STATE_LABEL, Invoice, Order } from '@/lib/types';

const plusDays = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(Date.now() + n * 86_400_000));
const day = (iso: string) => new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(iso));
const when = (iso: string) =>
  new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const VIA_MN: Record<string, string> = { LINK: 'холбоос', EMAIL: 'имэйл', PRINT: 'хэвлэж' };

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
 * The order's invoice: make it, send it (link, e-mail, print), see whether the buyer opened and paid it,
 * and confirm the bank transfer when it arrives.
 */
export function InvoicePanel({ order, canManage, onOrder }: { order: Order; canManage: boolean; onOrder: (o: Order) => void }) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
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
  }, [load, order.status]);

  const link = inv?.token ? `${window.location.origin}/invoice/${inv.token}` : '';

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/invoices', {
        method: 'POST',
        body: JSON.stringify({ orderId: order.id, recipientEmail: email, recipientPhone: phone, dueDate: due, note }),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  async function sent(via: 'LINK' | 'EMAIL' | 'PRINT') {
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
    const text = `${inv.invoiceNumber} нэхэмжлэх — ${tugrik(order.totalMnt)}: ${link}`;
    try {
      await navigator.clipboard.writeText(text);
      setMsg('Холбоос хуулагдлаа — Viber, Messenger, SMS-ээр илгээнэ үү.');
    } catch {
      window.prompt('Холбоосыг хуулж илгээнэ үү:', text);
    }
    await sent('LINK');
  }

  async function mail() {
    if (!inv || !link || !inv.recipientEmail) return;
    const subject = `Нэхэмжлэх ${inv.invoiceNumber}`;
    const body = [
      `Сайн байна уу, ${order.customerName}.`,
      '',
      `${inv.invoiceNumber} дугаартай ${tugrik(order.totalMnt)} дүнтэй нэхэмжлэхийг илгээж байна.`,
      inv.dueDate ? `Төлөх хугацаа: ${day(inv.dueDate)}.` : '',
      `Гүйлгээний утга: ${inv.invoiceNumber}`,
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

  /** The buyer was registered after the sale: put them on the order and the invoice. */
  async function attach(c: Customer | null) {
    if (!c) return;
    setError('');
    try {
      onOrder(await api<Order>(`/orders/${order.id}/customer`, { method: 'PATCH', body: JSON.stringify({ customerId: c.id }) }));
      await load();
      setMsg(`«${c.name}» нэхэмжлэх дээр орлоо.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Харилцагч оноож чадсангүй');
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
    if (!inv || !window.confirm(`${inv.invoiceNumber} нэхэмжлэхийг цуцлах уу? Илгээсэн холбоос ажиллахаа болино.`)) return;
    try {
      await api(`/invoices/${inv.id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Цуцалж чадсангүй');
    }
  }

  if (!loaded) return null;
  if (!inv && order.status === 'CANCELLED') return null;

  const form = (
    <form onSubmit={save} className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs text-slate-400">
        Имэйл
        <input className="mt-1 block w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="buh@company.mn" />
      </label>
      <label className="text-xs text-slate-400">
        Утас
        <input className="mt-1 block w-full" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label className="text-xs text-slate-400">
        Төлөх хугацаа
        <input className="mt-1 block w-full" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <label className="text-xs text-slate-400">
        Тайлбар (нэхэмжлэх дээр гарна)
        <input className="mt-1 block w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ж: гэрээ Г-12" />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn-primary text-sm" disabled={busy}>
          {inv ? 'Хадгалах' : 'Нэхэмжлэх үүсгэх'}
        </button>
        {inv && (
          <button type="button" className="btn-ghost text-sm" onClick={() => setEditing(false)}>
            Болих
          </button>
        )}
      </div>
    </form>
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
          <p className="text-sm text-slate-300">
            Төлөгч: <b>{order.customerId ? order.customerName : 'тодорхойгүй (хэвлэхэд хоосон мөр)'}</b> · {inv.recipientEmail ?? 'имэйлгүй'} ·{' '}
            {inv.recipientPhone ?? '—'}
            {inv.dueDate && (
              <>
                {' '}
                · төлөх хугацаа <b className={inv.state === 'OVERDUE' ? 'text-red-300' : ''}>{day(inv.dueDate)}</b>
                {inv.state === 'OVERDUE' && <span className="text-red-300"> (хэтэрсэн)</span>}
              </>
            )}
          </p>
          {!order.customerId && inv.state !== 'CANCELLED' && (
            <div className="text-xs text-slate-400">
              Харилцагч оноох (байхгүй бол «+ Шинэ» дарж бүртгэнэ):
              <div className="mt-1 max-w-md">
                <CustomerPicker value={null} onChange={(c) => void attach(c)} allowCreate />
              </div>
            </div>
          )}
          <p className="text-xs text-slate-400">
            Үлдэгдэл {tugrik(inv.owedMnt)} / {tugrik(order.totalMnt)}
            {inv.sentAt ? ` · сүүлд ${when(inv.sentAt)}-д ${VIA_MN[inv.lastSentVia ?? ''] ?? ''} илгээсэн (${inv.sendCount} удаа)` : ' · хараахан илгээгээгүй'}
            {inv.viewedAt && ` · харилцагч ${when(inv.viewedAt)}-д нээсэн`}
          </p>
          {inv.state !== 'CANCELLED' && (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary text-sm" onClick={() => void copyLink()}>
                Холбоос хуулах
              </button>
              <button
                className="btn-ghost text-sm"
                disabled={!inv.recipientEmail}
                title={inv.recipientEmail ? '' : 'Имэйл хаяг оруулна уу'}
                onClick={() => void mail()}
              >
                Имэйлээр илгээх
              </button>
              <button className="btn-ghost text-sm" onClick={() => void print()} title="Хэвлэх цонхонд «Save as PDF» сонговол PDF болж хадгалагдана">
                Хэвлэх / PDF
              </button>
              {inv.state !== 'PAID' && (
                <button className="btn-ghost text-sm" onClick={() => void extend()}>
                  Хугацаа +7 хоног
                </button>
              )}
              <button className="btn-ghost text-sm" onClick={() => setEditing(true)}>
                Засах
              </button>
              {canManage && (
                <button className="btn-ghost text-sm text-red-300" onClick={() => void cancel()}>
                  Цуцлах
                </button>
              )}
            </div>
          )}
        </>
      )}
      {msg && <p className="text-xs text-emerald-300">{msg}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
