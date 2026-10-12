/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal in-memory stand-in for the slice of Prisma these tests exercise.
// It supports equality / in / not / lt / lte / gt / gte / startsWith / OR / AND / NOT, a few relation
// filters, conditional updateMany (the atomic-claim pattern the services rely on), and transaction rollback.
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

type Row = Record<string, any>;

const isDecimal = (v: unknown) => v instanceof Prisma.Decimal;
const isPlain = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !isDecimal(v);

const norm = (v: unknown) => (v === undefined ? null : v);
const num = (v: any) => (v instanceof Date ? v.getTime() : Number(v));
const same = (a: any, b: any) => {
  a = norm(a);
  b = norm(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
};

function matchValue(value: any, cond: any): boolean {
  if (!isPlain(cond)) return same(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'in':
        if (!(arg as any[]).includes(value)) return false;
        break;
      case 'not':
        if (matchValue(value, arg)) return false;
        break;
      case 'lt':
        if (!(num(value) < num(arg))) return false;
        break;
      case 'lte':
        if (!(num(value) <= num(arg))) return false;
        break;
      case 'gt':
        if (!(num(value) > num(arg))) return false;
        break;
      case 'gte':
        if (!(num(value) >= num(arg))) return false;
        break;
      case 'startsWith':
        if (!String(value ?? '').startsWith(String(arg))) return false;
        break;
      case 'contains': {
        // Like Postgres LIKE: case-sensitive unless mode: 'insensitive'.
        const fold = (s: string) => (cond.mode === 'insensitive' ? s.toLowerCase() : s);
        if (!fold(String(value ?? '')).includes(fold(String(arg)))) return false;
        break;
      }
      case 'mode':
        break;
      default:
        throw new Error(`fake-db: unsupported operator ${op}`);
    }
  }
  return true;
}

const NESTED_ITEMS: Record<string, { table: string; fk: string }> = {
  stockTransfer: { table: 'stockTransferItem', fk: 'transferId' },
  salesReturn: { table: 'returnItem', fk: 'returnId' },
  stockReceipt: { table: 'stockReceiptItem', fk: 'receiptId' },
};

class Table {
  rows: Row[] = [];
  constructor(
    private readonly db: FakeDb,
    readonly name: string,
    private readonly defaults: () => Row,
  ) {}

  matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Row[]).some((w) => this.matches(row, w))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!(cond as Row[]).every((w) => this.matches(row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (this.matches(row, cond)) return false;
        continue;
      }
      if (key === 'warehouseId_productId') {
        const k = cond as Row;
        if (row.warehouseId !== k.warehouseId || row.productId !== k.productId) return false;
        continue;
      }
      const rel = this.db.relation(this.name, row, key, cond);
      if (rel !== undefined) {
        if (!rel) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  private decorate(row: Row, args: Row = {}): Row {
    const out: Row = { ...row };
    const include = args.include as Row | undefined;
    if (include && this.name === 'order') {
      if (include.payments) out.payments = this.db.payment.rows.filter((p) => p.orderId === row.id).map((p) => ({ ...p }));
      if (include.items) {
        out.items = this.db.orderItem.rows
          .filter((i) => i.orderId === row.id)
          .map((i) => {
            const item: Row = { ...i };
            if (isPlain(include.items) && include.items.include?.product) {
              const p = this.db.product.rows.find((x) => x.id === i.productId);
              if (p) item.product = { ...p };
            }
            if (isPlain(include.items) && include.items.include?.returnItems) {
              item.returnItems = this.db.returnItem.rows.filter((r) => r.orderItemId === i.id).map((r) => ({ ...r }));
            }
            return item;
          });
      }
    }
    return out;
  }

  async findMany(args: Row = {}) {
    let rows = this.rows.filter((r) => this.matches(r, args.where));
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    return rows.map((r) => this.decorate(r, args));
  }
  async findFirst(args: Row = {}) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    return row ? this.decorate(row, args) : null;
  }
  async findUnique(args: Row) {
    return this.findFirst(args);
  }
  async findUniqueOrThrow(args: Row) {
    const row = await this.findFirst(args);
    if (!row) throw new Error(`fake-db: ${this.name} not found`);
    return row;
  }
  async count(args: Row = {}) {
    return this.rows.filter((r) => this.matches(r, args.where)).length;
  }
  async create(args: Row) {
    const now = new Date();
    const data = Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined));
    // Nested `items: { create: [...] }` for the parents that use it.
    const nested = NESTED_ITEMS[this.name];
    const nestedItems = nested && isPlain(data.items) ? (data.items.create as Row[]) : null;
    if (nestedItems) delete data.items;
    const row: Row = { id: randomUUID(), createdAt: now, updatedAt: now, ...this.defaults(), ...data };
    this.rows.push(row);
    for (const item of nestedItems ?? []) {
      await (this.db as any)[nested!.table].create({ data: { ...item, [nested!.fk]: row.id } });
    }
    return { ...row };
  }
  private apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (isPlain(value) && ('increment' in value || 'decrement' in value)) {
        const base = new Prisma.Decimal((row[key] ?? 0).toString());
        const delta = new Prisma.Decimal(((value.increment ?? value.decrement) as any).toString());
        row[key] = 'increment' in value ? base.plus(delta) : base.minus(delta);
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = new Date();
  }
  async updateMany(args: Row) {
    const hits = this.rows.filter((r) => this.matches(r, args.where));
    hits.forEach((r) => this.apply(r, args.data));
    return { count: hits.length };
  }
  async upsert(args: Row) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (row) {
      this.apply(row, args.update);
      return { ...row };
    }
    return this.create({ data: args.create });
  }
  async update(args: Row) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (!row) throw new Error(`fake-db: ${this.name} not found for update`);
    this.apply(row, args.data);
    return { ...row };
  }
}

export class FakeDb {
  order = new Table(this, 'order', () => ({
    notes: null, status: 'PENDING_PAYMENT', ebarimtStatus: 'NOT_ISSUED', ebarimtAttempts: 0,
    receiptId: null, vehicleNumber: null, driverPhone: null, driverName: null,
    deliveryMethod: 'SELF_PICKUP', completedAt: null, completedById: null, preparedAt: null, preparedById: null,
    feesOverridden: false, pickingStartedAt: null, pickingStartedById: null,
  }));
  payment = new Table(this, 'payment', () => ({
    status: 'UNPAID', provider: 'QPAY', method: 'QPAY', qpayInvoiceId: null, qpayPayload: null,
    paidAt: null, pollAttempts: 0, nextPollAt: null, lastPollError: null,
  }));
  orderItem = new Table(this, 'orderItem', () => ({ sourceType: 'INTERNAL', supplierName: null, pickedAt: null, pickedById: null }));
  product = new Table(this, 'product', () => ({ stockQty: new Prisma.Decimal(0), active: true }));
  returnItem = new Table(this, 'returnItem', () => ({}));
  supplierPayable = new Table(this, 'supplierPayable', () => ({ status: 'OPEN' }));
  feeOverrideAudit = new Table(this, 'feeOverrideAudit', () => ({}));
  warehouse = new Table(this, 'warehouse', () => ({ isActive: true, isDefault: false }));
  stockBalance = new Table(this, 'stockBalance', () => ({ quantity: new Prisma.Decimal(0) }));
  stockMovement = new Table(this, 'stockMovement', () => ({ refType: null, refId: null, reason: null, actorId: null }));
  customer = new Table(this, 'customer', () => ({ isActive: true, regNumber: null, email: null, address: null, notes: null }));
  stockTransfer = new Table(this, 'stockTransfer', () => ({
    status: 'IN_TRANSIT', notes: null, sentAt: new Date(), receivedById: null, receivedAt: null,
    cancelledById: null, cancelledAt: null, cancelReason: null,
  }));
  stockTransferItem = new Table(this, 'stockTransferItem', () => ({}));
  featureFlag = new Table(this, 'featureFlag', () => ({ updatedById: null }));
  user = new Table(this, 'user', () => ({ isActive: true, warehouseId: null }));
  salesReturn = new Table(this, 'salesReturn', () => ({ refundStatus: 'PENDING_PAYOUT' }));
  stockReceipt = new Table(this, 'stockReceipt', () => ({ supplierInvoiceNo: null, notes: null, receivedAt: new Date() }));
  stockReceiptItem = new Table(this, 'stockReceiptItem', () => ({ unitCostMnt: null }));
  appSetting = new Table(this, 'appSetting', () => ({ updatedById: null }));

  constructor() {
    // Mirrors the migration: there is always exactly one default warehouse.
    this.warehouse.rows.push({
      id: 'wh-main', code: 'MAIN', name: 'Main', isActive: true, isDefault: true, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  relation(table: string, row: Row, key: string, cond: any): boolean | undefined {
    if (table === 'payment' && key === 'order') {
      const order = this.order.rows.find((o) => o.id === row.orderId);
      return !!order && this.order.matches(order, cond);
    }
    if (table === 'order' && key === 'payments') {
      const mine = this.payment.rows.filter((p) => p.orderId === row.id);
      if (cond.some && !mine.some((p) => this.payment.matches(p, cond.some))) return false;
      if (cond.none && mine.some((p) => this.payment.matches(p, cond.none))) return false;
      return true;
    }
    if (table === 'stockTransferItem' && key === 'transfer') {
      const transfer = this.stockTransfer.rows.find((t) => t.id === row.transferId);
      return !!transfer && this.stockTransfer.matches(transfer, cond);
    }
    if (table === 'returnItem' && key === 'orderItem') {
      const item = this.orderItem.rows.find((i) => i.id === row.orderItemId);
      return !!item && this.orderItem.matches(item, cond);
    }
    return undefined;
  }

  private tables() {
    return [
      this.order, this.payment, this.orderItem, this.product, this.returnItem, this.supplierPayable, this.feeOverrideAudit,
      this.warehouse, this.stockBalance, this.stockMovement,
      this.customer, this.stockTransfer, this.stockTransferItem, this.featureFlag, this.user,
      this.salesReturn, this.stockReceipt, this.stockReceiptItem, this.appSetting,
    ];
  }

  // Interactive transactions run one at a time (like SERIALIZABLE), each with rollback on error.
  private txQueue: Promise<unknown> = Promise.resolve();

  async $transaction(arg: any) {
    if (typeof arg !== 'function') return Promise.all(arg);
    const run = async () => {
      const snapshot = this.tables().map((t) => t.rows.map((r) => ({ ...r })));
      try {
        return await arg(this);
      } catch (err) {
        this.tables().forEach((t, i) => {
          t.rows = snapshot[i];
        });
        throw err;
      }
    };
    const result = this.txQueue.then(run, run);
    this.txQueue = result.catch(() => undefined);
    return result;
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
