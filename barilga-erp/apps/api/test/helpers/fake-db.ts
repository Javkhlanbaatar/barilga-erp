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
      case 'notIn':
        if ((arg as any[]).includes(value)) return false;
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

/** Relation names that differ from the table name. */
const RELATION_TABLE: Record<string, string> = { receipt: 'stockReceipt', transfer: 'stockTransfer', createdBy: 'user' };

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
      if (key === 'warehouseId_productId' || key === 'userId_periodMonth' || key === 'userId_fromMonth') {
        // Compound unique keys: every named field must match.
        for (const [field, v] of Object.entries(cond as Row)) if (row[field] !== v) return false;
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
    // A `select` naming relations is treated like an include of those relations (scalars are all returned).
    const select = isPlain(args.select) ? (args.select as Row) : undefined;
    const include = (args.include as Row | undefined) ??
      (select ? Object.fromEntries(Object.entries(select).filter(([, v]) => isPlain(v))) : undefined);
    // Generic to-one include: `include: { receipt: ... }` on a row with `receiptId` attaches that parent,
    // decorated with its own nested include/select.
    for (const [key, value] of Object.entries(include ?? {})) {
      const parentTable = (this.db as any)[RELATION_TABLE[key] ?? key];
      if (parentTable instanceof Table && `${key}Id` in row && !(key in out && key !== 'order')) {
        const parent = parentTable.rows.find((p: Row) => p.id === row[`${key}Id`]);
        out[key] = parent ? parentTable.decorate(parent, isPlain(value) ? (value as Row) : {}) : null;
      }
    }
    // To-many `items` on the parents that own item rows (transfers, returns, receipts).
    const owned = NESTED_ITEMS[this.name];
    if (include?.items && owned) {
      const child = (this.db as any)[owned.table] as Table;
      const sub = isPlain(include.items) ? (include.items as Row) : {};
      out.items = child.rows.filter((r: Row) => r[owned.fk] === row.id).map((r: Row) => child.decorate(r, sub));
    }
    // Other to-many lists by parent table: relation name → [child table, foreign key].
    const TO_MANY: Record<string, Record<string, [string, string]>> = {
      cashSession: { movements: ['cashMovement', 'sessionId'] },
      priceList: { items: ['priceListItem', 'priceListId'] },
      order: { returns: ['salesReturn', 'orderId'] },
    };
    for (const [rel, [table, fk]] of Object.entries(TO_MANY[this.name] ?? {})) {
      if (include?.[rel]) {
        const child = (this.db as any)[table] as Table;
        const sub = isPlain(include[rel]) ? (include[rel] as Row) : {};
        out[rel] = child.rows.filter((r: Row) => r[fk] === row.id).map((r: Row) => child.decorate(r, sub));
      }
    }
    if (include?.invoice && this.name === 'order') {
      const inv = this.db.invoice.rows.find((i) => i.orderId === row.id);
      out.invoice = inv ? { ...inv } : null;
    }
    if (include?.priceList && this.name === 'customer') {
      const list = this.db.priceList.rows.find((l) => l.id === row.priceListId);
      out.priceList = list
        ? { ...list, items: this.db.priceListItem.rows.filter((i) => i.priceListId === list.id).map((i) => ({ ...i })) }
        : null;
    }
    if (include && this.name === 'order') {
      if (include.payments) out.payments = this.db.payment.rows.filter((p) => p.orderId === row.id).map((p) => ({ ...p }));
      if (include.items) {
        out.items = this.db.orderItem.rows
          .filter((i) => i.orderId === row.id)
          .map((i) => {
            const item: Row = { ...i };
            if (isPlain(include.items) && (include.items.include?.product || include.items.select?.product)) {
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
  /** Supports `_sum` over numeric fields (what the services use). */
  async aggregate(args: Row = {}) {
    const rows = this.rows.filter((r) => this.matches(r, args.where));
    const _sum: Row = {};
    for (const key of Object.keys(args._sum ?? {})) {
      _sum[key] = rows.length ? rows.reduce((s, r) => s + Number(r[key] ?? 0), 0) : null;
    }
    return { _sum, _count: { _all: rows.length } };
  }
  async groupBy(args: Row) {
    const rows = this.rows.filter((r) => this.matches(r, args.where));
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = JSON.stringify((args.by as string[]).map((b) => r[b]));
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.values()].map((g) => ({
      ...Object.fromEntries((args.by as string[]).map((b) => [b, g[0][b]])),
      _count: { _all: g.length },
      _sum: Object.fromEntries(Object.keys(args._sum ?? {}).map((k) => [k, g.reduce((t, r) => t + Number(r[k] ?? 0), 0)])),
    }));
  }
  /** skipDuplicates: a row whose (userId, periodMonth) already exists is skipped, like ON CONFLICT DO NOTHING. */
  async createMany(args: Row) {
    let count = 0;
    for (const data of args.data as Row[]) {
      if (args.skipDuplicates && this.rows.some((r) => r.userId === data.userId && r.periodMonth === data.periodMonth)) continue;
      await this.create({ data });
      count++;
    }
    return { count };
  }
  async delete(args: Row) {
    const i = this.rows.findIndex((r) => this.matches(r, args.where));
    if (i < 0) throw new Error(`fake-db: ${this.name} not found for delete`);
    return this.rows.splice(i, 1)[0];
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
    return args.include || args.select ? this.decorate(row, args) : { ...row };
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
    return args.include || args.select ? this.decorate(row, args) : { ...row };
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
  customer = new Table(this, 'customer', () => ({
    isActive: true, regNumber: null, email: null, address: null, notes: null, priceListId: null,
    buysFromUs: true, creditAllowed: false, sellsToUs: false, barterContract: null,
  }));
  stockTransfer = new Table(this, 'stockTransfer', () => ({
    status: 'IN_TRANSIT', notes: null, sentAt: new Date(), receivedById: null, receivedAt: null,
    cancelledById: null, cancelledAt: null, cancelReason: null,
  }));
  stockTransferItem = new Table(this, 'stockTransferItem', () => ({}));
  featureFlag = new Table(this, 'featureFlag', () => ({ updatedById: null }));
  user = new Table(this, 'user', () => ({ isActive: true, warehouseId: null }));
  salesReturn = new Table(this, 'salesReturn', () => ({ refundStatus: 'PENDING_PAYOUT' }));
  stockReceipt = new Table(this, 'stockReceipt', () => ({ supplierInvoiceNo: null, supplierCustomerId: null, notes: null, receivedAt: new Date() }));
  stockReceiptItem = new Table(this, 'stockReceiptItem', () => ({ unitCostMnt: null }));
  appSetting = new Table(this, 'appSetting', () => ({ updatedById: null }));
  attendance = new Table(this, 'attendance', () => ({ checkOut: null, status: 'ON_TIME', notes: null }));
  payroll = new Table(this, 'payroll', () => ({ status: 'DRAFT', paidAt: null, paidById: null }));
  payrollAdjustment = new Table(this, 'payrollAdjustment', () => ({}));
  salaryRate = new Table(this, 'salaryRate', () => ({ reason: null, createdAt: new Date() }));
  cashSession = new Table(this, 'cashSession', () => ({ status: 'OPEN', openedAt: new Date(), closedAt: null, closedById: null, expectedCashMnt: null, countedCashMnt: null, differenceMnt: null, closingNote: null, warehouseId: null }));
  cashMovement = new Table(this, 'cashMovement', () => ({}));
  priceList = new Table(this, 'priceList', () => ({ isActive: true, notes: null }));
  priceListItem = new Table(this, 'priceListItem', () => ({}));
  accountEntry = new Table(this, 'accountEntry', () => ({ refType: null, refId: null, occurredAt: new Date() }));
  editAudit = new Table(this, 'editAudit', () => ({}));
  invoice = new Table(this, 'invoice', () => ({ recipientEmail: null, recipientPhone: null, dueDate: null, note: null, lastSentVia: null, sentAt: null, sendCount: 0, viewedAt: null, cancelledAt: null, customerId: null }));

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
    if (table === 'order' && key === 'items') {
      const mine = this.orderItem.rows.filter((i) => i.orderId === row.id);
      if (cond.some && !mine.some((i) => this.orderItem.matches(i, cond.some))) return false;
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
    // Generic to-one relation filter: `{ receipt: { ... } }` on a row with `receiptId`.
    const parentTable = (this as any)[RELATION_TABLE[key] ?? key];
    if (parentTable instanceof Table && `${key}Id` in row) {
      const parent = parentTable.rows.find((p: Row) => p.id === row[`${key}Id`]);
      return !!parent && parentTable.matches(parent, cond);
    }
    return undefined;
  }

  private tables() {
    return [
      this.order, this.payment, this.orderItem, this.product, this.returnItem, this.supplierPayable, this.feeOverrideAudit,
      this.warehouse, this.stockBalance, this.stockMovement,
      this.customer, this.stockTransfer, this.stockTransferItem, this.featureFlag, this.user,
      this.salesReturn, this.stockReceipt, this.stockReceiptItem, this.appSetting, this.attendance, this.payroll, this.payrollAdjustment, this.salaryRate, this.cashSession, this.cashMovement, this.priceList, this.priceListItem,
      this.accountEntry, this.editAudit, this.invoice,
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
