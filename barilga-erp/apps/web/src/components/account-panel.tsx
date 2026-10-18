'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, tugrik } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { useCan } from '@/lib/permissions';
import type { AccountLineKind, AccountStatement, Product, Warehouse } from '@/lib/types';

export const KIND_MN: Record<AccountLineKind, string> = {
  ON_ACCOUNT: 'Дараа төлөхөөр авсан',
  PAID_BY_THEM: 'Тэд төлсөн',
  RETURNED: 'Буцаалт',
  PURCHASE: 'Бид бараа/үйлчилгээ авсан',
  PAYMENT_TO_PARTNER: 'Бид төлсөн',
  OFFSET: 'Хасалт',
  ADJUSTMENT: 'Залруулга',
  CHARGE: 'Авлага нэмсэн',
  PAYMENT_FROM_PARTNER: 'Тэд мөнгө төлсөн',
};
const METHODS = [
  ['CASH', 'Бэлэн'],
  ['TRANSFER', 'Шилжүүлэг'],
  ['CARD', 'Карт'],
] as const;
type Method = (typeof METHODS)[number][0];

/** «Тэр бидэнд өртэй» / «Бид түүнд өртэй» wording for a net balance. */
function netLabel(net: number) {
  if (net > 0) return { text: `Бидэнд ${tugrik(net)} өртэй`, cls: 'text-amber-300' };
  if (net < 0) return { text: `Бид түүнд ${tugrik(-net)} өртэй`, cls: 'text-sky-300' };
  return { text: 'Тооцоо дууссан', cls: 'text-emerald-300' };
}

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(d);
function monthRange(offset: number) {
  const today = ymd(new Date());
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  const f = first.toISOString().slice(0, 10);
  const l = offset === 0 ? today : last.toISOString().slice(0, 10);
  return { from: f, to: l };
}

type Modal =
  | null
  | { kind: 'goods' }
  | { kind: 'receive' }
  | { kind: 'pay' }
  | { kind: 'charge' }
  | { kind: 'purchase' }
  | { kind: 'offset' }
  | { kind: 'edit'; line: AccountStatement['lines'][number] }
  | { kind: 'void'; line: AccountStatement['lines'][number] };

type GoodsLine = { productId: string; nameMn: string; unit: string; quantity: string; unitCost: string; lastCostMnt: number | null };

/**
 * The two-way account with a partner (харилцагчийн тооцоо). Everyone sees it; managers record goods taken from
 * the partner (with quantities, into stock), money either way, charges and amount-only purchases, offsets,
 * and correct or cancel hand-written lines. A date range turns it into the reconciliation statement (акт),
 * printable and exportable.
 */
export function AccountPanel({
  customerId,
  canManage,
  partnerIsSupplier = false,
}: {
  customerId: string;
  canManage: boolean;
  /** The partner sells to us or has a barter contract: goods can be taken from them on account. */
  partnerIsSupplier?: boolean;
}) {
  const allowed = useCan();
  /** Goods taken by quantity become a goods receipt with costs: both rights are needed. */
  const canTakeGoods = allowed('RECEIPT_CREATE') && allowed('RECEIPT_COST_EDIT');
  const [st, setSt] = useState<AccountStatement | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [modal, setModal] = useState<Modal>(null);
  const [msg, setMsg] = useState('');
  /** Order debt this user may collect (a branch manager: their own shops' orders only). */
  const [owedHere, setOwedHere] = useState<number | null>(null);

  const query = range.from || range.to ? `?${new URLSearchParams({ ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) })}` : '';

  const load = useCallback(async () => {
    try {
      setError('');
      setSt(await api<AccountStatement>(`/accounts/${customerId}${query}`));
      if (canManage) setOwedHere((await api<{ owedMnt: number }>(`/customers/${customerId}/owed-here`)).owedMnt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, [customerId, query, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, done: string | ((res: T) => string)) {
    setBusy(true);
    setError('');
    try {
      const res = await fn();
      setModal(null);
      setMsg(typeof done === 'function' ? done(res) : done);
      window.setTimeout(() => setMsg(''), 8000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хадгалж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  function csv() {
    if (!st) return;
    downloadCsv(
      `tootsoo-${st.customer.name}-${range.from || 'ehnees'}-${range.to || 'odoo'}`,
      ['Огноо', 'Төрөл', 'Тайлбар', 'Авлага нэмэгдсэн', 'Авлага буурсан', 'Үлдэгдэл'],
      [
        ...(st.period && range.from ? [[range.from, 'Эхний үлдэгдэл', '', '', '', st.period.openingMnt]] : []),
        ...st.lines.map((l) => [
          new Date(l.at).toLocaleDateString('mn-MN'),
          KIND_MN[l.kind] ?? l.kind,
          `${l.description}${l.voided ? ' (хүчингүй)' : ''}`,
          l.effectMnt > 0 ? l.effectMnt : '',
          l.effectMnt < 0 ? -l.effectMnt : '',
          l.balanceMnt,
        ]),
      ],
    );
  }

  if (!st) return error ? <p className="text-sm text-red-400">{error}</p> : null;
  const net = netLabel(st.netMnt);
  const ordersOwed = st.ordersOwedMnt ?? st.receivableMnt;
  const offsetMax = Math.min(ordersOwed, st.payableMnt);
  const printHref = `/print/accounts/${customerId}${query}`;
  const quick = [
    ['Энэ сар', monthRange(0)],
    ['Өнгөрсөн сар', monthRange(-1)],
    ['Бүгд', { from: '', to: '' }],
  ] as const;

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            Тооцоо (авлага / өглөг) {st.customer.barterContract && <span className="text-xs text-amber-300">· бартер {st.customer.barterContract}</span>}
          </h3>
          <p className={`text-lg font-bold ${net.cls}`}>{net.text}</p>
          <p className="text-xs text-slate-400">
            Авлага (тэд бидэнд): <b className="text-amber-200">{tugrik(st.receivableMnt)}</b> · Өглөг (бид тэдэнд):{' '}
            <b className="text-sky-200">{tugrik(st.payableMnt)}</b>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          {quick.map(([label, r]) => (
            <button
              key={label}
              type="button"
              className={range.from === r.from && range.to === r.to ? 'btn-primary text-xs' : 'btn-ghost text-xs'}
              onClick={() => setRange({ ...r })}
            >
              {label}
            </button>
          ))}
          <label className="text-slate-400">
            Эхлэх
            <input type="date" className="mt-1 block" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="text-slate-400">
            Дуусах
            <input type="date" className="mt-1 block" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </label>
          <a className="btn-ghost text-xs" href={printHref} target="_blank" rel="noreferrer" title="Тооцоо нийлсэн акт — хоёр тал гарын үсэг зурна">
            🖨 Акт
          </a>
          <button type="button" className="btn-ghost text-xs" onClick={csv}>
            Excel
          </button>
        </div>
      </div>

      {canManage && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-slate-800 bg-steel-900/40 p-2 text-xs">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={!partnerIsSupplier || !canTakeGoods}
            title={
              !canTakeGoods
                ? 'Бараа орлого авах болон өртөг оруулах эрх хэрэгтэй'
                : partnerIsSupplier
                  ? ''
                  : 'Харилцагчийг засаад «Нийлүүлэгч» эсвэл бартерын гэрээтэй гэж тэмдэглэнэ'
            }
            onClick={() => setModal({ kind: 'goods' })}
          >
            📦 Бараа авсан (тоогоор)
          </button>
          <Link
            className={`btn-ghost text-xs ${partnerIsSupplier && st.payableMnt > 0 ? '' : 'pointer-events-none opacity-40'}`}
            href={`/pos?customer=${customerId}&pay=CONTRACT`}
            title="Касс дээр бараа сонгоод «Гэрээгээр олгох» — бидний өглөгөөс хасагдана"
          >
            🔁 Бараагаар төлөх
          </Link>
          <button type="button" className="btn-ghost text-xs" onClick={() => setModal({ kind: 'receive' })}>
            💵 Тэд мөнгө төлсөн
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setModal({ kind: 'pay' })}>
            💸 Бид мөнгө төлсөн
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setModal({ kind: 'charge' })}>
            ➕ Авлага нэмэх
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setModal({ kind: 'purchase' })}>
            ➕ Өглөг нэмэх
          </button>
          <button type="button" className="btn-primary text-xs" disabled={offsetMax <= 0} onClick={() => setModal({ kind: 'offset' })}>
            ⇄ Хасалт {offsetMax > 0 ? `(${tugrik(offsetMax)} хүртэл)` : ''}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {msg && <p className="text-sm text-emerald-300">{msg}</p>}

      {st.period && (range.from || range.to) && (
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Tile label="Эхний үлдэгдэл" value={st.period.openingMnt} />
          <Tile label="Авлага нэмэгдсэн" value={st.period.debitMnt} cls="text-amber-300" />
          <Tile label="Авлага буурсан" value={st.period.creditMnt} cls="text-sky-300" />
          <Tile label="Эцсийн үлдэгдэл" value={st.period.closingMnt} bold />
        </div>
      )}

      <div className="max-h-96 overflow-auto rounded border border-slate-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-steel-900 text-left text-xs text-slate-400">
            <tr>
              <th className="p-2">Огноо</th>
              <th>Төрөл</th>
              <th>Тайлбар</th>
              <th className="text-right">Дүн</th>
              <th className="text-right pr-2">Үлдэгдэл</th>
            </tr>
          </thead>
          <tbody>
            {st.lines.map((l, i) => (
              <tr key={`${l.entryId ?? l.orderId}-${i}`} className={`border-t border-slate-800 ${l.voided ? 'opacity-50 line-through' : ''}`}>
                <td className="p-2 text-xs text-slate-400 whitespace-nowrap">{new Date(l.at).toLocaleDateString('mn-MN')}</td>
                <td className="text-xs whitespace-nowrap">{KIND_MN[l.kind] ?? l.kind}</td>
                <td className="text-xs">
                  {l.orderId ? (
                    <Link href={`/orders/${l.orderId}`} className="hover:underline">
                      {l.description}
                    </Link>
                  ) : l.refType === 'RECEIPT' && l.refId ? (
                    <a href={`/print/receipts/${l.refId}`} target="_blank" rel="noreferrer" className="hover:underline">
                      {l.description}
                    </a>
                  ) : (
                    l.description
                  )}
                  {canManage && l.editable && l.entryId && (
                    <span className="ml-2 whitespace-nowrap no-underline">
                      <button className="text-[11px] text-amber-300 hover:underline" onClick={() => setModal({ kind: 'edit', line: l })}>
                        засах
                      </button>{' '}
                      <button className="text-[11px] text-red-300 hover:underline" onClick={() => setModal({ kind: 'void', line: l })}>
                        хүчингүй
                      </button>
                    </span>
                  )}
                </td>
                <td className={`text-right whitespace-nowrap ${l.effectMnt > 0 ? 'text-amber-300' : 'text-sky-300'}`}>
                  {l.effectMnt > 0 ? '+' : l.effectMnt < 0 ? '−' : '±'}
                  {tugrik(Math.abs(l.effectMnt))}
                </td>
                <td className="text-right pr-2 whitespace-nowrap">{tugrik(l.balanceMnt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {st.lines.length === 0 && <p className="p-3 text-sm text-slate-500">Энэ хугацаанд гүйлгээ алга.</p>}
      </div>
      <p className="text-[11px] text-slate-500">
        «+» = тэд бидэнд илүү өртэй болсон, «−» = бага болсон (эсвэл бид тэдэнд өртэй болсон). Үлдэгдэл эерэг бол тэд бидэнд, сөрөг бол бид тэдэнд өртэй.
      </p>

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !busy && (setModal(null), setError(''))}>
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-auto space-y-3" onClick={(e) => e.stopPropagation()}>
            {error && <p className="rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-300">{error}</p>}
            {modal.kind === 'goods' && (
              <GoodsForm
                customerId={customerId}
                partnerName={st.customer.name}
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(body) => run(() => api('/inventory/receipts', { method: 'POST', body: JSON.stringify(body) }), 'Бараа агуулахад орлоо — үнэтэй мөрүүд өглөгт нэмэгдсэн (үнэ ороогүйг «Худалдаа / худалдан авалт» → «Бид авсан»-аас оруулна)')}
              />
            )}
            {modal.kind === 'receive' && (
              <MoneyForm
                title="Тэд бидэнд мөнгө төлсөн"
                hint={
                  (owedHere ?? ordersOwed) > 0
                    ? `Эхлээд захиалгын өр (${tugrik(owedHere ?? ordersOwed)}) хуучнаас нь хаагдана, үлдсэн нь урьдчилгаа болж өглөгт орно.${
                        owedHere !== null && owedHere < ordersOwed
                          ? ` Бусад салбарын захиалгад ${tugrik(ordersOwed - owedHere)} өртэй — тэдгээрийг тэр салбар авна, тиймээс ${tugrik(owedHere)}-өөс их авахгүй.`
                          : ''
                      }`
                    : ordersOwed > 0
                      ? `Таны салбарт захиалгын өр алга; бусад салбарт ${tugrik(ordersOwed)} өртэй — тэр салбар авна.`
                      : 'Захиалгын өргүй тул урьдчилгаа болж бүртгэгдэнэ (бид тэдэнд өртэй болно).'
                }
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(amountMnt, method, description) =>
                  run(
                    () =>
                      api<{ applied: Array<{ orderNumber: string; amountMnt: number }>; advanceMnt: number }>(`/accounts/${customerId}/receive`, {
                        method: 'POST',
                        body: JSON.stringify({ amountMnt, method, description }),
                      }),
                    (r) =>
                      [
                        r.applied.length ? `Хаагдсан: ${r.applied.map((a) => `${a.orderNumber} ${tugrik(a.amountMnt)}`).join(', ')}` : '',
                        r.advanceMnt ? `Урьдчилгаа: ${tugrik(r.advanceMnt)}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Төлбөр бүртгэгдлээ',
                  )
                }
              />
            )}
            {modal.kind === 'pay' && (
              <MoneyForm
                title="Бид тэдэнд мөнгө төлсөн"
                hint="Бэлнээр бол таны кассаас гарсанд тооцогдоно."
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(amountMnt, method, description) =>
                  run(
                    () =>
                      api(`/accounts/${customerId}/entries`, {
                        method: 'POST',
                        body: JSON.stringify({ kind: 'PAYMENT_TO_PARTNER', amountMnt, method, description: description || 'Мөнгө төлсөн' }),
                      }),
                    'Төлбөр бүртгэгдлээ',
                  )
                }
              />
            )}
            {(modal.kind === 'charge' || modal.kind === 'purchase') && (
              <AmountForm
                title={modal.kind === 'charge' ? 'Авлага нэмэх (тэд бидэнд өртэй болсон)' : 'Өглөг нэмэх (бид тэдэнд өртэй болсон)'}
                hint={
                  modal.kind === 'charge'
                    ? 'Захиалгагүй авлага: тээврийн хөлс, үйлчилгээ, торгууль г.м. Бараа өгсөн бол касс дээр захиалгаар хийнэ.'
                    : 'Үйлчилгээ, зардал г.м. Бараа авсан бол «📦 Бараа авсан»-аар тоогоор нь оруулна.'
                }
                placeholder={modal.kind === 'charge' ? 'ж: Тээврийн хөлс 10/18' : 'ж: Ачилтын үйлчилгээ'}
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(amountMnt, description, occurredAt) =>
                  run(
                    () =>
                      api(`/accounts/${customerId}/entries`, {
                        method: 'POST',
                        body: JSON.stringify({
                          kind: modal.kind === 'charge' ? 'CHARGE' : 'PURCHASE',
                          amountMnt,
                          description,
                          ...(occurredAt ? { occurredAt: `${occurredAt}T12:00:00+08:00` } : {}),
                        }),
                      }),
                    'Бүртгэгдлээ',
                  )
                }
              />
            )}
            {modal.kind === 'offset' && (
              <OffsetForm
                max={offsetMax}
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(amountMnt) =>
                  run(() => api(`/accounts/${customerId}/offset`, { method: 'POST', body: JSON.stringify({ amountMnt }) }), 'Хасалт хийгдлээ')
                }
              />
            )}
            {modal.kind === 'edit' && (
              <EditForm
                line={modal.line}
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(body) => run(() => api(`/accounts/entries/${modal.line.entryId}`, { method: 'PATCH', body: JSON.stringify(body) }), 'Засагдлаа')}
              />
            )}
            {modal.kind === 'void' && (
              <VoidForm
                line={modal.line}
                busy={busy}
                onCancel={() => setModal(null)}
                onSave={(reason) =>
                  run(() => api(`/accounts/entries/${modal.line.entryId}/void`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Хүчингүй болголоо')
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, cls = '', bold = false }: { label: string; value: number; cls?: string; bold?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <p className="text-slate-400">{label}</p>
      <p className={`${bold ? 'text-base font-bold' : 'font-semibold'} ${cls}`}>{tugrik(value)}</p>
    </div>
  );
}

function Buttons({ busy, onCancel, label = 'Хадгалах' }: { busy: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" className="btn-ghost" onClick={onCancel}>
        Болих
      </button>
      <button className="btn-primary" disabled={busy}>
        {busy ? 'Хадгалж байна…' : label}
      </button>
    </div>
  );
}

const toInt = (s: string) => Math.round(Number(s.replace(/[\s,]/g, '')));

function MoneyForm(props: { title: string; hint: string; busy: boolean; onCancel: () => void; onSave: (amountMnt: number, method: Method, description: string) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('TRANSFER');
  const [description, setDescription] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = toInt(amount);
    if (n > 0) props.onSave(n, method, description.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-lg font-semibold">{props.title}</h3>
      <p className="text-xs text-slate-400">{props.hint}</p>
      <div className="grid grid-cols-3 gap-2">
        {METHODS.map(([k, l]) => (
          <button key={k} type="button" className={method === k ? 'btn-primary text-sm' : 'btn-ghost text-sm'} onClick={() => setMethod(k)}>
            {l}
          </button>
        ))}
      </div>
      <label className="block text-xs text-slate-400">
        Дүн ₮
        <input className="mt-1 block w-full text-lg" inputMode="numeric" autoFocus required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="block text-xs text-slate-400">
        Тайлбар
        <input className="mt-1 block w-full" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ж: Хаан банк гүйлгээ 10/18" />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} />
    </form>
  );
}

function AmountForm(props: {
  title: string;
  hint: string;
  placeholder: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (amountMnt: number, description: string, occurredAt: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = toInt(amount);
    if (n > 0 && description.trim().length >= 3) props.onSave(n, description.trim(), date);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-lg font-semibold">{props.title}</h3>
      <p className="text-xs text-slate-400">{props.hint}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Дүн ₮
          <input className="mt-1 block w-full" inputMode="numeric" autoFocus required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-xs text-slate-400">
          Огноо (хоосон бол өнөөдөр)
          <input className="mt-1 block w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="block text-xs text-slate-400">
        Тайлбар (заавал)
        <input className="mt-1 block w-full" required minLength={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={props.placeholder} />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} />
    </form>
  );
}

function OffsetForm(props: { max: number; busy: boolean; onCancel: () => void; onSave: (amountMnt: number) => void }) {
  const [amount, setAmount] = useState(String(props.max));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Math.min(props.max, toInt(amount));
    if (n > 0) props.onSave(n);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-lg font-semibold">Хасалт (авлагыг өглөгөөр хаах)</h3>
      <p className="text-xs text-slate-400">
        Тэдний дараа төлөхөөр авсан захиалгууд (хуучнаас нь эхлээд) бидний тэдэнд өгөх өглөгөөр төлөгдөнө. Мөнгө хөдлөхгүй. Дээд тал нь {tugrik(props.max)}.
      </p>
      <label className="block text-xs text-slate-400">
        Хасах дүн ₮
        <input className="mt-1 block w-full text-lg" inputMode="numeric" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} label="Хасалт хийх" />
    </form>
  );
}

function EditForm(props: {
  line: AccountStatement['lines'][number];
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { amountMnt?: number; description?: string; occurredAt?: string; reason: string }) => void;
}) {
  const l = props.line;
  // The ledger amount behind the line: effect is "they owe us", the ledger is "we owe them".
  const isAdjust = l.kind === 'ADJUSTMENT';
  const [amount, setAmount] = useState(String(isAdjust ? -l.effectMnt : Math.abs(l.effectMnt)));
  const [description, setDescription] = useState(l.description.replace(/ \((бэлнээр|картаар|шилжүүлгээр)\)/, '').replace(/ · [^·]+$/, ''));
  const [date, setDate] = useState(ymd(new Date(l.at)));
  const [reason, setReason] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    props.onSave({
      amountMnt: toInt(amount),
      description: description.trim(),
      occurredAt: `${date}T12:00:00+08:00`,
      reason: reason.trim(),
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-lg font-semibold">Мөр засах — {KIND_MN[l.kind]}</h3>
      {l.method === 'CASH' && <p className="text-xs text-amber-300">Бэлэн мөнгөний мөрийн дүнг засахгүй — хүчингүй болгоод дахин бүртгэнэ.</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Дүн ₮ {isAdjust ? '(+ бид өртэй / − тэд өртэй)' : ''}
          <input className="mt-1 block w-full" inputMode="numeric" disabled={l.method === 'CASH'} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-xs text-slate-400">
          Огноо
          <input className="mt-1 block w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="block text-xs text-slate-400">
        Тайлбар
        <input className="mt-1 block w-full" minLength={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="block text-xs text-slate-400">
        Засах шалтгаан (засварын түүхэд бичигдэнэ)
        <input className="mt-1 block w-full" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} />
    </form>
  );
}

function VoidForm(props: { line: AccountStatement['lines'][number]; busy: boolean; onCancel: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 3) props.onSave(reason.trim());
      }}
      className="space-y-3"
    >
      <h3 className="text-lg font-semibold">Мөрийг хүчингүй болгох</h3>
      <p className="text-sm text-slate-300">
        {KIND_MN[props.line.kind]} — {props.line.description} ({tugrik(Math.abs(props.line.effectMnt))})
      </p>
      <p className="text-xs text-slate-400">
        Эсрэг мөр бичигдэж тооцооноос хасагдана; хоёулаа түүхэнд үлдэнэ.{props.line.method === 'CASH' ? ' Бэлэн мөнгө таны кассанд буцаж тооцогдоно.' : ''}
      </p>
      <label className="block text-xs text-slate-400">
        Шалтгаан
        <input className="mt-1 block w-full" required minLength={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} label="Хүчингүй болгох" />
    </form>
  );
}

/**
 * Goods taken from the partner, by quantity: they go into stock through a goods receipt on the partner's
 * account. Prices may be left empty and set later on the receipt (then the account follows).
 */
function GoodsForm(props: {
  customerId: string;
  partnerName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: unknown) => void;
}) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Product[]>([]);
  const [lines, setLines] = useState<GoodsLine[]>([]);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [notes, setNotes] = useState('');
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Warehouse[]>('/inventory/warehouses')
      .then((w) => {
        setWarehouses(w);
        setWarehouseId(w.find((x) => x.isDefault)?.id ?? w[0]?.id ?? '');
      })
      .catch(() => setWarehouses([]));
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setHits([]);
    const h = window.setTimeout(() => {
      api<Product[]>(`/products?q=${encodeURIComponent(term)}`)
        .then((r) => setHits(r.slice(0, 20)))
        .catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(h);
  }, [q]);

  function add(p: Product) {
    setLines((prev) =>
      prev.some((l) => l.productId === p.id)
        ? prev.map((l) => (l.productId === p.id ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l))
        : [
            ...prev,
            {
              productId: p.id,
              nameMn: p.nameMn,
              unit: p.unit,
              quantity: '1',
              unitCost: '',
              lastCostMnt: (p as Product & { lastCostMnt?: number | null }).lastCostMnt ?? null,
            },
          ],
    );
    setQ('');
    setHits([]);
    box.current?.focus();
  }

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);
  const unpriced = lines.filter((l) => !l.unitCost.trim()).length;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!lines.length || lines.some((l) => !(Number(l.quantity) > 0))) return;
        props.onSave({
          warehouseId,
          supplierName: props.partnerName,
          supplierCustomerId: props.customerId,
          supplierInvoiceNo: invoiceNo.trim() || undefined,
          notes: notes.trim() || undefined,
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            ...(l.unitCost.trim() ? { unitCostMnt: toInt(l.unitCost) } : {}),
          })),
        });
      }}
      className="space-y-3"
    >
      <h3 className="text-lg font-semibold">Бараа авсан — {props.partnerName}</h3>
      <p className="text-xs text-slate-400">
        Бараа агуулахад орно, үнэтэй мөрүүд бидний өглөгт нэмэгдэнэ. Үнийг одоо мэдэхгүй бол хоосон үлдээгээд дараа нь «Худалдаа / худалдан авалт» → «Бид авсан» дээр «үнэ оруулах»-аар оруулна.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Агуулах
          <select className="mt-1 block w-full" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses
              .filter((w) => w.isActive)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block text-xs text-slate-400">
          Падаан / гэрээний № (заавал биш)
          <input className="mt-1 block w-full" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </label>
      </div>
      <div className="relative">
        <input ref={box} className="w-full" placeholder="🔍 Бараа хайх (нэр, код, баркод)…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded border border-slate-700 bg-steel-900 divide-y divide-slate-800">
            {hits.map((p) => (
              <li key={p.id}>
                <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-steel-800" onClick={() => add(p)}>
                  {p.nameMn} <span className="font-mono text-[11px] text-slate-500">{p.sku}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {lines.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <th>Бараа</th>
              <th>Тоо</th>
              <th>Нэгж үнэ ₮</th>
              <th className="text-right">Дүн</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.productId} className="border-t border-slate-800">
                <td className="py-1">{l.nameMn}</td>
                <td>
                  <input
                    className="w-20 text-right"
                    type="number"
                    min="0.001"
                    step="any"
                    value={l.quantity}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                  />{' '}
                  <span className="text-xs text-slate-400">{l.unit}</span>
                </td>
                <td>
                  <input
                    className="w-28 text-right"
                    inputMode="numeric"
                    placeholder={l.lastCostMnt != null ? `өмнө ${l.lastCostMnt}` : 'дараа'}
                    value={l.unitCost}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))}
                  />
                </td>
                <td className="text-right">{l.unitCost ? tugrik((Number(l.quantity) || 0) * toInt(l.unitCost)) : '—'}</td>
                <td className="text-right">
                  <button type="button" className="btn-ghost px-2 text-xs" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lines.length > 0 && (
        <p className="text-right text-sm">
          Өглөгт нэмэгдэх: <b>{tugrik(total)}</b>
          {unpriced > 0 && <span className="text-xs text-amber-300"> · {unpriced} мөр үнэ ороогүй (дараа оруулна)</span>}
        </p>
      )}
      <label className="block text-xs text-slate-400">
        Тэмдэглэл
        <input className="mt-1 block w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <Buttons busy={props.busy} onCancel={props.onCancel} label={`Бараа авах (${lines.length})`} />
    </form>
  );
}
