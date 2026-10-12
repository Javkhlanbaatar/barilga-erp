/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PaymentController } from '../src/payment/payment.controller';
import { PublicController } from '../src/public/public.controller';
import { PublicService } from '../src/public/public.service';
import { RATE_LIMIT_KEY, RateLimit, RateLimitGuard } from '../src/common/rate-limit/rate-limit.guard';
import { makeConfig } from './helpers/payment-fixtures';

class Dummy {
  @RateLimit({ name: 'dummy', limit: 3, windowMs: 80 })
  handler() {
    return 'ok';
  }
}

function ctx(ip: string, headers: Record<string, string> = {}) {
  const res = { setHeader: (k: string, v: string) => void (headers[k] = v) };
  return {
    getHandler: () => Dummy.prototype.handler,
    getClass: () => Dummy,
    switchToHttp: () => ({ getRequest: () => ({ ip }), getResponse: () => res }),
  } as any;
}

describe('rate limit guard', () => {
  beforeEach(() => RateLimitGuard.reset());
  const guard = () => new RateLimitGuard(new Reflector());

  it('allows up to the limit, then answers 429 with Retry-After', () => {
    const g = guard();
    const headers: Record<string, string> = {};
    for (let i = 0; i < 3; i++) assert.equal(g.canActivate(ctx('1.1.1.1', headers)), true);
    assert.throws(
      () => g.canActivate(ctx('1.1.1.1', headers)),
      (err: unknown) => err instanceof HttpException && err.getStatus() === 429,
    );
    assert.ok(Number(headers['Retry-After']) >= 1);
  });

  it('counts each client separately', () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.canActivate(ctx('1.1.1.1'));
    assert.equal(g.canActivate(ctx('2.2.2.2')), true);
  });

  it('lets a client back in once the window has passed', async () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.canActivate(ctx('3.3.3.3'));
    assert.throws(() => g.canActivate(ctx('3.3.3.3')));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g.canActivate(ctx('3.3.3.3')), true);
  });
});

describe('public controller is fully rate limited', () => {
  const routes = ['config', 'catalog', 'quote', 'create', 'find', 'updateTransport', 'invoice'] as const;

  it('every public route carries a limit, and order creation is the tightest', () => {
    const meta = (name: (typeof routes)[number]) =>
      Reflect.getMetadata(RATE_LIMIT_KEY, (PublicController.prototype as any)[name]) as { limit: number; windowMs: number } | undefined;
    for (const r of routes) assert.ok(meta(r), `${r} has no @RateLimit`);
    const create = meta('create')!;
    assert.ok(create.limit <= 5 && create.windowMs >= 600_000);
    const own = Object.getOwnPropertyNames(PublicController.prototype).filter((n) => n !== 'constructor');
    assert.deepEqual([...own].sort(), [...routes].sort(), 'a new public route was added without updating this test');
  });

  it('the controller is guarded by RateLimitGuard', () => {
    const guards = Reflect.getMetadata('__guards__', PublicController) as unknown[];
    assert.ok(guards?.includes(RateLimitGuard));
  });

  it('the unauthenticated QPay webhook is rate limited too', () => {
    const meta = Reflect.getMetadata(RATE_LIMIT_KEY, (PaymentController.prototype as any).webhook);
    assert.ok(meta && meta.limit > 0);
  });
});

describe('public order creation is sanitised', () => {
  function world(open = 0, env: Record<string, string> = {}) {
    const calls: any[] = [];
    const prisma: any = {
      user: { findUnique: async () => ({ id: 'webshop-id', email: null, username: 'webshop', role: 'BORLUULAGCH', fullName: 'Web', isActive: true }) },
      order: { count: async () => open },
    };
    const orders: any = {
      create: async (dto: any) => (calls.push(dto), { trackingToken: 'tok' }),
      findPublicByToken: async (t: string) => ({ narrow: true, trackingToken: t }),
    };
    return { calls, svc: new PublicService(prisma, orders, makeConfig(env)) };
  }
  const base: any = {
    items: [{ productId: 'p1', quantity: 2, sourceType: 'EXTERNAL_SUPPLIER', supplierName: 'x' }],
    deliveryMethod: 'OUR_DELIVERY',
    unloadingRequested: false,
    customerName: 'A',
    customerPhone: ' 99112233 ',
    paymentMethod: 'CASH',
    payments: [{ method: 'CASH', amount: 1 }],
    billType: 'COMPANY',
    customerRegNumber: '1234567',
    customerId: 'someone-elses-customer',
  };

  it('forces QPay, drops staff-only fields and returns only the narrow public shape', async () => {
    const { calls, svc } = world();
    const res = await svc.create({ ...base });
    const sent = calls[0];
    assert.equal(sent.paymentMethod, 'QPAY');
    assert.equal(sent.payments, undefined);
    assert.equal(sent.billType, undefined);
    assert.equal(sent.customerId, undefined, 'a visitor cannot attach the order to a registered customer');
    assert.deepEqual(sent.items, [{ productId: 'p1', quantity: 2, sourceType: 'INTERNAL' }]);
    assert.equal(sent.customerPhone, '99112233');
    assert.deepEqual(res, { narrow: true, trackingToken: 'tok' });
  });

  it('refuses another order when the phone already has too many unpaid ones', async () => {
    const { svc, calls } = world(5);
    await assert.rejects(
      () => svc.create({ ...base }),
      (err: unknown) => err instanceof HttpException && err.getStatus() === 429,
    );
    assert.equal(calls.length, 0);
  });

  it('the cap is configurable', async () => {
    const { svc } = world(5, { PUBLIC_MAX_OPEN_ORDERS_PER_PHONE: '10' });
    await svc.create({ ...base });
  });
});
