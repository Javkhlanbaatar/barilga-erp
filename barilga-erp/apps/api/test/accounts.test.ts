/* eslint-disable @typescript-eslint/no-explicit-any */
// Partner accounts: who owes whom, offsets (хасалт), purchases from partners, later edits with an audit trail.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AccountsService } from '../src/customers/accounts.service';
import { CustomersService } from '../src/customers/customers.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReceiptsService } from '../src/inventory/receipts.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const D = (n: number) => new Prisma.Decimal(n);
const manager: any = { id: 'u-m', role: Role.MANAGER, name: 'Manager' };
const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };

async function world() {
  const w = makePaymentWorld();
  const accounts = new AccountsService(w.db as any, w.service);
  const partner = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Бартер ХХК', phone: '99112233', creditAllowed: true } });
  /** An order released on account to the partner for `total`. */
  const onAccount = async (total: number, n: string) => {
    const order = await w.db.order.create({ data: { orderNumber: n, status: 'PENDING_PAYMENT', totalMnt: total, customerId: partner.id } });
    await w.service.settleSplits(order.id, [{ method: 'CREDIT', amount: total }] as any);
    return order;
  };
  return { ...w, accounts, partner, onAccount };
}

describe('partner account', () => {
  it('they owe us for goods on account; we owe them for goods we bought — the net is the difference', async () => {
    const w = await world();
    await w.onAccount(300_000, 'BR-1');
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 120_000, description: 'Тоосго авсан' } as any, manager);
    assert.deepEqual(await w.accounts.balance(w.partner.id), { receivableMnt: 300_000, payableMnt: 120_000, netMnt: 180_000 });
    await w.accounts.addEntry(w.partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 20_000, description: 'Бэлнээр төлсөн' } as any, manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 100_000);
  });

  it('offset pays their oldest orders with what we owe them; nothing more than either side', async () => {
    const w = await world();
    const a = await w.onAccount(50_000, 'BR-A');
    const b = await w.onAccount(80_000, 'BR-B');
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 100_000, description: 'Цемент авсан' } as any, manager);

    const res = await w.accounts.offset(w.partner.id, undefined, manager);
    assert.equal(res.offsetMnt, 100_000);
    assert.deepEqual(res.applied, [
      { orderNumber: 'BR-A', amountMnt: 50_000 },
      { orderNumber: 'BR-B', amountMnt: 50_000 },
    ]);
    assert.deepEqual(
      { r: res.receivableMnt, p: res.payableMnt, n: res.netMnt },
      { r: 30_000, p: 0, n: 30_000 },
      'BR-B still owes 30 000; we owe them nothing',
    );
    assert.deepEqual(w.receipts, [a.id], 'BR-A fully settled → its E-Barimt is issued');
    const offsets = w.db.payment.rows.filter((p: any) => p.method === 'OFFSET');
    assert.equal(offsets.reduce((s: number, p: any) => s + p.amountMnt, 0), 100_000);
    void b;
  });

  it('refuses an offset when one side is empty', async () => {
    const w = await world();
    await w.onAccount(50_000, 'BR-A');
    await assert.rejects(() => w.accounts.offset(w.partner.id, undefined, manager), BadRequestException);
  });

  it('the statement walks every movement with a running balance that ends at the net', async () => {
    const w = await world();
    const o = await w.onAccount(100_000, 'BR-S');
    await w.service.settleCredit(o.id, 'TRANSFER', 30_000, 'u-c');
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 40_000, description: 'Элс авсан' } as any, manager);
    const st = await w.accounts.statement(w.partner.id);
    assert.deepEqual(st.lines.map((l: any) => l.effectMnt), [100_000, -30_000, -40_000]);
    assert.equal(st.lines[st.lines.length - 1].balanceMnt, st.netMnt);
    assert.equal(st.netMnt, 30_000);
  });

  it('a later edit keeps before/after/reason for the admin; derived lines cannot be edited by hand', async () => {
    const w = await world();
    const e = await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 10_000, description: 'Хаалга' } as any, manager);
    await w.accounts.editEntry(e.id, { amountMnt: 12_000, reason: 'Нэхэмжлэхийн үнэ буруу байсан' } as any, manager);
    assert.equal(w.db.accountEntry.rows[0].amountMnt, 12_000);
    const audit = w.db.editAudit.rows[0];
    assert.equal(audit.before.amountMnt, 10_000);
    assert.equal(audit.after.amountMnt, 12_000);
    assert.equal(audit.actorId, 'u-m');
    await w.onAccount(5_000, 'BR-O');
    await w.accounts.offset(w.partner.id, 5_000, manager);
    const offsetLine = w.db.accountEntry.rows.find((r: any) => r.kind === 'OFFSET')!;
    await assert.rejects(() => w.accounts.editEntry(offsetLine.id, { amountMnt: 1, reason: 'test' } as any, manager), BadRequestException);
  });

  it('amounts: purchases and payments must be positive, adjustments cannot be 0, offsets are not typed by hand', async () => {
    const w = await world();
    await assert.rejects(() => w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: -5, description: 'xxx' } as any, manager), BadRequestException);
    await assert.rejects(() => w.accounts.addEntry(w.partner.id, { kind: 'ADJUSTMENT', amountMnt: 0, description: 'xxx' } as any, manager), BadRequestException);
    await assert.rejects(() => w.accounts.addEntry(w.partner.id, { kind: 'OFFSET', amountMnt: 5, description: 'xxx' } as any, manager), BadRequestException);
    await w.accounts.addEntry(w.partner.id, { kind: 'ADJUSTMENT', amountMnt: -3_000, description: 'Зөрүү засав' } as any, manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, -3_000);
  });
});

describe('goods received from a partner', () => {
  it('a priced receipt from a registered partner becomes a purchase in their account; a later price fix follows it', async () => {
    const w = await world();
    const inventory = new InventoryService(w.db as any);
    const receipts = new ReceiptsService(w.db as any, inventory);
    const p = await w.db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', stockQty: D(0) } });
    const r = await receipts.create(
      { warehouseId: 'wh-main', supplierName: 'Бартер ХХК', supplierCustomerId: w.partner.id, items: [{ productId: p.id, quantity: 1000, unitCostMnt: 300 }] } as any,
      manager,
    );
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 300_000);

    const itemId = w.db.stockReceiptItem.rows[0].id;
    await assert.rejects(() => receipts.editItemCost(r.id, itemId, 280, 'хямдрал', cashier), ForbiddenException);
    await receipts.editItemCost(r.id, itemId, 280, 'Нийлүүлэгч хямдрал өгсөн', manager);
    assert.equal((await w.accounts.balance(w.partner.id)).payableMnt, 280_000);
    assert.equal(w.db.product.rows.find((x: any) => x.id === p.id)!.lastCostMnt, 280, 'newest receipt → last cost follows');
    const audit = w.db.editAudit.rows.find((a: any) => a.entityType === 'RECEIPT_ITEM')!;
    assert.deepEqual([audit.before.unitCostMnt, audit.after.unitCostMnt, audit.reason], [300, 280, 'Нийлүүлэгч хямдрал өгсөн']);
  });
});

describe('partner kinds', () => {
  it('only a manager or admin can allow credit or mark a supplier / barter partner', async () => {
    const w = await world();
    const svc = new CustomersService(w.db as any);
    await assert.rejects(
      () => svc.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99001122', creditAllowed: true } as any, cashier),
      ForbiddenException,
    );
    const c = await svc.create({ type: 'INDIVIDUAL', name: 'Бат', phone: '99001122' } as any, cashier);
    assert.equal(c!.creditAllowed, false, 'new customers cannot take goods on account until a manager allows it');
    await assert.rejects(() => svc.update(c!.id, { barterContract: 'Г-12' }, cashier), ForbiddenException);
    const updated = await svc.update(c!.id, { creditAllowed: true, sellsToUs: true, barterContract: 'Г-12' }, manager);
    assert.deepEqual([updated!.creditAllowed, updated!.sellsToUs, updated!.barterContract], [true, true, 'Г-12']);
  });
});
