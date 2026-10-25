/* eslint-disable @typescript-eslint/no-explicit-any */
// Rights per person: what the role allows by default, what the admin gives or takes, and where it is enforced.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { can, effectivePermissions, normalizeOverrides, PERMISSION_KEY_META } from '../src/auth/permissions';
import { RolesGuard } from '../src/auth/roles.guard';
import { HrService } from '../src/hr/hr.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReceiptsService } from '../src/inventory/receipts.service';
import { UsersService } from '../src/users/users.service';
import { FakeDb } from './helpers/fake-db';

const D = (n: number) => new Prisma.Decimal(n);
const cashier = (permissions?: any): any => ({ id: 'u-c', role: Role.BORLUULAGCH, name: 'Кассчин', warehouseId: 'wh-main', warehouseIds: ['wh-main'], permissions });
const admin: any = { id: 'u-a', role: Role.ADMIN, name: 'Admin' };

describe('rights per person', () => {
  it('the role decides until the admin changes the person', () => {
    assert.equal(can(cashier(), 'ORDER_CANCEL'), true);
    assert.equal(can(cashier({ revoke: ['ORDER_CANCEL'] }), 'ORDER_CANCEL'), false, 'taken away');
    assert.equal(can(cashier(), 'PRODUCT_WRITE'), false);
    assert.equal(can(cashier({ grant: ['PRODUCT_WRITE'] }), 'PRODUCT_WRITE'), true, 'given');
    assert.equal(can(cashier({ grant: ['SALARY_SET'] }), 'SALARY_SET'), false, 'pay rights are never given to other roles');
    assert.equal(can({ ...admin, permissions: { revoke: ['PRODUCT_WRITE'] } }, 'PRODUCT_WRITE'), true, 'the admin keeps everything');
    assert.equal(can({ role: Role.SUPER_MANAGER } as any, 'PARTNER_LEDGER'), true, 'the general manager passes manager rights');
    assert.ok(effectivePermissions(cashier({ revoke: ['RETURN_CREATE'] })).every((k) => k !== 'RETURN_CREATE'));
  });

  it('what the admin sends is cleaned: unknown keys, non-givable grants and contradictions are dropped', () => {
    assert.deepEqual(normalizeOverrides({ grant: ['PRODUCT_WRITE', 'NOPE', 'SALARY_SET', 'ORDER_CANCEL'], revoke: ['ORDER_CANCEL', 'X'] }), {
      grant: ['PRODUCT_WRITE'],
      revoke: ['ORDER_CANCEL'],
    });
  });

  it('the guard checks the right (and keeps reading open for the listed roles)', () => {
    const guardFor = (rule: any) =>
      new RolesGuard({ getAllAndOverride: (key: string) => (key === PERMISSION_KEY_META ? rule : undefined) } as any);
    const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user, method: 'POST', url: '/x' }) }), getHandler: () => null, getClass: () => null }) as any;
    assert.throws(() => guardFor({ key: 'ORDER_CANCEL', alsoRoles: [] }).canActivate(ctx(cashier({ revoke: ['ORDER_CANCEL'] }))), ForbiddenException);
    assert.equal(guardFor({ key: 'PRODUCT_WRITE', alsoRoles: [] }).canActivate(ctx(cashier({ grant: ['PRODUCT_WRITE'] }))), true);
    assert.equal(guardFor({ key: 'PRICE_LIST_WRITE', alsoRoles: [Role.ADMIN, Role.MANAGER] }).canActivate(ctx({ id: 'b', role: Role.MANAGER })), true, 'a branch manager still reads');
    assert.throws(() => guardFor({ key: 'PRICE_LIST_WRITE', alsoRoles: [] }).canActivate(ctx({ id: 'b', role: Role.MANAGER })), ForbiddenException);
  });

  it('the admin sets a person’s rights; changes are kept in the edits report; an admin cannot be limited', async () => {
    const db = new FakeDb();
    const users = new UsersService(db as any);
    const u = await db.user.create({ data: { username: 'k', fullName: 'Кассчин', role: 'BORLUULAGCH', isActive: true, managedWarehouses: [] } as any });
    const a = await db.user.create({ data: { username: 'a', fullName: 'Админ', role: 'ADMIN', isActive: true } as any });
    await users.setPermissions(u.id, { grant: ['RECEIPT_CREATE', 'ORDER_CANCEL'], revoke: ['RETURN_CREATE', 'PRODUCT_WRITE'] }, a.id);
    const saved: any = db.user.rows.find((r: any) => r.id === u.id).permissions;
    assert.deepEqual(saved, { grant: ['RECEIPT_CREATE'], revoke: ['RETURN_CREATE'] }, 'no-op entries are not kept');
    assert.equal(db.editAudit.rows.filter((r: any) => r.entityType === 'USER_PERMISSIONS').length, 1);
    await assert.rejects(() => users.setPermissions(a.id, { grant: [], revoke: ['PRODUCT_WRITE'] }, a.id), BadRequestException);
  });

  it('one right does not open another: partner cash needs the cash right, settling their orders the debt right', async () => {
    assert.deepEqual(normalizeOverrides({ grant: ['PARTNER_LEDGER'], revoke: [] }).grant, [], 'the partner ledger is never given to other roles');
    const { makePaymentWorld } = await import('./helpers/payment-fixtures');
    const { AccountsService } = await import('../src/customers/accounts.service');
    const w = makePaymentWorld();
    const accounts = new AccountsService(w.db as any, w.service);
    const partner = await w.db.customer.create({ data: { type: 'COMPANY', name: 'Түнш', phone: '1', sellsToUs: true, isActive: true } });
    const manager: any = { id: 'u-m', role: Role.SUPER_MANAGER, name: 'M', permissions: { revoke: ['CASH_MOVEMENT', 'PAY_DEBT'] } };
    await w.db.cashSession.create({ data: { userId: manager.id, status: 'OPEN', openingFloatMnt: 0, openedAt: new Date() } });
    await assert.rejects(
      () => accounts.addEntry(partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 10_000, description: 'Бэлнээр', method: 'CASH' } as any, manager),
      ForbiddenException,
    );
    await accounts.addEntry(partner.id, { kind: 'PAYMENT_TO_PARTNER', amountMnt: 10_000, description: 'Шилжүүлгээр', method: 'TRANSFER' } as any, manager);
    const o = await w.db.order.create({ data: { orderNumber: 'BR-1', status: 'PENDING_PAYMENT', totalMnt: 5_000, customerId: partner.id } });
    await w.service.settleSplits(o.id, [{ method: 'CREDIT', amount: 5_000 }] as any);
    await assert.rejects(() => accounts.receive(partner.id, 5_000, 'TRANSFER', '', manager), ForbiddenException, 'collecting their order debt needs PAY_DEBT');
  });

  it('a right given is honoured inside the services too (receipt prices, attendance)', async () => {
    const db = new FakeDb();
    const receipts = new ReceiptsService(db as any, new InventoryService(db as any));
    const p = await db.product.create({ data: { sku: 'BRK', nameMn: 'Тоосго', stockQty: D(0) } });
    const picker: any = { id: 'u-p', role: Role.ACHIGCH_BELTGEGCH, name: 'P', warehouseId: 'wh-main', warehouseIds: ['wh-main'] };
    await assert.rejects(
      () => receipts.create({ warehouseId: 'wh-main', supplierName: 'Нийлүүлэгч', items: [{ productId: p.id, quantity: 1, unitCostMnt: 500 }] } as any, picker),
      ForbiddenException,
    );
    const rec: any = await receipts.create(
      { warehouseId: 'wh-main', supplierName: 'Нийлүүлэгч', items: [{ productId: p.id, quantity: 1, unitCostMnt: 500 }] } as any,
      { ...picker, permissions: { grant: ['RECEIPT_COST_EDIT'] } },
    );
    assert.equal(rec.items[0].unitCostMnt, 500);

    const hr = new HrService(db as any);
    const staff = await db.user.create({ data: { username: 's', fullName: 'Ажилтан', role: 'ACHIGCH_BELTGEGCH', isActive: true, warehouseId: 'wh-main' } as any });
    await assert.rejects(() => hr.checkIn(cashier(), { userId: staff.id } as any), ForbiddenException);
    await hr.checkIn(cashier({ grant: ['ATTENDANCE_MANAGE'] }), { userId: staff.id } as any);
  });
});
