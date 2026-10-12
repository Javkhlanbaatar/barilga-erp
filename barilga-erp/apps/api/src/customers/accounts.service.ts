import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountEntryKind, OrderStatus, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { PaymentService } from '../payment/payment.service';
import { lockedWarehouseId } from '../inventory/warehouse-scope';
import { partnerPayable } from './partner-payable';
import { assertCashDrawerOpen } from '../cash/cash-drawer';
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
  editable?: boolean;
};

const MANUAL_KINDS: AccountEntryKind[] = [AccountEntryKind.PURCHASE, AccountEntryKind.PAYMENT_TO_PARTNER, AccountEntryKind.ADJUSTMENT];
const PAY_MN: Record<string, string> = { CASH: 'бэлнээр', CARD: 'картаар', TRANSFER: 'шилжүүлгээр', OFFSET: 'хасалтаар' };

/**
 * The two-way account with a partner (харилцагчийн тооцоо):
 *   receivable = what they owe us  — their on-account (зарлагаар) orders still unpaid
 *   payable    = what we owe them  — goods we bought from them, minus what we paid them / offset
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

  private payable(customerId: string) {
    return partnerPayable(this.prisma, customerId);
  }

  /** A cashier locked to one warehouse only takes payments for that warehouse's orders. */
  private async scopeFor(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    const locked = lockedWarehouseId(user);
    if (!locked) return {};
    const def = await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    return def?.id === locked ? { OR: [{ warehouseId: locked }, { warehouseId: null }] } : { warehouseId: locked };
  }

  async balance(customerId: string) {
    const [open, payable] = await Promise.all([this.openCredit(customerId), this.payable(customerId)]);
    const receivable = open.reduce((s, p) => s + p.amountMnt, 0);
    return { receivableMnt: receivable, payableMnt: payable, netMnt: receivable - payable };
  }

  /** Every movement in the account, oldest first, with a running net balance. */
  async statement(customerId: string) {
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
      });
    }
    for (const e of entries) {
      const isOffset = e.kind === AccountEntryKind.OFFSET;
      lines.push({
        at: e.occurredAt,
        kind: e.kind,
        description: isOffset
          ? `${e.description}: авлага ба өглөг хоёулаа −${-e.amountMnt}₮`
          : `${e.description}${e.createdBy ? ` · ${e.createdBy.fullName}` : ''}`,
        // We owe them more → they owe us less on the net. An offset lowers both sides: no net effect.
        effectMnt: isOffset ? 0 : -e.amountMnt,
        entryId: e.id,
        editable: MANUAL_KINDS.includes(e.kind) && !e.refType,
      });
    }
    lines.sort((a, b) => a.at.getTime() - b.at.getTime());
    let running = 0;
    const withBalance = lines.map((l) => ({ ...l, balanceMnt: (running += l.effectMnt) }));
    return {
      customer: { id: customer.id, name: customer.name, barterContract: customer.barterContract },
      ...(await this.balance(customerId)),
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
    const rows = new Map<string, { receivableMnt: number; payableMnt: number }>();
    const row = (id: string) => {
      let r = rows.get(id);
      if (!r) rows.set(id, (r = { receivableMnt: 0, payableMnt: 0 }));
      return r;
    };
    for (const p of open) if (p.order.customerId) row(p.order.customerId).receivableMnt += p.amountMnt;
    for (const e of entries) row(e.customerId).payableMnt += e._sum.amountMnt ?? 0;
    const ids = [...rows.keys()];
    const customers = ids.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, phone: true, type: true, barterContract: true, sellsToUs: true, creditAllowed: true },
        })
      : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    const list = ids
      .map((id) => ({ ...byId.get(id)!, ...rows.get(id)!, netMnt: rows.get(id)!.receivableMnt - rows.get(id)!.payableMnt }))
      .filter((r) => r.id && (r.receivableMnt !== 0 || r.payableMnt !== 0))
      .sort((a, b) => Math.abs(b.netMnt) - Math.abs(a.netMnt));
    return {
      partners: list,
      totals: {
        receivableMnt: list.reduce((s, r) => s + r.receivableMnt, 0),
        payableMnt: list.reduce((s, r) => s + r.payableMnt, 0),
      },
    };
  }

  /** Manager records a purchase from the partner, a payment we made, or a correction. */
  async addEntry(customerId: string, dto: AddAccountEntryDto, user: AuthUser) {
    await this.requireCustomer(customerId);
    const amountMnt = this.signed(dto.kind, dto.amountMnt);
    const entry = await this.prisma.accountEntry.create({
      data: {
        customerId,
        kind: dto.kind,
        amountMnt,
        description: dto.description,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        createdById: user.id,
      },
    });
    this.log.log(`Account ${customerId}: ${dto.kind} ${amountMnt}₮ by ${user.id}`);
    return entry;
  }

  /** Changes an amount/description later; the old and new values and the reason are kept for the admin. */
  async editEntry(entryId: string, dto: EditAccountEntryDto, user: AuthUser) {
    const entry = await this.prisma.accountEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Entry not found');
    if (!MANUAL_KINDS.includes(entry.kind) || entry.refType) {
      throw new BadRequestException('This line comes from another document (receipt / offset); change that document instead');
    }
    const next = {
      amountMnt: dto.amountMnt !== undefined ? this.signed(entry.kind, dto.amountMnt) : entry.amountMnt,
      description: dto.description ?? entry.description,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : entry.occurredAt,
    };
    return this.prisma.$transaction(async (tx) => {
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
    });
  }

  /**
   * Хасалт: pays the partner's open on-account orders (oldest first) with what we owe them, up to the
   * smaller of the two (or the amount asked). Each order paid this way gets a matching OFFSET line.
   */
  async offset(customerId: string, requested: number | undefined, user: AuthUser) {
    await this.requireCustomer(customerId);
    const { receivableMnt, payableMnt } = await this.balance(customerId);
    const cap = Math.min(receivableMnt, payableMnt);
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
  async payDebt(customerId: string, method: 'CASH' | 'CARD' | 'TRANSFER', amountMnt: number, user: AuthUser) {
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

  /** Purchases add to what we owe, payments to the partner reduce it; adjustments keep their sign. */
  private signed(kind: AccountEntryKind, amount: number) {
    if (kind === AccountEntryKind.ADJUSTMENT) {
      if (amount === 0) throw new BadRequestException('An adjustment cannot be 0');
      return amount;
    }
    if (amount <= 0) throw new BadRequestException('Amount must be greater than 0');
    if (kind === AccountEntryKind.PURCHASE) return amount;
    if (kind === AccountEntryKind.PAYMENT_TO_PARTNER) return -amount;
    throw new BadRequestException('Offsets are made with the offset action, not by hand');
  }
}
