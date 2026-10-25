'use client';

import { BlankRowsControl, EditText, FlagPart, Part, useDesign } from '@/components/doc-design';
import { Blank, BlankRows, DocNote, LogoMark, SellerBlock, Signatures, Watermark, paidAndDue } from '@/components/invoice-doc';
import { tugrik } from '@/lib/api';
import { unitLabel } from '@/lib/catalog';
import { companionLines, type CompanySettings, type DocTemplate, type Order } from '@/lib/types';

export const DELIVERY_MN: Record<string, string> = {
  OUR_DELIVERY: 'Манай хүргэлт',
  DELIVERY: 'Манай хүргэлт',
  SELF_PICKUP: 'Өөрөө авах',
  CUSTOMER_DRIVER: 'Харилцагчийн жолооч',
};
const PAY_MN: Record<string, string> = { CASH: 'Бэлэн', CARD: 'Карт', QPAY: 'QPay', CREDIT: 'Дараа төлөх', TRANSFER: 'Шилжүүлэг', OFFSET: 'Тооцоонд хасагдсан' };

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

type DocProps = { order: Order; company: CompanySettings; t?: DocTemplate };

/** Till receipt (80 mm). */
export function Receipt({ order, company, t }: DocProps) {
  const { live, paid, due } = paidAndDue(order);
  const design = useDesign();
  const tpl = design?.t ?? t;
  return (
    <div className="relative font-mono text-[12px] leading-5">
      <Part k="watermark" label="Усан тэмдэг" t={t}>
        <Watermark company={company} />
      </Part>
      <Part k="logo" label="Лого" t={t}>
        <div className="flex justify-center">
          <LogoMark company={company} className="h-10" />
        </div>
      </Part>
      <Part k="seller" label="Компани" required t={t}>
        <p className="text-center text-sm font-bold">{company.name || 'Борлуулалтын баримт'}</p>
        {company.regNumber && <p className="text-center">РД: {company.regNumber}</p>}
        {company.phone && <p className="text-center">{company.phone}</p>}
      </Part>
      <Part k="title" label="Гарчиг" t={t}>
        <p className="text-center font-bold">
          <EditText field="title" t={t} placeholder="Гарчиг (заавал биш)" />
        </p>
      </Part>
      <p className="my-1 border-t border-dashed border-black" />
      <Part k="number" label="Дугаар, огноо" required t={t}>
        <p>Баримт: {order.orderNumber}</p>
        <p>Огноо: {dateTime(order.createdAt)}</p>
      </Part>
      <Part k="cashier" label="Кассчин" t={t}>
        <p>Кассчин: {order.createdBy?.fullName ?? order.createdBy?.name ?? ''}</p>
      </Part>
      <Part k="buyer" label="Харилцагч" t={t}>
        {tpl?.blankBuyer ? <Blank label="Харилцагч" wide /> : <p>Харилцагч: {order.customerName}</p>}
      </Part>
      <DocNote field="headerNote" t={t} />
      <p className="my-1 border-t border-dashed border-black" />
      <Part k="items" label="Бараа, нийт дүн" required t={t}>
        {order.items.map((i) => (
          <div key={i.id}>
            <p>{i.product.nameMn}</p>
            {companionLines(i.product.companions, Number(i.quantity)).map((c) => (
              <p key={c} className="pl-2">
                + {c}
              </p>
            ))}
            <p className="flex justify-between">
              <span>
                {qty(i.quantity)} × {tugrik(i.unitPrice)}
              </span>
              <span>{tugrik(i.lineTotal)}</span>
            </p>
          </div>
        ))}
        {(
          [
            ['Хүргэлт', order.deliveryFeeMnt],
            ['Буулгалт', order.unloadingFeeMnt],
            ['Цагийн нэмэгдэл/хөнгөлөлт', order.timeAdjustmentMnt],
          ] as Array<[string, number]>
        )
          .filter(([, v]) => v !== 0)
          .map(([l, v]) => (
            <p key={l} className="flex justify-between">
              <span>{l}</span>
              <span>{tugrik(v)}</span>
            </p>
          ))}
        <p className="my-1 border-t border-dashed border-black" />
        <p className="flex justify-between font-bold">
          <span>НИЙТ</span>
          <span>{tugrik(order.totalMnt)}</span>
        </p>
      </Part>
      <Part k="payments" label="Төлбөрийн хэлбэр" t={t}>
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
      </Part>
      {order.lottery && <p className="mt-1">И-баримт сугалаа: {order.lottery}</p>}
      <p className="my-1 border-t border-dashed border-black" />
      {company.receiptFooter && (
        <Part k="companyFooter" label="Компанийн доод бичиг" t={t}>
          <p className="whitespace-pre-line text-center">{company.receiptFooter}</p>
        </Part>
      )}
      <DocNote field="footerNote" t={t} className="text-center" />
      <Signatures t={t} />
      <Part k="thanks" label="«Баярлалаа»" t={t}>
        <p className="text-center">Баярлалаа!</p>
      </Part>
    </div>
  );
}

/** Pick list for the warehouse: what to prepare, with a tick column. */
export function Picklist({ order, company, t }: DocProps) {
  const design = useDesign();
  const tpl = design?.t ?? t;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <Part k="title" label="Гарчиг" required t={t}>
            <h1 className="text-xl font-bold">
              <EditText field="title" fallback="БАРАА БЭЛТГЭХ ХУУДАС" t={t} />
            </h1>
          </Part>
          <Part k="number" label="Дугаар, огноо" required t={t}>
            <p className="text-sm">
              Захиалга № {order.orderNumber} · {dateTime(order.createdAt)}
            </p>
          </Part>
        </div>
        <Part k="seller" label="Компани, агуулах" t={t}>
          <div className="text-right text-xs">
            <p className="font-semibold">{company.name}</p>
            <p>Агуулах: {order.warehouse?.name ?? '—'}</p>
            <p>Хэвлэсэн: {dateTime()}</p>
          </div>
        </Part>
      </div>
      <DocNote field="headerNote" t={t} />
      <div className="grid grid-cols-2 gap-4 text-xs">
        <Part k="buyer" label="Харилцагч, хүргэлт" t={t}>
          <div className="h-full rounded border border-slate-400 p-3">
            <p>
              Харилцагч: <b>{order.customerName}</b> · {order.customerPhone}
            </p>
            <p>Хүргэлт: {DELIVERY_MN[order.deliveryMethod] ?? order.deliveryMethod}</p>
            {order.deliveryAddress && <p>Хаяг: {order.deliveryAddress}</p>}
          </div>
        </Part>
        <Part k="logistics" label="Жин, машин, тэмдэглэл" t={t}>
          <div className="h-full rounded border border-slate-400 p-3">
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
        </Part>
      </div>
      <Part k="items" label="Бараа" required t={t}>
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
                    <p key={c} className="font-semibold">
                      + дагалдах: {c}
                    </p>
                  ))}
                </td>
                <td className="text-right text-base font-bold">{qty(i.quantity)}</td>
                <td>{unitLabel(i.product.unit)}</td>
                <td className="w-32">{i.pickedBy?.fullName ?? ''}</td>
              </tr>
            ))}
            <BlankRows n={tpl?.blankRows ?? 0} cols={7} />
          </tbody>
        </table>
        <BlankRowsControl />
      </Part>
      <DocNote field="footerNote" t={t} />
      <Signatures t={t} />
    </div>
  );
}

/** Goods issue note: what leaves the warehouse for this order, numbered like the invoice. */
export function IssueNote({ order, company, t }: DocProps) {
  const design = useDesign();
  const tpl = design?.t ?? t;
  const goods = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  const prices = Boolean(tpl?.showPrices);
  const cols = prices ? 7 : 5;
  return (
    <div className="relative space-y-3">
      <Part k="watermark" label="Усан тэмдэг" t={t}>
        <Watermark company={company} />
      </Part>
      <div className="flex items-start justify-between gap-4">
        <Part k="seller" label="Компани" required t={t}>
          <SellerBlock company={company} />
        </Part>
        <div className="text-right">
          <Part k="title" label="Гарчиг" required t={t}>
            <h1 className="text-xl font-bold tracking-wide">
              <EditText field="title" fallback="ЗАРЛАГЫН БАРИМТ" t={t} />
            </h1>
          </Part>
          <Part k="number" label="Дугаар, огноо" required t={t}>
            <p className="text-sm">№ {order.orderNumber}</p>
            <p className="text-xs">Огноо: {dateTime(order.completedAt ?? order.createdAt)}</p>
          </Part>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Part k="warehouse" label="Агуулах" t={t}>
          <p>
            Зарлагадсан агуулах: <b>{order.warehouse?.name ?? '—'}</b>
          </p>
        </Part>
        <Part k="buyer" label="Хүлээн авагч" t={t}>
          {tpl?.blankBuyer ? (
            <Blank label="Хүлээн авагч" wide />
          ) : (
            <p>
              Хүлээн авагч: <b>{order.customerName}</b>
              {order.customerRegNumber ? ` (РД ${order.customerRegNumber})` : ''} · {order.customerPhone}
            </p>
          )}
          <FlagPart field="blankBuyer" label="Үргэлж хоосон (гараар)" t={t} inline indicator>
            <span className="text-[10px] text-slate-500">(гараар бөглөнө)</span>
          </FlagPart>
        </Part>
        <Part k="delivery" label="Хүргэлт, машин" t={t}>
          <p>Хүргэлт: {DELIVERY_MN[order.deliveryMethod] ?? order.deliveryMethod}</p>
          {order.vehicleNumber && (
            <p>
              Машин: {order.vehicleNumber}
              {order.driverPhone ? ` · ${order.driverPhone}` : ''}
            </p>
          )}
        </Part>
      </div>
      <DocNote field="headerNote" t={t} />
      <Part k="items" label="Бараа" required t={t}>
        <FlagPart field="showPrices" label="Үнэ, дүн харуулах" t={t} indicator>
          <span className="text-[10px] text-slate-500">үнэ, дүнтэй</span>
        </FlagPart>
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
                    <p key={c} className="text-[10px]">
                      + дагалдах: {c}
                    </p>
                  ))}
                </td>
                <td className="font-mono">{i.product.sku}</td>
                <td>{unitLabel(i.product.unit)}</td>
                <td className="text-right font-semibold">{qty(i.quantity)}</td>
                {prices && <td className="text-right">{tugrik(i.unitPrice)}</td>}
                {prices && <td className="text-right">{tugrik(i.lineTotal)}</td>}
              </tr>
            ))}
            <BlankRows n={tpl?.blankRows ?? 0} cols={cols} />
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
        <BlankRowsControl />
      </Part>
      <DocNote field="footerNote" t={t} />
      <Signatures t={t} />
    </div>
  );
}
