/* eslint-disable @typescript-eslint/no-explicit-any */
// Partner ledger: charges, money received (orders first, then advance), cancelling lines, the period statement
// (акт тооцоо), putting an old receipt on a partner's account, and the partner reports.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AccountsService } from '../src/customers/accounts.service';
import { PartnerTradeService } from '../src/customers/partner-trade.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReceiptsService } from '../src/inventory/receipts.service';
import { PartnerReportsService } from '../src/reports/partner-reports.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager' };
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };

async function world() {
  const w = makePaymentWorld();
  const accounts = new AccountsService(w.db as any, w.service);
  const partner = await w.db.customer.create({
    data: { type: 'COMPANY', name: 'Бартер ХХК', phone: '99112233', creditAllowed: true, sellsToUs: true, isActive: true },
  });
  const onAccount = async (total: number, n: string, createdAt = new Date()) => {
    const order = await w.db.order.create({ data: { orderNumber: n, status: 'PENDING_PAYMENT', totalMnt: total, customerId: partner.id, createdAt } });
    await w.service.settleSplits(order.id, [{ method: 'CREDIT', amount: total }] as any);
    return order;
  };
  // An open drawer for the manager, so cash lines can be checked against it.
  const session = await w.db.cashSession.create({ data: { userId: manager.id, status: 'OPEN', openingFloatMnt: 0, openedAt: new Date() } });
  return { ...w, accounts, partner, onAccount, session };
}

describe('partner ledger', () => {
  it('a charge makes them owe us without an order; it shows as receivable', async () => {
    const w = await world();
    await w.accounts.addEntry(w.partner.id, { kind: 'CHARGE', amountMnt: 40_000, description: 'Тээврийн хөлс' } as any, manager);
    const b = await w.accounts.balance(w.partner.id);
    assert.equal(b.receivableMnt, 40_000);
    assert.equal(b.payableMnt, 0);
    assert.equal(b.netMnt, 40_000);
  });

  it('money from the partner pays their orders first; the rest is their advance (and cash enters the drawer)', async () => {
    const w = await world();
    await w.onAccount(100_000, 'BR-1');
    const r: any = await w.accounts.receive(w.partner.id, 150_000, 'CASH', 'Урьдчилгаа', manager);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].amountMnt, 100_000);
    assert.equal(r.advanceMnt, 50_000);
    assert.equal(r.ordersOwedMnt, 0);
    assert.equal(r.payableMnt, 50_000, 'the advance is what we now owe them');
    const moves = w.db.cashMovement.rows.filter((m: any) => m.sessionId === w.session.id);
    assert.deepEqual(moves.map((m: any) => [m.kind, m.amountMnt]), [['IN', 50_000]], 'only the advance is a drawer movement; order payments count as sales');
  });

  it('paying a partner in cash takes it out of the drawer; cancelling puts it back and is kept in the history', async () => {
    const w = await world();
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 80_000, description: 'Цемент авсан' } as any, manager);
    const pay: any = await w.accounts.addEntry(w.partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 30_000, description: 'Бэлнээр төлсөн', method: 'CASH' } as any, manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 50_000);
    await w.accounts.voidEntry(pay.id, 'Буруу бүртгэсэн', manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 80_000);
    await assert.rejects(() => w.accounts.voidEntry(pay.id, 'Дахин', manager), ConflictException);
    await assert.rejects(() => w.accounts.editEntry(pay.id, { amountMnt: 1, reason: 'test' } as any, manager), BadRequestException);
    const moves = w.db.cashMovement.rows.map((m: any) => [m.kind, m.amountMnt]);
    assert.deepEqual(moves, [['OUT', 30_000], ['IN', 30_000]]);
    const st: any = await w.accounts.statement(w.partner.id);
    assert.ok(st.lines.find((l: any) => l.entryId === pay.id).voided, 'the cancelled line stays, marked');
    assert.equal(w.db.editAudit.rows.length, 1);
  });

  it('a cash line cannot change its amount by editing (it would not match the drawer)', async () => {
    const w = await world();
    const pay: any = await w.accounts.addEntry(w.partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 10_000, description: 'Бэлнээр', method: 'CASH' } as any, manager);
    await assert.rejects(() => w.accounts.editEntry(pay.id, { amountMnt: 12_000, reason: 'буруу' } as any, manager), BadRequestException);
    await w.accounts.editEntry(pay.id, { description: 'Бэлнээр төлсөн (баримт 12)', reason: 'тайлбар' } as any, manager);
  });

  it('money from the partner is not typed as a plain line (it goes through receive)', async () => {
    const w = await world();
    await assert.rejects(
      () => w.accounts.addEntry(w.partner.id, { kind: 'PAYMENT_FROM_PARTNER', amountMnt: 5, description: 'xxx' } as any, manager),
      BadRequestException,
    );
  });

  it('the period statement: brought forward + debit − credit = closing, and the closing up to today is the net', async () => {
    const w = await world();
    await w.onAccount(200_000, 'BR-OLD', new Date('2026-09-10T04:00:00Z'));
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 50_000, description: 'Хуучин худалдан авалт', occurredAt: '2026-09-15T04:00:00Z' } as any, manager);
    await w.onAccount(70_000, 'BR-NEW');
    await w.accounts.addEntry(w.partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 10_000, description: 'Төлсөн' } as any, manager);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
    const st: any = await w.accounts.statement(w.partner.id, { from: '2026-10-01', to: today });
    assert.equal(st.period.openingMnt, 200_000 - 50_000);
    assert.equal(st.period.debitMnt, 70_000 + 10_000);
    assert.equal(st.period.creditMnt, 0);
    assert.equal(st.period.closingMnt, st.period.openingMnt + st.period.debitMnt - st.period.creditMnt);
    assert.equal(st.period.closingMnt, st.netMnt);
    assert.equal(st.lines.length, 2, 'only the lines in the period');
    assert.equal(st.lines.at(-1).balanceMnt, st.period.closingMnt);
  });

  it('an old receipt is put on a partner afterwards: its priced lines become what we owe them', async () => {
    const w = await world();
    const inventory = new InventoryService(w.db as any);
    const receipts = new ReceiptsService(w.db as any, inventory);
    const p = await w.db.product.create({ data: { sku: 'CEM', nameMn: 'Цемент', stockQty: D(0) } });
    const rec: any = await receipts.create({ warehouseId: 'wh-main', supplierName: 'Гараар бичсэн', items: [{ productId: p.id, quantity: 10, unitCostMnt: 15_000 }] } as any, manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 0);
    await receipts.attachPartner(rec.id, w.partner.id, 'Нийлүүлэгч нь Бартер ХХК байсан', manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 150_000);
    await assert.rejects(() => receipts.attachPartner(rec.id, w.partner.id, 'дахин', manager), BadRequestException);
    await receipts.attachPartner(rec.id, null, 'Буцааж салгав', manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 0);
  });
});

describe('partner money and a branch manager', () => {
  const branch: any = { id: 'u-b', role: Role.MANAGER, name: 'Branch', warehouseId: 'wh-a', warehouseIds: ['wh-a'] };
  async function twoBranches() {
    const w = await world();
    const owe = async (n: string, total: number, warehouseId: string) => {
      const o = await w.db.order.create({ data: { orderNumber: n, status: 'PENDING_PAYMENT', totalMnt: total, customerId: w.partner.id, warehouseId } });
      await w.service.settleSplits(o.id, [{ method: 'CREDIT', amount: total }] as any);
      return o;
    };
    await owe('BR-A', 200_000, 'wh-a');
    await owe('BR-B', 300_000, 'wh-b');
    return w;
  }

  it('a branch manager cannot turn money into an advance while another branch is still owed', async () => {
    const w = await twoBranches();
    await assert.rejects(() => w.accounts.receive(w.partner.id, 500_000, 'TRANSFER', '', branch), BadRequestException);
    assert.equal((await w.accounts.balance(w.partner.id)).ordersOwedMnt, 500_000, 'nothing was settled');
    const r: any = await w.accounts.receive(w.partner.id, 200_000, 'TRANSFER', '', branch);
    assert.deepEqual(r.applied.map((a: any) => a.orderNumber), ['BR-A']);
    assert.equal(r.advanceMnt, 0);
    assert.equal(r.ordersOwedMnt, 300_000, "the other branch's order stays for that branch");
  });

  it('an order paid meanwhile is skipped: the money is recorded once, the rest as an advance', async () => {
    const w = await world();
    await w.onAccount(100_000, 'BR-1');
    await w.onAccount(50_000, 'BR-2');
    const real = w.service.settleCredit.bind(w.service);
    let calls = 0;
    (w.service as any).settleCredit = async (...args: any[]) => {
      if (++calls === 2) throw new ConflictException('This debt was just changed by someone else');
      return real(...(args as Parameters<typeof real>));
    };
    const r: any = await w.accounts.receive(w.partner.id, 150_000, 'TRANSFER', '', manager);
    assert.deepEqual(r.applied.map((a: any) => a.orderNumber), ['BR-1']);
    assert.equal(r.advanceMnt, 50_000);
  });

  it('the trade view shows a branch manager only the receipts of their warehouses', async () => {
    const w = await world();
    for (const [n, wh] of [['OR-A', 'wh-a'], ['OR-B', 'wh-b']]) {
      await w.db.warehouse.create({ data: { id: wh, code: wh, name: wh, isActive: true, isDefault: false } });
      await w.db.stockReceipt.create({
        data: { receiptNumber: n, warehouseId: wh, supplierName: 'Бартер ХХК', supplierCustomerId: w.partner.id, receivedAt: new Date(), receivedById: manager.id },
      });
    }
    const trade = new PartnerTradeService(w.db as any);
    assert.deepEqual(((await trade.trade(w.partner.id, {}, branch)) as any).purchases.map((p: any) => p.receiptNumber), ['OR-A']);
    assert.equal(((await trade.trade(w.partner.id, {}, manager)) as any).purchases.length, 2);
  });

  it('a cancelled purchase is not counted in purchases by supplier', async () => {
    const w = await world();
    const e: any = await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 1_000_000, description: 'Ачилтын үйлчилгээ' } as any, manager);
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 30_000, description: 'Тээвэр' } as any, manager);
    await w.accounts.voidEntry(e.id, 'Буруу харилцагч', manager);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());
    const rep: any = await new PartnerReportsService(w.db as any).purchasesBySupplier({ startDate: today, endDate: today }, manager);
    assert.equal(rep.suppliers.find((s: any) => s.customerId === w.partner.id).otherMnt, 30_000);
  });
});

describe('trade with one partner and partner reports', () => {
  it('shows what we sold them (with goods and how it was paid) and, for managers only, what we bought', async () => {
    const w = await world();
    const p = await w.db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', unit: 'ш', stockQty: D(0) } });
    const o = await w.onAccount(50_000, 'BR-T');
    await w.db.orderItem.create({ data: { orderId: o.id, productId: p.id, quantity: D(100), unitPrice: 500, lineTotal: 50_000, sourceType: 'INTERNAL' } });
    await w.db.order.update({ where: { id: o.id }, data: { status: 'COMPLETED' } });
    await w.db.stockReceipt.create({
      data: { receiptNumber: 'OR-1', warehouseId: 'wh-main', supplierName: 'Бартер ХХК', supplierCustomerId: w.partner.id, receivedAt: new Date(), receivedById: manager.id },
    });
    const trade = new PartnerTradeService(w.db as any);
    const t: any = await trade.trade(w.partner.id, {}, manager);
    assert.equal(t.totals.salesCount, 1);
    assert.equal(t.totals.owedMnt, 50_000);
    assert.equal(t.sales[0].items[0].nameMn, 'Тоосго');
    assert.equal(t.purchases.length, 1);
    const asCashier: any = await trade.trade(w.partner.id, {}, cashier);
    assert.equal(asCashier.purchasesShown, false);
    assert.equal(asCashier.purchases.length, 0);
  });

  it('aging puts each unpaid amount in its day bucket', async () => {
    const w = await world();
    await w.onAccount(10_000, 'BR-A', new Date(Date.now() - 5 * 86_400_000));
    await w.onAccount(20_000, 'BR-B', new Date(Date.now() - 45 * 86_400_000));
    await w.onAccount(30_000, 'BR-C', new Date(Date.now() - 120 * 86_400_000));
    const rep = new PartnerReportsService(w.db as any);
    const a: any = await rep.aging(manager);
    const row = a.customers.find((c: any) => c.customerId === w.partner.id);
    assert.deepEqual([row.d0_30, row.d31_60, row.d61_90, row.d90p], [10_000, 20_000, 0, 30_000]);
    assert.equal(row.totalMnt, 60_000);
    assert.ok(row.oldestDays >= 119);
  });
});
