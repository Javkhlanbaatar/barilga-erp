import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CashMovementKind, CashSessionStatus, PaymentStatus, PayMethod, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { canAccessWarehouse, isManagerRole, seesAllWarehouses, warehouseWhere } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

type SessionRow = Prisma.CashSessionGetPayload<{ include: { movements: true; user: { select: { id: true; fullName: true } } } }>;

/**
 * Cash drawer shifts. Expected cash at any moment =
 *   opening float + cash this person took (payments they recorded) − cash they refunded + cash in − cash out.
 * At close the counted cash is compared with it and the difference is frozen with the session.
 */
@Injectable()
export class CashService {
  private readonly log = new Logger(CashService.name);

  constructor(private readonly prisma: PrismaService) {}

  private static readonly INCLUDE = { movements: { orderBy: { createdAt: 'asc' as const } }, user: { select: { id: true, fullName: true } } };

  /** Money the session's cashier took and handed back in its window, by method, plus the expected cash. */
  async summary(s: Pick<SessionRow, 'userId' | 'openedAt' | 'closedAt' | 'openingFloatMnt' | 'movements'>) {
    const window = { gte: s.openedAt, ...(s.closedAt ? { lte: s.closedAt } : {}) };
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: { recordedById: s.userId, status: PaymentStatus.PAID, paidAt: window },
        select: { method: true, amountMnt: true },
      }),
      this.prisma.salesReturn.findMany({
        where: { createdById: s.userId, createdAt: window, refundMethod: { notIn: [PayMethod.CREDIT, PayMethod.OFFSET] } },
        select: { refundMethod: true, refundAmount: true },
      }),
    ]);
    const byMethod: Record<string, number> = {};
    for (const p of payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountMnt;
    const cashSales = byMethod[PayMethod.CASH] ?? 0;
    const cashRefunds = refunds.filter((r) => r.refundMethod === PayMethod.CASH).reduce((t, r) => t + r.refundAmount, 0);
    const otherRefunds = refunds.filter((r) => r.refundMethod !== PayMethod.CASH).reduce((t, r) => t + r.refundAmount, 0);
    const cashIn = s.movements.filter((m) => m.kind === CashMovementKind.IN).reduce((t, m) => t + m.amountMnt, 0);
    const cashOut = s.movements.filter((m) => m.kind === CashMovementKind.OUT).reduce((t, m) => t + m.amountMnt, 0);
    return {
      openingFloatMnt: s.openingFloatMnt,
      cashSalesMnt: cashSales,
      cashRefundsMnt: cashRefunds,
      cashInMnt: cashIn,
      cashOutMnt: cashOut,
      expectedCashMnt: s.openingFloatMnt + cashSales - cashRefunds + cashIn - cashOut,
      cardMnt: byMethod[PayMethod.CARD] ?? 0,
      qpayMnt: byMethod[PayMethod.QPAY] ?? 0,
      transferMnt: byMethod[PayMethod.TRANSFER] ?? 0,
      otherRefundsMnt: otherRefunds,
    };
  }

  private async present(s: SessionRow) {
    const live = await this.summary(s);
    return { ...s, summary: live };
  }

  /** The caller's open drawer (with live totals), or null. */
  async current(user: AuthUser) {
    const s = await this.prisma.cashSession.findFirst({ where: { userId: user.id, status: CashSessionStatus.OPEN }, include: CashService.INCLUDE });
    // Suggest the float: what the last shift left in the drawer.
    const last = s
      ? null
      : await this.prisma.cashSession.findFirst({
          where: { status: CashSessionStatus.CLOSED, ...(user.warehouseId ? { warehouseId: user.warehouseId } : { userId: user.id }) },
          orderBy: { closedAt: 'desc' },
          select: { countedCashMnt: true, closedAt: true, user: { select: { fullName: true } } },
        });
    return { session: s ? await this.present(s) : null, lastClosed: last };
  }

  async open(openingFloatMnt: number, user: AuthUser) {
    try {
      const s = await this.prisma.cashSession.create({
        data: { userId: user.id, warehouseId: user.warehouseId ?? null, openingFloatMnt },
        include: CashService.INCLUDE,
      });
      this.log.log(`Cash drawer opened by ${user.id} with ${openingFloatMnt}₮`);
      return this.present(s);
    } catch (err) {
      // The partial unique index allows one open drawer per person.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Танд нээлттэй касс байна / You already have an open drawer');
      }
      throw err;
    }
  }

  async move(kind: CashMovementKind, amountMnt: number, reason: string, user: AuthUser) {
    const s = await this.prisma.cashSession.findFirst({ where: { userId: user.id, status: CashSessionStatus.OPEN }, include: CashService.INCLUDE });
    if (!s) throw new BadRequestException('Касс нээгээгүй байна / No open drawer');
    if (kind === CashMovementKind.OUT) {
      const { expectedCashMnt } = await this.summary(s);
      if (amountMnt > expectedCashMnt) throw new BadRequestException(`Кассанд ${expectedCashMnt}₮ байх ёстой / Not that much cash in the drawer`);
    }
    await this.prisma.cashMovement.create({ data: { sessionId: s.id, kind, amountMnt, reason: reason.trim(), createdById: user.id } });
    this.log.log(`Cash ${kind} ${amountMnt}₮ (${reason}) by ${user.id}`);
    return (await this.current(user)).session;
  }

  /** Close the caller's own drawer, or (managers) anyone's. The count and difference are frozen. */
  async close(countedCashMnt: number, note: string | undefined, user: AuthUser, sessionId?: string) {
    const s = sessionId
      ? await this.prisma.cashSession.findUnique({ where: { id: sessionId }, include: CashService.INCLUDE })
      : await this.prisma.cashSession.findFirst({ where: { userId: user.id, status: CashSessionStatus.OPEN }, include: CashService.INCLUDE });
    if (!s) throw new NotFoundException('Нээлттэй касс алга / No open drawer');
    if (s.userId !== user.id) {
      if (!isManagerRole(user.role)) throw new ForbiddenException();
      if (!seesAllWarehouses(user)) {
        const [owner, def] = await Promise.all([
          this.prisma.user.findUnique({ where: { id: s.userId }, select: { warehouseId: true } }),
          this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } }),
        ]);
        if (!canAccessWarehouse(user, owner?.warehouseId, def?.id)) throw new ForbiddenException('This drawer belongs to another warehouse');
      }
    }
    if (s.status !== CashSessionStatus.OPEN) throw new ConflictException('Касс аль хэдийн хаагдсан / Already closed');
    const closedAt = new Date();
    const { expectedCashMnt } = await this.summary({ ...s, closedAt });
    const differenceMnt = countedCashMnt - expectedCashMnt;
    const claimed = await this.prisma.cashSession.updateMany({
      where: { id: s.id, status: CashSessionStatus.OPEN },
      data: {
        status: CashSessionStatus.CLOSED,
        closedAt,
        closedById: user.id,
        expectedCashMnt,
        countedCashMnt,
        differenceMnt,
        closingNote: note?.trim() || null,
      },
    });
    if (claimed.count !== 1) throw new ConflictException('Касс аль хэдийн хаагдсан / Already closed');
    this.log.log(`Cash drawer ${s.id} closed by ${user.id}: expected ${expectedCashMnt}₮, counted ${countedCashMnt}₮, diff ${differenceMnt}₮`);
    const closed = await this.prisma.cashSession.findUniqueOrThrow({ where: { id: s.id }, include: CashService.INCLUDE });
    return this.present(closed);
  }

  /** Managers: every drawer in a date range, with its totals and difference. */
  async list(user: AuthUser, filter: { from?: string; to?: string; userId?: string }) {
    if (!isManagerRole(user.role)) throw new ForbiddenException();
    // A branch manager sees the drawers of the people working in their warehouses.
    const def = seesAllWarehouses(user) ? null : await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    const people = seesAllWarehouses(user) ? {} : { user: warehouseWhere(user, def?.id) as Prisma.UserWhereInput };
    const day = (d: string | undefined, end: boolean) =>
      d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`) : undefined;
    const gte = day(filter.from, false);
    const lte = day(filter.to, true);
    const rows = await this.prisma.cashSession.findMany({
      where: {
        ...people,
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(gte || lte ? { openedAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {}),
      },
      include: CashService.INCLUDE,
      orderBy: { openedAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }
}
