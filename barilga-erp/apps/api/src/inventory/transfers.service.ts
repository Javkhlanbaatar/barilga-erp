import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { createWithUniqueNumber, isUniqueConflictOn, ulaanbaatarYmd } from '../orders/order-number';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferDto } from './dto/transfer.dto';
import { InventoryService } from './inventory.service';
import { lockedWarehouseId, seesAllWarehouses } from './warehouse-scope';

const TRANSFER_INCLUDE = {
  items: { include: { product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
  fromWarehouse: { select: { id: true, code: true, name: true } },
  toWarehouse: { select: { id: true, code: true, name: true } },
  sentBy: { select: { id: true, fullName: true } },
  receivedBy: { select: { id: true, fullName: true } },
  cancelledBy: { select: { id: true, fullName: true } },
  order: { select: { id: true, orderNumber: true } },
} as const;

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

/**
 * Warehouse-to-warehouse stock transfers. The shops are one legal entity, so a transfer is only a stock
 * movement: no sale, no price, no E-Barimt. Every quantity change goes through InventoryService.applyMovement,
 * so balances, Product.stockQty and the ledger stay consistent.
 *
 *   send     → stock leaves the source now (TRANSFER_OUT); status IN_TRANSIT
 *   receive  → stock enters the destination (TRANSFER_IN); status RECEIVED
 *   cancel   → stock goes back to the source (TRANSFER_IN at the source); status CANCELLED
 */
@Injectable()
export class TransfersService {
  private readonly log = new Logger(TransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Staff (non admin/manager) may only act for the warehouse they are assigned to. Unlike sales, staff who
   * have no warehouse assigned are refused: moving stock between shops must always be attributable to one.
   */
  private assertActsFor(user: AuthUser, warehouseId: string, what: string) {
    if (seesAllWarehouses(user.role)) return;
    const locked = lockedWarehouseId(user);
    if (!locked) throw new ForbiddenException(`You must be assigned to a warehouse to ${what}`);
    if (locked !== warehouseId) throw new ForbiddenException(`Only staff of that warehouse can ${what}`);
  }

  /** `orderId` links the transfer to the order it collects stock for (set by the gather flow, never by clients). */
  async send(dto: CreateTransferDto, user: AuthUser, opts: { orderId?: string } = {}) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('Source and destination must be different warehouses');
    }
    this.assertActsFor(user, dto.fromWarehouseId, 'send a transfer from it');

    const quantities = new Map<string, Prisma.Decimal>();
    for (const item of dto.items) {
      const qty = new Prisma.Decimal(item.quantity.toString());
      if (qty.lte(0)) throw new BadRequestException('Every quantity must be greater than zero');
      if (quantities.has(item.productId)) {
        throw new BadRequestException('Each product may appear only once in a transfer');
      }
      quantities.set(item.productId, qty);
    }

    const created = await createWithUniqueNumber({
      prefix: `TR-${ulaanbaatarYmd()}-`,
      countExisting: (prefix) => this.prisma.stockTransfer.count({ where: { transferNumber: { startsWith: prefix } } }),
      isConflict: (err) => isUniqueConflictOn(err, 'transfer_number') || isUniqueConflictOn(err, 'transferNumber'),
      label: 'a transfer number',
      // A unique violation aborts a Postgres transaction, so each candidate number gets a fresh one.
      create: (transferNumber) =>
        this.prisma.$transaction(async (tx) => {
          const [from, to] = await Promise.all([
            tx.warehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
            tx.warehouse.findUnique({ where: { id: dto.toWarehouseId } }),
          ]);
          if (!from || !to) throw new BadRequestException('Warehouse not found');
          if (!from.isActive || !to.isActive) throw new BadRequestException('Both warehouses must be active');

          const productIds = [...quantities.keys()];
          const products = await tx.product.findMany({ where: { id: { in: productIds } } });
          if (products.length !== productIds.length) throw new BadRequestException('Product not found');

          // Unlike a sale, a transfer never sends stock the source does not have.
          const balances = await tx.stockBalance.findMany({
            where: { warehouseId: from.id, productId: { in: productIds } },
          });
          const short = products.filter((p) => {
            const have = balances.find((b) => b.productId === p.id)?.quantity ?? 0;
            return new Prisma.Decimal(have.toString()).lt(quantities.get(p.id)!);
          });
          if (short.length > 0) {
            throw new BadRequestException(
              `Not enough stock in ${from.name}: ${short.map((p) => p.sku).join(', ')}`,
            );
          }

          const transfer = await tx.stockTransfer.create({
            data: {
              transferNumber,
              status: TransferStatus.IN_TRANSIT,
              fromWarehouseId: from.id,
              toWarehouseId: to.id,
              notes: dto.notes || null,
              orderId: opts.orderId ?? null,
              sentById: user.id,
              items: { create: productIds.map((productId) => ({ productId, quantity: quantities.get(productId)! })) },
            },
          });
          for (const [productId, qty] of quantities) {
            await this.inventory.applyMovement(tx, {
              warehouseId: from.id,
              productId,
              delta: qty.negated(),
              type: StockMovementType.TRANSFER_OUT,
              refType: 'TRANSFER',
              refId: transfer.id,
              reason: `${transferNumber} → ${to.code}`,
              actorId: user.id,
            });
          }
          return transfer;
        }, SERIALIZABLE),
    });

    this.log.log(`Transfer ${created.transferNumber} sent ${dto.fromWarehouseId} → ${dto.toWarehouseId} by ${user.id}`);
    return this.get(created.id, user);
  }

  async receive(id: string, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    this.assertActsFor(user, transfer.toWarehouseId, 'receive a transfer into it');

    await this.prisma.$transaction(async (tx) => {
      // Atomic claim: only one request can move IN_TRANSIT → RECEIVED, so stock is never added twice.
      const claimed = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: { status: TransferStatus.RECEIVED, receivedById: user.id, receivedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException('This transfer is no longer in transit');
      const items = await tx.stockTransferItem.findMany({ where: { transferId: id } });
      for (const item of items) {
        await this.inventory.applyMovement(tx, {
          warehouseId: transfer.toWarehouseId,
          productId: item.productId,
          delta: item.quantity,
          type: StockMovementType.TRANSFER_IN,
          refType: 'TRANSFER',
          refId: id,
          reason: `${transfer.transferNumber} received`,
          actorId: user.id,
        });
      }
    }, SERIALIZABLE);

    this.log.log(`Transfer ${transfer.transferNumber} received by ${user.id}`);
    return this.get(id, user);
  }

  /** Managers/admin only (enforced by the controller). Puts the in-transit stock back into the source. */
  async cancel(id: string, reason: string, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer) throw new NotFoundException('Transfer not found');

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: {
          status: TransferStatus.CANCELLED,
          cancelledById: user.id,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('Only a transfer that is still in transit can be cancelled');
      const items = await tx.stockTransferItem.findMany({ where: { transferId: id } });
      for (const item of items) {
        await this.inventory.applyMovement(tx, {
          warehouseId: transfer.fromWarehouseId,
          productId: item.productId,
          delta: item.quantity,
          type: StockMovementType.TRANSFER_IN,
          refType: 'TRANSFER',
          refId: id,
          reason: `${transfer.transferNumber} cancelled: ${reason}`,
          actorId: user.id,
        });
      }
    }, SERIALIZABLE);

    this.log.log(`Transfer ${transfer.transferNumber} cancelled by ${user.id}: ${reason}`);
    return this.get(id, user);
  }

  /** Staff assigned to a warehouse see only transfers into or out of it. */
  private scopeWhere(user: AuthUser): Prisma.StockTransferWhereInput {
    const locked = lockedWarehouseId(user);
    return locked ? { OR: [{ fromWarehouseId: locked }, { toWarehouseId: locked }] } : {};
  }

  list(user: AuthUser, filter: { status?: string; warehouseId?: string; limit?: number } = {}) {
    const status = filter.status && filter.status in TransferStatus ? (filter.status as TransferStatus) : undefined;
    const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.prisma.stockTransfer.findMany({
      where: {
        AND: [
          this.scopeWhere(user),
          status ? { status } : {},
          filter.warehouseId ? { OR: [{ fromWarehouseId: filter.warehouseId }, { toWarehouseId: filter.warehouseId }] } : {},
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: TRANSFER_INCLUDE,
    });
  }

  async get(id: string, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findFirst({
      where: { AND: [{ id }, this.scopeWhere(user)] },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer) throw new NotFoundException('Transfer not found');
    return transfer;
  }
}
