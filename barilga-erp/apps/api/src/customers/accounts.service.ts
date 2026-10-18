import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountEntryKind, CashMovementKind, OrderStatus, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { PaymentService } from '../payment/payment.service';
import { orderWarehouseWhere, seesAllWarehouses } from '../inventory/warehouse-scope';
import { partnerPayable } from './partner-payable';
import { assertCashDrawerOpen, recordDrawerMovement } from '../cash/cash-drawer';
import { PrismaService } from '../prisma/prisma.service';
import { AddAccountEntryDto, EditAccountEntryDto } from './dto/account.dto';

type StatementLine = {
  at: Date;
  kind: 'ON_ACCOUNT' | 'PAID_BY_THEM' | 'RETURNED' | AccountEntryKind;
  description: string;
  /** + they owe us more, − they owe us less (our own debt to them counts as −). */
  effectMnt: number;
  orderId?: string;
  entryId?: string;
  /** What document made the line (RECEIPT, ORDER, VOID…) and its id, for links. */
  refType?: string | null;
  refId?: string | null;
  method?: string | null;
  editable?: boolean;
  /** A manual line that was cancelled later (its reversing line is in the statement too). */
  voided?: boolean;
};

export type MoneyMethod = 'CASH' | 'CARD' | 'TRANSFER';

/** Kinds a manager writes by hand (the others come from receipts, offsets and voids). */
const MANUAL_KINDS: AccountEntryKind[] = [
  AccountEntryKind.PURCHASE,
  AccountEntryKind.PAYMENT_TO_PARTNER,
  AccountEntryKind.ADJUSTMENT,
  AccountEntryKind.CHARGE,
  AccountEntryKind.PAYMENT_FROM_PARTNER,
];
const PAY_MN: Record<string, string> = { CASH: 'бэлнээр', CARD: 'картаар', TRANSFER: 'шилжүүлгээр', OFFSET: 'хасалтаар' };
/** Ledger amounts are 32-bit integers in the database. */
const MAX_MNT = 2_000_000_000;

/**
 * The two-way account with a partner (харилцагчийн тооцоо):
 *   ledger     = SUM(account entries) — purchases and advances (+) minus our payments, their charges, offsets (−)
 *   receivable = what they owe us — their unpaid on-account (зарлагаар) orders, plus a negative ledger
 *   payable    = what we owe them — a positive ledger
 *   net        = receivable − payable (positive: they owe us; negative: we owe them)
 * Offsetting (хасалт) pays their on-account orders with what we owe them, so no money moves.
 */
@Injectable()
export class AccountsService {
  private readonly log = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  private async requireCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Open on-account rows of this customer, oldest first. */
  private openCredit(customerId: string, scope: Prisma.OrderWhereInput = {}) {
    return this.prisma.payment.findMany({
      where: {
        method: PayMethod.CREDIT,
        status: PaymentStatus.UNPAID,
        amountMnt: { gt: 0 },
        // Only goods actually released are owed; a pending order is still waiting for its other payments.
        order: { customerId, status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] }, ...scope },
      },
      include: { order: { select: { id: true, orderNumber: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  private ledger(customerId: string) {
    return partnerPayable(this.prisma, customerId);
  }

  /** A cashier locked to one warehouse only takes payments for that warehouse's orders. */
  private async scopeFor(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    if (seesAllWarehouses(user)) return {};
    const def = await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    return orderWarehouseWhere(user, def?.id);
  }

  /** receivable / payable / net as described on the class; `ordersOwedMnt` is the part owed on orders. */
  static present(ordersOwedMnt: number, ledgerMnt: number) {
    const receivableMnt = ordersOwedMnt + Math.max(0, -ledgerMnt);
    const payableMnt = Math.max(0, ledgerMnt);
    return { receivableMnt, payableMnt, netMnt: receivableMnt - payableMnt, ordersOwedMnt, ledgerMnt };
  }

  async balance(customerId: string) {
    const [open, ledger] = await Promise.all([this.openCredit(customerId), this.ledger(customerId)]);
    return AccountsService.present(
      open.reduce((s, p) => s + p.amountMnt, 0),
      ledger,
    );
  }

  /**
   * Every movement in the account with a running balance. With `from`/`to` (YYYY-MM-DD, Ulaanbaatar days)
   * it is the reconciliation statement (акт тооцоо) for that period: the balance brought forward, the lines in
   * the period with their debit (they owe more) and credit (they owe less) totals, and the closing balance.
   */
  async statement(customerId: string, range: { from?: string; to?: string } = {}) {
    const customer = await this.requireCustomer(customerId);
    const [creditRows, creditReturns, entries] = await Promise.all([
      this.prisma.payment.findMany({
        where: { method: PayMethod.CREDIT, order: { customerId, status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] } } },
        include: { order: { select: { id: true, orderNumber: true, createdAt: true } } },
      }),
      this.prisma.salesReturn.findMany({
        where: { refundMethod: PayMethod.CREDIT, order: { customerId } },
        include: { order: { select: { id: true, orderNumber: true } } },
      }),
      this.prisma.accountEntry.findMany({ where: { customerId }, include: { createdBy: { select: { fullName: true } } } }),
    ]);

    const voidedIds = new Set(entries.filter((e) => e.refType === 'VOID' && e.refId).map((e) => e.refId!));
    const lines: StatementLine[] = [];
    for (const row of creditRows) {
      const payload = (row.qpayPayload ?? {}) as Prisma.JsonObject;
      const original = typeof payload.originalMnt === 'number' ? payload.originalMnt : row.amountMnt;
      lines.push({
        at: row.order.createdAt,
        kind: 'ON_ACCOUNT',
        description: `Дараа төлөхөөр авсан — ${row.order.orderNumber}`,
        effectMnt: original,
        orderId: row.order.id,
        refType: 'ORDER',
        refId: row.order.id,
      });
      const settlements = Array.isArray(payload.settlements) ? (payload.settlements as Prisma.JsonObject[]) : [];
      for (const s of settlements) {
        // Paid by offset: shown once, as the OFFSET line below (it lowers both sides, the net is unchanged).
        if (String(s.method) === 'OFFSET') continue;
        lines.push({
          at: new Date(String(s.at)),
          kind: 'PAID_BY_THEM',
          description: `Төлсөн ${PAY_MN[String(s.method)] ?? s.method} — ${row.order.orderNumber}`,
          effectMnt: -Number(s.amountMnt),
          orderId: row.order.id,
          refType: 'ORDER',
          refId: row.order.id,
          method: String(s.method),
        });
      }
    }
    for (const r of creditReturns) {
      lines.push({
        at: r.createdAt,
        kind: 'RETURNED',
        description: `Буцаалт (өрөөс хассан) — ${r.order.orderNumber}`,
        effectMnt: -r.refundAmount,
        orderId: r.order.id,
        refType: 'ORDER',
        refId: r.order.id,
      });
    }
    for (const e of entries) {
      const isOffset = e.kind === AccountEntryKind.OFFSET;
      lines.push({
        at: e.occurredAt,
        kind: e.kind,
        description: isOffset
          ? `${e.description}: авлага ба өглөг хоёулаа −${-e.amountMnt}₮`
          : `${e.description}${e.method ? ` (${PAY_MN[e.method] ?? e.method})` : ''}${e.createdBy ? ` · ${e.createdBy.fullName}` : ''}`,
        // Ledger + means we owe more → they owe us less on the net. An offset lowers both sides: no net effect.
        effectMnt: isOffset ? 0 : -e.amountMnt,
        entryId: e.id,
        refType: e.refType,
        refId: e.refId,
        method: e.method,
        editable: MANUAL_KINDS.includes(e.kind) && !e.refType && !voidedIds.has(e.id),
        voided: voidedIds.has(e.id),
      });
    }
    lines.sort((a, b) => a.at.getTime() - b.at.getTime());

    const dayStart = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00.000+08:00`) : null);
    const fromAt = dayStart(range.from);
    const toEnd = range.to && /^\d{4}-\d{2}-\d{2}$/.test(range.to) ? new Date(`${range.to}T23:59:59.999+08:00`) : null;
    if (fromAt && toEnd && toEnd < fromAt) throw new BadRequestException('endDate must be on or after startDate');
    const before = fromAt ? lines.filter((l) => l.at < fromAt) : [];
    const openingMnt = before.reduce((s, l) => s + l.effectMnt, 0);
    const inRange = lines.filter((l) => (!fromAt || l.at >= fromAt) && (!toEnd || l.at <= toEnd));
    let running = openingMnt;
    const withBalance = inRange.map((l) => ({ ...l, balanceMnt: (running += l.effectMnt) }));
    const debitMnt = inRange.reduce((s, l) => s + Math.max(0, l.effectMnt), 0);
    const creditMnt = inRange.reduce((s, l) => s + Math.max(0, -l.effectMnt), 0);
    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        regNumber: customer.regNumber,
        address: customer.address,
        barterContract: customer.barterContract,
      },
      ...(await this.balance(customerId)),
      period: { from: range.from ?? null, to: range.to ?? null, openingMnt, debitMnt, creditMnt, closingMnt: openingMnt + debitMnt - creditMnt },
      lines: withBalance,
    };
  }

  /** Every partner with an open position, for the «Харилцагчийн тооцоо» report. */
  async balances() {
    const [open, entries] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          method: PayMethod.CREDIT,
          status: PaymentStatus.UNPAID,
          amountMnt: { gt: 0 },
          order: { status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] } },
        },
        include: { order: { select: { customerId: true } } },
      }),
      this.prisma.accountEntry.groupBy({ by: ['customerId'], _sum: { amountMnt: true } }),
    ]);
    const owed = new Map<string, number>();
    const ledger = new Map<string, number>();
    for (const p of open) if (p.order.customerId) owed.set(p.order.customerId, (owed.get(p.order.customerId) ?? 0) + p.amountMnt);
    for (const e of entries) ledger.set(e.customerId, e._sum.amountMnt ?? 0);
    const ids = [...new Set([...owed.keys(), ...ledger.keys()])];
    const customers = ids.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, phone: true, type: true, barterContract: true, sellsToUs: true, creditAllowed: true },
        })
      : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    const list = ids
      .filter((id) => byId.has(id))
      .map((id) => ({ ...byId.get(id)!, ...AccountsService.present(owed.get(id) ?? 0, ledger.get(id) ?? 0) }))
      .filter((r) => r.receivableMnt !== 0 || r.payableMnt !== 0)
      .sort((a, b) => Math.abs(b.netMnt) - Math.abs(a.netMnt));
    return {
      partners: list,
      totals: {
        receivableMnt: list.reduce((s, r) => s + r.receivableMnt, 0),
        payableMnt: list.reduce((s, r) => s + r.payableMnt, 0),
      },
    };
  }

  /**
   * Manager records a purchase from the partner (amount only, e.g. a service), a charge to them, a payment we
   * made or a correction. Cash paid out leaves the manager's drawer (a drawer movement is written).
   */
  async addEntry(customerId: string, dto: AddAccountEntryDto, user: AuthUser) {
    await this.requireCustomer(customerId);
    if (dto.kind === AccountEntryKind.PAYMENT_FROM_PARTNER) {
      // Money from the partner first pays their order debts: that goes through receive().
      throw new BadRequestException('Харилцагчаас мөнгө авахыг «Тэд мөнгө төлсөн» үйлдлээр бүртгэнэ / Use the receive action');
    }
    const amountMnt = this.signed(dto.kind, dto.amountMnt);
    const method = dto.kind === AccountEntryKind.PAYMENT_TO_PARTNER ? (dto.method ?? null) : null;
    if (method === 'CASH') await assertCashDrawerOpen(this.prisma, user.id);
    const entry = await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.accountEntry.create({
          data: {
            customerId,
            kind: dto.kind,
            amountMnt,
            description: dto.description,
            method,
            occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
            createdById: user.id,
          },
        });
        if (method === 'CASH') {
          // Checked again inside: a drawer closed in the meantime must not leave cash unrecorded.
          await assertCashDrawerOpen(tx, user.id);
          await recordDrawerMovement(tx, user.id, CashMovementKind.OUT, -amountMnt, `Харилцагчид төлсөн: ${dto.description}`);
        }
        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Account ${customerId}: ${dto.kind} ${amountMnt}₮${method ? ` ${method}` : ''} by ${user.id}`);
    return entry;
  }

  /**
   * The partner pays us. The money first clears their open on-account orders (oldest first, like «Өр төлөх»);
   * anything left is kept as their advance (PAYMENT_FROM_PARTNER), which lowers what they owe later or becomes
   * what we owe them.
   */
  async receive(customerId: string, amountMnt: number, method: MoneyMethod, description: string, user: AuthUser) {
    await this.requireCustomer(customerId);
    if (!Number.isInteger(amountMnt) || amountMnt <= 0 || amountMnt > MAX_MNT) {
      throw new BadRequestException('Amount must be a positive whole number');
    }
    if (method === 'CASH') await assertCashDrawerOpen(this.prisma, user.id);
    const [here, all] = await Promise.all([this.openCredit(customerId, await this.scopeFor(user)), this.openCredit(customerId)]);
    const owedHere = here.reduce((s, p) => s + p.amountMnt, 0);
    const owedElsewhere = all.reduce((s, p) => s + p.amountMnt, 0) - owedHere;
    // Money beyond this branch's orders would become an advance while another branch's orders stay unpaid:
    // those are collected by that branch (or by the general manager), not turned into what we owe them.
    if (amountMnt > owedHere && owedElsewhere > 0) {
      throw new BadRequestException(
        `Таны салбарт ${owedHere}₮ өртэй, бусад салбарын захиалгад ${owedElsewhere}₮ өртэй. ${owedHere}₮ хүртэл авна уу, эсвэл ерөнхий менежер бүртгэнэ / Other branches' orders are still owed`,
      );
    }
    let left = amountMnt;
    const applied: Array<{ orderNumber: string; amountMnt: number }> = [];
    for (const row of here) {
      if (left <= 0) break;
      const take = Math.min(left, row.amountMnt);
      try {
        await this.payments.settleCredit(row.order.id, method, take, user.id);
      } catch (err) {
        // Paid or changed by someone else meanwhile: skip it. What is not applied stays with the partner as an
        // advance below, so the money received is always recorded exactly once.
        this.log.warn(`receive: ${row.order.orderNumber} skipped: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      applied.push({ orderNumber: row.order.orderNumber, amountMnt: take });
      left -= take;
    }
    let advanceMnt = 0;
    if (left > 0) {
      advanceMnt = left;
      const appliedMnt = amountMnt - left;
      await this.prisma.$transaction(async (tx) => {
        if (method === 'CASH') await assertCashDrawerOpen(tx, user.id);
        await tx.accountEntry.create({
          data: {
            customerId,
            kind: AccountEntryKind.PAYMENT_FROM_PARTNER,
            amountMnt: left,
            description: description.trim() || 'Харилцагч мөнгө төлсөн',
            method,
            createdById: user.id,
          },
        });
        // Order settlements above are cash payments the drawer already counts; the advance is not a payment.
        if (method === 'CASH') await recordDrawerMovement(tx, user.id, CashMovementKind.IN, left, `Харилцагчаас: ${description.trim() || 'урьдчилгаа'}`);
      }).catch((err) => {
        if (!appliedMnt) throw err;
        // The orders are already paid; say exactly what is still to be entered so it is not entered twice.
        throw new ConflictException(
          `Захиалгуудад ${appliedMnt}₮ орсон, үлдсэн ${left}₮ бүртгэгдсэнгүй — зөвхөн ${left}₮-ийг дахин оруулна уу / ${appliedMnt} applied, ${left} not recorded`,
        );
      });
    }
    this.log.log(
      `Received ${amountMnt}₮ ${method} from ${customerId} by ${user.id}: orders ${applied.map((a) => `${a.orderNumber} ${a.amountMnt}`).join(', ') || '—'}, advance ${advanceMnt}`,
    );
    return { receivedMnt: amountMnt, applied, advanceMnt, ...(await this.balance(customerId)) };
  }

  /** Changes an amount/description/date later; the old and new values and the reason are kept for the admin. */
  async editEntry(entryId: string, dto: EditAccountEntryDto, user: AuthUser) {
    const entry = await this.prisma.accountEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Entry not found');
    if (!MANUAL_KINDS.includes(entry.kind) || entry.refType) {
      throw new BadRequestException('This line comes from another document (receipt / offset); change that document instead');
    }
    if (entry.method === 'CASH' && dto.amountMnt !== undefined && this.signed(entry.kind, dto.amountMnt) !== entry.amountMnt) {
      throw new BadRequestException('Бэлэн мөнгөний дүнг засахгүй — хүчингүй болгоод дахин бүртгэнэ / Cancel and re-enter a cash line instead');
    }
    const next = {
      amountMnt: dto.amountMnt !== undefined ? this.signed(entry.kind, dto.amountMnt) : entry.amountMnt,
      description: dto.description ?? entry.description,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : entry.occurredAt,
    };
    return this.prisma.$transaction(async (tx) => {
      // Checked inside the transaction so an edit cannot slip in while the line is being cancelled.
      const voided = await tx.accountEntry.count({ where: { refType: 'VOID', refId: entryId } });
      if (voided) throw new BadRequestException('Хүчингүй болсон мөрийг засахгүй / This line was cancelled');
      const fresh = await tx.accountEntry.findUnique({ where: { id: entryId } });
      if (!fresh || fresh.amountMnt !== entry.amountMnt || fresh.description !== entry.description) {
        throw new ConflictException('Энэ мөр сая өөрчлөгдсөн, дахин ачаалаад оролдоно уу / Changed meanwhile; reload');
      }
      const updated = await tx.accountEntry.update({ where: { id: entryId }, data: next });
      await tx.editAudit.create({
        data: {
          entityType: 'ACCOUNT_ENTRY',
          entityId: entryId,
          summary: `Тооцооны мөр (${entry.kind}) засав`,
          before: { amountMnt: entry.amountMnt, description: entry.description, occurredAt: entry.occurredAt.toISOString() },
          after: { amountMnt: next.amountMnt, description: next.description, occurredAt: next.occurredAt.toISOString() },
          reason: dto.reason,
          actorId: user.id,
        },
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Cancels a hand-written line by writing its exact opposite (the original stays visible, marked cancelled),
   * so the history keeps both. Cash that had left or entered the drawer goes back the other way.
   */
  async voidEntry(entryId: string, reason: string, user: AuthUser) {
    const entry = await this.prisma.accountEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Entry not found');
    if (!MANUAL_KINDS.includes(entry.kind) || entry.refType) {
      throw new BadRequestException('This line comes from another document (receipt / offset); change that document instead');
    }
    if (entry.method === 'CASH') await assertCashDrawerOpen(this.prisma, user.id);
    const reversal = await this.prisma.$transaction(
      async (tx) => {
        const already = await tx.accountEntry.count({ where: { refType: 'VOID', refId: entryId } });
        if (already) throw new ConflictException('Энэ мөр аль хэдийн хүчингүй болсон / Already cancelled');
        // Reverse the amount stored now (an edit may have just changed it).
        const current = await tx.accountEntry.findUnique({ where: { id: entryId } });
        if (!current || current.amountMnt !== entry.amountMnt) {
          throw new ConflictException('Энэ мөр сая өөрчлөгдсөн, дахин ачаалаад оролдоно уу / Changed meanwhile; reload');
        }
        if (entry.method === 'CASH') await assertCashDrawerOpen(tx, user.id);
        const row = await tx.accountEntry.create({
          data: {
            customerId: entry.customerId,
            kind: AccountEntryKind.ADJUSTMENT,
            amountMnt: -entry.amountMnt,
            description: `Хүчингүй болгосон: ${entry.description}`,
            refType: 'VOID',
            refId: entry.id,
            method: entry.method,
            createdById: user.id,
          },
        });
        if (entry.method === 'CASH') {
          // We paid them (ledger −) → the cash comes back in; they paid us (ledger +) → it goes back out.
          await recordDrawerMovement(
            tx,
            user.id,
            entry.amountMnt < 0 ? CashMovementKind.IN : CashMovementKind.OUT,
            Math.abs(entry.amountMnt),
            `Хүчингүй болгосон тооцоо: ${entry.description}`,
          );
        }
        await tx.editAudit.create({
          data: {
            entityType: 'ACCOUNT_ENTRY',
            entityId: entryId,
            summary: `Тооцооны мөр (${entry.kind}) хүчингүй болгов: ${entry.description}`,
            before: { amountMnt: entry.amountMnt },
            after: { amountMnt: 0 },
            reason,
            actorId: user.id,
          },
        });
        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Account entry ${entryId} voided by ${user.id}: ${reason}`);
    return reversal;
  }

  /**
   * Хасалт: pays the partner's open on-account orders (oldest first) with what we owe them, up to the
   * smaller of the two (or the amount asked). Each order paid this way gets a matching OFFSET line.
   */
  async offset(customerId: string, requested: number | undefined, user: AuthUser) {
    await this.requireCustomer(customerId);
    const { ordersOwedMnt, payableMnt } = await this.balance(customerId);
    const cap = Math.min(ordersOwedMnt, payableMnt);
    const amount = requested === undefined ? cap : Math.min(requested, cap);
    if (amount <= 0) {
      throw new BadRequestException('Хасах дүн алга: харилцагч бидэнд өргүй эсвэл бид түүнд өргүй байна');
    }
    let left = amount;
    const applied: Array<{ orderNumber: string; amountMnt: number }> = [];
    for (const row of await this.openCredit(customerId)) {
      if (left <= 0) break;
      const take = Math.min(left, row.amountMnt);
      // Settlement and OFFSET line in one transaction, re-checking our payable inside it.
      await this.payments.settleCredit(row.order.id, 'OFFSET', take, user.id, {
        before: async (tx) => {
          const payableNow = await partnerPayable(tx, customerId);
          if (take > payableNow) throw new ConflictException('Өглөг өөрчлөгдсөн байна, дахин оролдоно уу / Payable changed; try again');
        },
        after: async (tx) => {
          await tx.accountEntry.create({
            data: {
              customerId,
              kind: AccountEntryKind.OFFSET,
              amountMnt: -take,
              description: `Хасалт — ${row.order.orderNumber}`,
              refType: 'ORDER',
              refId: row.order.id,
              createdById: user.id,
            },
          });
        },
      });
      applied.push({ orderNumber: row.order.orderNumber, amountMnt: take });
      left -= take;
    }
    this.log.log(`Offset ${amount - left}₮ for ${customerId} by ${user.id}: ${applied.map((a) => a.orderNumber).join(', ')}`);
    return { offsetMnt: amount - left, applied, ...(await this.balance(customerId)) };
  }

  /**
   * The customer pays off what they owe in one go: the money goes to their oldest open orders first. Each order
   * is settled on its own (and gets its E-Barimt when fully paid), so a failure part-way keeps what was done.
   */
  async payDebt(customerId: string, method: MoneyMethod, amountMnt: number, user: AuthUser) {
    await this.requireCustomer(customerId);
    if (!Number.isInteger(amountMnt) || amountMnt <= 0) throw new BadRequestException('Amount must be a positive whole number');
    const open = await this.openCredit(customerId, await this.scopeFor(user));
    const owed = open.reduce((s, p) => s + p.amountMnt, 0);
    if (owed === 0) throw new BadRequestException('Энэ харилцагч (таны агуулахад) өргүй / Nothing is owed here');
    if (amountMnt > owed) throw new BadRequestException(`Нийт өр ${owed}₮ / Only ${owed}₮ is owed`);
    if (method === 'CASH') await assertCashDrawerOpen(this.prisma, user.id);
    let left = amountMnt;
    const applied: Array<{ orderNumber: string; amountMnt: number }> = [];
    for (const row of open) {
      if (left <= 0) break;
      const take = Math.min(left, row.amountMnt);
      await this.payments.settleCredit(row.order.id, method, take, user.id);
      applied.push({ orderNumber: row.order.orderNumber, amountMnt: take });
      left -= take;
    }
    this.log.log(`Debt payment ${amountMnt}₮ ${method} from ${customerId} by ${user.id}: ${applied.map((a) => a.orderNumber).join(', ')}`);
    return { paidMnt: amountMnt, applied, ...(await this.balance(customerId)) };
  }

  /** How much of this customer's order debt the user may collect (their warehouses only). */
  async owedHere(customerId: string, user: AuthUser) {
    const open = await this.openCredit(customerId, await this.scopeFor(user));
    return { owedMnt: open.reduce((s, p) => s + p.amountMnt, 0) };
  }

  /**
   * Ledger sign per kind: purchases (+) and their advances (+) raise what we owe; our payments (−) and their
   * charges (−) lower it; adjustments keep their sign.
   */
  private signed(kind: AccountEntryKind, amount: number) {
    if (Math.abs(amount) > MAX_MNT) throw new BadRequestException('Amount is too large');
    if (kind === AccountEntryKind.ADJUSTMENT) {
      if (amount === 0) throw new BadRequestException('An adjustment cannot be 0');
      return amount;
    }
    if (amount <= 0) throw new BadRequestException('Amount must be greater than 0');
    if (kind === AccountEntryKind.PURCHASE || kind === AccountEntryKind.PAYMENT_FROM_PARTNER) return amount;
    if (kind === AccountEntryKind.PAYMENT_TO_PARTNER || kind === AccountEntryKind.CHARGE) return -amount;
    throw new BadRequestException('Offsets are made with the offset action, not by hand');
  }
}
