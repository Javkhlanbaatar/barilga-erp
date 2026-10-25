/* eslint-disable @typescript-eslint/no-explicit-any */
// Contract sales (гэрээгээр): a supplier/barter partner takes goods against what we owe them.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AccountsService } from '../src/customers/accounts.service';
import { FeaturesService } from '../src/features/features.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { OrdersService } from '../src/orders/orders.service';
import { makePaymentWorld } from './helpers/payment-fixtures';

const cashier: any = { id: 'u-c', role: Role.BORLUULAGCH, name: 'Cashier' };
const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'Manager' };

async function world(kinds: Record<string, unknown> = { sellsToUs: true }) {
  const w = makePaymentWorld();
  const features = new FeaturesService(w.db as any);
  const orders = new OrdersService(w.db as any, {} as any, w.service, new InventoryService(w.db as any), {} as any, features);
  const accounts = new AccountsService(w.db as any, w.service);
  const partner = await w.db.customer.create({
    data: { type: 'COMPANY', name: 'Бартер ХХК', phone: '99112233', isActive: true, creditAllowed: false, sellsToUs: false, ...kinds },
  });
  return { ...w, orders, accounts, partner };
}

const dto = (customerId: string, payments: any[]) =>
  ({ customerId, deliveryMethod: 'SELF_PICKUP', items: [{ productId: 'p', quantity: 1 }], customerName: 'X', customerPhone: '99112233', payments }) as any;

describe('contract sale (гэрээгээр)', () => {
  it('the order is paid at once out of what we owe the partner — no debt, no money', async () => {
    const w = await world();
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 200_000, description: 'Тоосго авсан' } as any, manager);
    const order = await w.db.order.create({ data: { orderNumber: 'BR-C1', status: 'PENDING_PAYMENT', totalMnt: 150_000, customerId: w.partner.id } });
    await w.service.settleSplits(order.id, [{ method: 'CREDIT', amount: 150_000 }] as any);
    await (w.orders as any).closeAgainstPayable(order.id, 'BR-C1', w.partner.id, 150_000, cashier.id);
    assert.deepEqual(await w.accounts.balance(w.partner.id), { receivableMnt: 0, payableMnt: 50_000, netMnt: -50_000, ordersOwedMnt: 0, ledgerMnt: 50_000 });
    assert.equal(w.db.payment.rows.filter((p: any) => p.method === 'OFFSET').reduce((s: number, p: any) => s + p.amountMnt, 0), 150_000);
    const st = await w.accounts.statement(w.partner.id);
    assert.equal(st.lines[st.lines.length - 1].balanceMnt, -50_000);
  });

  it('if our payable shrank meanwhile, the part stays as a visible debt instead of disappearing', async () => {
    const w = await world();
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 10_000, description: 'Элс авсан' } as any, manager);
    const order = await w.db.order.create({ data: { orderNumber: 'BR-C2', status: 'PENDING_PAYMENT', totalMnt: 50_000, customerId: w.partner.id } });
    await w.service.settleSplits(order.id, [{ method: 'CREDIT', amount: 50_000 }] as any);
    await (w.orders as any).closeAgainstPayable(order.id, 'BR-C2', w.partner.id, 50_000, cashier.id);
    assert.equal((await w.accounts.balance(w.partner.id)).receivableMnt, 50_000);
  });

  it('refuses partners without a supply/barter contract, and amounts above our payable', async () => {
    const plain = await world({});
    await assert.rejects(() => plain.orders.create(dto(plain.partner.id, [{ method: 'CONTRACT', amount: 1000 }]), cashier), ForbiddenException);
    const w = await world({ barterContract: 'Г-1', creditAllowed: true });
    await w.accounts.addEntry(w.partner.id, { kind: 'PURCHASE', amountMnt: 5_000, description: 'Цемент авсан' } as any, manager);
    await assert.rejects(() => w.orders.create(dto(w.partner.id, [{ method: 'CONTRACT', amount: 6_000 }]), cashier), BadRequestException);
    await assert.rejects(
      () => w.orders.create(dto(w.partner.id, [{ method: 'CONTRACT', amount: 1_000 }, { method: 'CREDIT', amount: 1_000 }]), cashier),
      BadRequestException,
    );
  });
});
