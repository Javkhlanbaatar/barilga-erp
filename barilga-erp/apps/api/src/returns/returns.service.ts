import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, PayableStatus, PaymentStatus, PayMethod, Prisma, RefundStatus, Role, SourceType } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { EbarimtService } from '../ebarimt/ebarimt.service';
import { assertCashDrawerOpen } from '../cash/cash-drawer';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, isManagerRole } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';

const RETURN_INCLUDE = {
  items: { include: { orderItem: { include: { product: true } } } },
  createdBy: { select: { id: true, fullName: true, role: true } },
};

@Injectable()
export class ReturnsService {
  private readonly log = new Logger(ReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly ebarimt: EbarimtService,
  ) {}

  async create(orderId: string, dto: CreateReturnDto, user: AuthUser) {
    if (user.role !== Role.BORLUULAGCH && !isManagerRole(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can process returns');
    }
    // Cash handed back comes out of someone's drawer.
    if (dto.refundMethod === PayMethod.CASH) await assertCashDrawerOpen(this.prisma, user.id);

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const created = await this.prisma.$transaction(
          async (tx) => this.processReturn(tx, orderId, dto, user),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        // The return paid off the last of the debt: the order is now fully settled and gets its receipt.
        if (created.debtClosed) await this.ebarimt.issueAfterPaid(orderId);
        await this.ebarimt.refundForReturn({
          returnId: created.id,
          orderNumber: created.orderNumber,
          receiptId: created.receiptId,
          amount: created.refundAmount,
          items: created.ebarimtItems,
        });
        return this.prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: {
            items: { include: { product: true } },
            zone: true,
            payments: { orderBy: { createdAt: 'asc' } },
            createdBy: { select: { id: true, fullName: true, role: true } },
            completedBy: { select: { id: true, fullName: true, role: true } },
            feeOverrides: {
              orderBy: { createdAt: 'desc' },
              include: { actor: { select: { fullName: true, role: true } } },
            },
            returns: { include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' } },
            supplierPayables: true,
          },
        });
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        if (code === 'P2034' && attempt < maxAttempts) {
          this.log.warn(`Return retry ${attempt} for order ${orderId} (serialization conflict)`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async processReturn(
    tx: Prisma.TransactionClient,
    orderId: string,
    dto: CreateReturnDto,
    user: AuthUser,
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true, returnItems: true } },
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Pre-warehouse orders (warehouseId null) belong to the default warehouse.
    assertWarehouseAccess(
      user,
      order.warehouseId,
      order.warehouseId ? undefined : await this.inventory.defaultWarehouseId(tx),
    );
    if (order.status !== OrderStatus.COMPLETED && order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException('Returns are only allowed after the order is paid');
    }

    const byId = new Map(order.items.map((i) => [i.id, i]));
    const stockRestore: Array<{ productId: string; quantity: Prisma.Decimal }> = [];
    const returnLines: Array<{
      orderItemId: string;
      quantity: Prisma.Decimal;
      lineRefund: number;
      sourceType: SourceType;
      name: string;
      unitPrice: number;
    }> = [];
    let refundAmount = 0;

    // Each line is checked against what is still returnable in the database, so the same line twice in one
    // request would slip past that cap.
    if (new Set(dto.items.map((l) => l.orderItemId)).size !== dto.items.length) {
      throw new BadRequestException('Each order line may appear only once in a return');
    }

    for (const line of dto.items) {
      const item = byId.get(line.orderItemId);
      if (!item || item.orderId !== orderId) {
        throw new BadRequestException(`Order item ${line.orderItemId} does not belong to this order`);
      }
      const qty = new Prisma.Decimal(line.quantity);
      if (qty.lte(0)) throw new BadRequestException('Return quantity must be positive');
      const already = item.returnItems.reduce(
        (sum, r) => sum.plus(r.quantity),
        new Prisma.Decimal(0),
      );
      const remaining = new Prisma.Decimal(item.quantity.toString()).minus(already);
      if (qty.gt(remaining)) {
        throw new BadRequestException(
          `Cannot return ${qty.toString()} of ${item.product.nameMn}; remaining ${remaining.toString()}`,
        );
      }
      // Rounding each partial return separately could add up to more than the line was sold for; cap at what
      // is left of the line total, and the final return of a line refunds exactly that remainder.
      const refundedBefore = item.returnItems.reduce((sum, r) => sum + r.lineRefund, 0);
      const moneyLeft = Math.max(0, item.lineTotal - refundedBefore);
      const lineRefund = qty.eq(remaining) ? moneyLeft : Math.min(Math.round(item.unitPrice * Number(qty)), moneyLeft);
      refundAmount += lineRefund;
      returnLines.push({
        orderItemId: item.id,
        quantity: qty,
        lineRefund,
        sourceType: item.sourceType,
        name: item.product.nameMn,
        unitPrice: item.unitPrice,
      });
      if (order.status === OrderStatus.COMPLETED && item.sourceType === SourceType.INTERNAL) {
        stockRestore.push({ productId: item.productId, quantity: qty });
      }
    }

    if (refundAmount <= 0) {
      throw new BadRequestException('Refund amount must be greater than 0');
    }

    // Goods released on account and not yet paid for: returning them lowers the debt; no money is handed
    // back for goods that were never paid. While anything is owed, the debt is reduced first.
    if (dto.refundMethod === PayMethod.OFFSET) {
      throw new BadRequestException('A refund is paid out (cash, card, QPay, transfer) or taken off a debt (CREDIT)');
    }
    // QPay cannot send money back to the payer: QPay purchases are refunded by bank transfer.
    if (dto.refundMethod === PayMethod.QPAY) {
      throw new BadRequestException('QPay-ээр мөнгө буцаах боломжгүй — «Банкны шилжүүлэг» сонгож дансыг бичнэ үү / Refund QPay payments by bank transfer');
    }
    const refundAccount = dto.refundAccount?.trim() || null;
    if (dto.refundMethod === PayMethod.TRANSFER && (!refundAccount || refundAccount.length < 6)) {
      throw new BadRequestException('Мөнгө шилжүүлэх данс (банк, дансны дугаар, нэр)-ыг бичнэ үү / Enter the account to refund to');
    }
    let debtClosed = false;
    const credit = order.payments.find((p) => p.method === PayMethod.CREDIT && p.status === PaymentStatus.UNPAID);
    if (credit && credit.amountMnt > 0) {
      if (dto.refundMethod !== PayMethod.CREDIT) {
        throw new BadRequestException(
          `Энэ захиалгад ${credit.amountMnt}₮ өр байна: буцаалт өрөөс хасагдана (refund method CREDIT)`,
        );
      }
      if (refundAmount > credit.amountMnt) {
        throw new BadRequestException(
          `Буцаалт (${refundAmount}₮) өрөөс (${credit.amountMnt}₮) их байна: эхлээд өрийн хэмжээгээр буцаана уу`,
        );
      }
      const left = credit.amountMnt - refundAmount;
      const lowered = await tx.payment.updateMany({
        where: { id: credit.id, status: PaymentStatus.UNPAID, amountMnt: credit.amountMnt },
        data: { amountMnt: left, ...(left === 0 ? { status: PaymentStatus.PAID, paidAt: new Date() } : {}) },
      });
      if (lowered.count !== 1) throw new BadRequestException('The debt on this order just changed; reload and try again');
      debtClosed = left === 0;
    } else if (dto.refundMethod === PayMethod.CREDIT) {
      throw new BadRequestException('Nothing is owed on this order; choose how the money is refunded');
    } else {
      // Money handed back can never exceed money actually received on the order (cash, card, QPay, transfer)
      // less earlier money refunds: a contract-offset order or a discounted order cannot be turned into cash.
      const received = order.payments
        .filter((p) => p.status === PaymentStatus.PAID && p.method !== PayMethod.OFFSET && p.method !== PayMethod.CREDIT)
        .reduce((s, p) => s + p.amountMnt, 0);
      const earlier = await tx.salesReturn.aggregate({
        where: { orderId, refundMethod: { notIn: [PayMethod.CREDIT, PayMethod.OFFSET] } },
        _sum: { refundAmount: true },
      });
      const left = received - (earlier._sum.refundAmount ?? 0);
      if (refundAmount > left) {
        throw new BadRequestException(
          `Буцааж өгөх мөнгө (${refundAmount}₮) энэ захиалгад орсон мөнгөнөөс (${Math.max(0, left)}₮) их байна. Гэрээгээр олгосон бол тооцоонд залруулга хийнэ.`,
        );
      }
    }

    const salesReturn = await tx.salesReturn.create({
      data: {
        orderId,
        reason: dto.reason.trim(),
        refundAmount,
        refundMethod: dto.refundMethod,
        refundAccount: dto.refundMethod === PayMethod.TRANSFER ? refundAccount : null,
        // Lowering a debt hands nothing back, and cash leaves the drawer right here (the drawer count already
        // subtracts it), so both are done. Card and transfer refunds wait until someone marks them paid out.
        ...(dto.refundMethod === PayMethod.CREDIT || dto.refundMethod === PayMethod.CASH
          ? { refundStatus: RefundStatus.PAID_OUT, paidOutAt: new Date(), paidOutById: user.id }
          : {}),
        createdById: user.id,
        ebarimtStatus: 'PENDING',
        items: {
          create: returnLines.map((l) => ({
            orderItemId: l.orderItemId,
            quantity: l.quantity,
            lineRefund: l.lineRefund,
          })),
        },
      },
    });

    if (stockRestore.length) {
      // Returned goods go back to the warehouse the order was taken from.
      await this.inventory.restoreForReturn(tx, stockRestore, {
        warehouseId: order.warehouseId,
        refType: 'RETURN',
        refId: salesReturn.id,
        reason: `Return on ${order.orderNumber}`,
        actorId: user.id,
      });
    }

    for (const line of returnLines) {
      if (line.sourceType !== SourceType.EXTERNAL_SUPPLIER) continue;
      const payable = await tx.supplierPayable.findFirst({
        where: { orderItemId: line.orderItemId, status: PayableStatus.OPEN },
      });
      if (!payable) continue;
      const nextQty = new Prisma.Decimal(payable.quantity.toString()).minus(line.quantity);
      const nextAmount = Math.max(0, payable.amountMnt - line.lineRefund);
      await tx.supplierPayable.update({
        where: { id: payable.id },
        data: {
          quantity: nextQty.lt(0) ? new Prisma.Decimal(0) : nextQty,
          amountMnt: nextAmount,
          status: nextAmount === 0 || nextQty.lte(0) ? PayableStatus.VOID : PayableStatus.OPEN,
        },
      });
    }

    this.log.log(
      `Return ${salesReturn.id} on ${order.orderNumber} refund=${refundAmount} ${dto.refundMethod} by ${user.email}`,
    );

    return {
      id: salesReturn.id,
      refundAmount,
      debtClosed,
      orderNumber: order.orderNumber,
      receiptId: order.receiptId,
      ebarimtItems: returnLines.map((l) => ({
        name: l.name,
        qty: Number(l.quantity),
        unitPrice: l.unitPrice,
        totalAmount: l.lineRefund,
      })),
    };
  }

  /** A card or bank-transfer refund was actually sent to the customer (managers, their own warehouses). */
  async markPaidOut(returnId: string, user: AuthUser) {
    if (!isManagerRole(user.role)) throw new ForbiddenException('Only managers can confirm a refund payout');
    const ret = await this.prisma.salesReturn.findUnique({ where: { id: returnId }, include: { order: { select: { warehouseId: true } } } });
    if (!ret) throw new NotFoundException('Return not found');
    assertWarehouseAccess(user, ret.order.warehouseId, ret.order.warehouseId ? undefined : await this.inventory.defaultWarehouseId());
    const done = await this.prisma.salesReturn.updateMany({
      where: { id: returnId, refundStatus: RefundStatus.PENDING_PAYOUT },
      data: { refundStatus: RefundStatus.PAID_OUT, paidOutAt: new Date(), paidOutById: user.id },
    });
    if (done.count === 1) {
      this.log.log(`Refund ${returnId} (${ret.refundAmount}₮ ${ret.refundMethod}) paid out, confirmed by ${user.id}`);
    }
    return this.prisma.salesReturn.findUniqueOrThrow({ where: { id: returnId } });
  }
}
