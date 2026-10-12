import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { createWithUniqueNumber, isUniqueConflictOn, ulaanbaatarYmd } from '../orders/order-number';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferDto, DispatchTransferDto, ReceiveTransferDto } from './dto/transfer.dto';
import { InventoryService } from './inventory.service';
import { lockedWarehouseId, seesAllWarehouses } from './warehouse-scope';

const TRANSFER_INCLUDE = {
  items: { include: { product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
  fromWarehouse: { select: { id: true, code: true, name: true } },
  toWarehouse: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, fullName: true } },
  sentBy: { select: { id: true, fullName: true } },
  receivedBy: { select: { id: true, fullName: true } },
  cancelledBy: { select: { id: true, fullName: true } },
  order: { select: { id: true, orderNumber: true } },
} as const;

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v.toString());

/**
 * Warehouse-to-warehouse stock transfers. The shops are one legal entity, so a transfer is only a stock
 * movement: no sale, no price, no E-Barimt. Every quantity change goes through InventoryService.applyMovement,
 * so balances, Product.stockQty and the ledger stay consistent.
 *
 *   request  → a shop asks another warehouse for stock; nothing moves; status REQUESTED
 *   send     → stock leaves the source now (TRANSFER_OUT); status IN_TRANSIT (directly, or by dispatching a request)
 *   receive  → what actually arrived enters the destination (TRANSFER_IN); a shortage is recorded with its reason
 *   cancel   → a request is withdrawn/refused (nothing moves), or in-transit stock goes back to the source
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

  /** One positive quantity per product. */
  private quantities(items: Array<{ productId: string; quantity: number }>) {
    const quantities = new Map<string, Prisma.Decimal>();
    for (const item of items) {
      const qty = D(item.quantity);
      if (qty.lte(0)) throw new BadRequestException('Every quantity must be greater than zero');
      if (quantities.has(item.productId)) throw new BadRequestException('Each product may appear only once in a transfer');
      quantities.set(item.productId, qty);
    }
    return quantities;
  }

  private async checkWarehouses(tx: Prisma.TransactionClient, fromId: string, toId: string) {
    if (fromId === toId) throw new BadRequestException('Source and destination must be different warehouses');
    const [from, to] = await Promise.all([
      tx.warehouse.findUnique({ where: { id: fromId } }),
      tx.warehouse.findUnique({ where: { id: toId } }),
    ]);
    if (!from || !to) throw new BadRequestException('Warehouse not found');
    if (!from.isActive || !to.isActive) throw new BadRequestException('Both warehouses must be active');
    return { from, to };
  }

  /** Refuses to take out more than the source holds (a transfer never creates negative stock). */
  private async assertInStock(tx: Prisma.TransactionClient, warehouse: { id: string; name: string }, quantities: Map<string, Prisma.Decimal>) {
    const productIds = [...quantities.keys()].filter((id) => quantities.get(id)!.gt(0));
    const [products, balances] = await Promise.all([
      tx.product.findMany({ where: { id: { in: productIds } } }),
      tx.stockBalance.findMany({ where: { warehouseId: warehouse.id, productId: { in: productIds } } }),
    ]);
    if (products.length !== productIds.length) throw new BadRequestException('Product not found');
    const short = products.filter((p) => D(balances.find((b) => b.productId === p.id)?.quantity ?? 0).lt(quantities.get(p.id)!));
    if (short.length > 0) {
      throw new BadRequestException(`${warehouse.name}-д үлдэгдэл хүрэхгүй / Not enough stock: ${short.map((p) => p.sku).join(', ')}`);
    }
  }

  private async takeOut(tx: Prisma.TransactionClient, transfer: { id: string; transferNumber: string }, fromId: string, toCode: string, quantities: Map<string, Prisma.Decimal>, actorId: string) {
    for (const [productId, qty] of quantities) {
      if (qty.lte(0)) continue;
      await this.inventory.applyMovement(tx, {
        warehouseId: fromId,
        productId,
        delta: qty.negated(),
        type: StockMovementType.TRANSFER_OUT,
        refType: 'TRANSFER',
        refId: transfer.id,
        reason: `${transfer.transferNumber} → ${toCode}`,
        actorId,
      });
    }
  }

  private newNumber<T>(create: (transferNumber: string) => Promise<T>) {
    return createWithUniqueNumber({
      prefix: `TR-${ulaanbaatarYmd()}-`,
      countExisting: (prefix) => this.prisma.stockTransfer.count({ where: { transferNumber: { startsWith: prefix } } }),
      isConflict: (err) => isUniqueConflictOn(err, 'transfer_number') || isUniqueConflictOn(err, 'transferNumber'),
      label: 'a transfer number',
      create,
    });
  }

  /** `orderId` links the transfer to the order it collects stock for (set by the gather flow, never by clients). */
  async send(dto: CreateTransferDto, user: AuthUser, opts: { orderId?: string } = {}) {
    this.assertActsFor(user, dto.fromWarehouseId, 'send a transfer from it');
    const quantities = this.quantities(dto.items);

    const created = await this.newNumber((transferNumber) =>
      // A unique violation aborts a Postgres transaction, so each candidate number gets a fresh one.
      this.prisma.$transaction(async (tx) => {
        const { from, to } = await this.checkWarehouses(tx, dto.fromWarehouseId, dto.toWarehouseId);
        await this.assertInStock(tx, from, quantities);
        const transfer = await tx.stockTransfer.create({
          data: {
            transferNumber,
            status: TransferStatus.IN_TRANSIT,
            fromWarehouseId: from.id,
            toWarehouseId: to.id,
            notes: dto.notes || null,
            orderId: opts.orderId ?? null,
            sentById: user.id,
            sentAt: new Date(),
            items: { create: [...quantities].map(([productId, quantity]) => ({ productId, quantity })) },
          },
        });
        await this.takeOut(tx, transfer, from.id, to.code, quantities, user.id);
        return transfer;
      }, SERIALIZABLE),
    );

    this.log.log(`Transfer ${created.transferNumber} sent ${dto.fromWarehouseId} → ${dto.toWarehouseId} by ${user.id}`);
    return this.get(created.id, user);
  }

  /** A shop asks another warehouse for stock. Nothing moves until the source sends it. */
  async request(dto: CreateTransferDto, user: AuthUser) {
    this.assertActsFor(user, dto.toWarehouseId, 'request stock for it');
    const quantities = this.quantities(dto.items);
    const created = await this.newNumber((transferNumber) =>
      this.prisma.$transaction(async (tx) => {
        const { from, to } = await this.checkWarehouses(tx, dto.fromWarehouseId, dto.toWarehouseId);
        const found = await tx.product.count({ where: { id: { in: [...quantities.keys()] } } });
        if (found !== quantities.size) throw new BadRequestException('Product not found');
        return tx.stockTransfer.create({
          data: {
            transferNumber,
            status: TransferStatus.REQUESTED,
            fromWarehouseId: from.id,
            toWarehouseId: to.id,
            notes: dto.notes || null,
            requestedById: user.id,
            requestedAt: new Date(),
            items: {
              create: [...quantities].map(([productId, qty]) => ({ productId, quantity: D(0), requestedQty: qty })),
            },
          },
        });
      }, SERIALIZABLE),
    );
    this.log.log(`Transfer request ${created.transferNumber} ${dto.fromWarehouseId} → ${dto.toWarehouseId} by ${user.id}`);
    return this.get(created.id, user);
  }

  /**
   * The source sends a request: by default exactly what was asked, or the quantities it actually has (0 = not
   * sending that line). Only one person can dispatch it; the stock leaves the source in the same transaction.
   */
  async dispatch(id: string, dto: DispatchTransferDto, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    this.assertActsFor(user, transfer.fromWarehouseId, 'send stock from it');
    if (transfer.status !== TransferStatus.REQUESTED) throw new ConflictException('Энэ хүсэлт аль хэдийн шийдэгдсэн / Not a pending request');

    const sendQty = new Map<string, Prisma.Decimal>();
    for (const item of transfer.items) sendQty.set(item.productId, D(item.requestedQty ?? 0));
    for (const line of dto.items ?? []) {
      if (!sendQty.has(line.productId)) throw new BadRequestException('Хүсээгүй бараа нэмэх боломжгүй / Product was not requested');
      const qty = D(line.quantity);
      if (qty.lt(0)) throw new BadRequestException('Quantity cannot be negative');
      sendQty.set(line.productId, qty);
    }
    if (![...sendQty.values()].some((q) => q.gt(0))) {
      throw new BadRequestException('Илгээх бараа алга — татгалзах бол «Татгалзах» дарна уу / Nothing to send');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.REQUESTED },
        data: {
          status: TransferStatus.IN_TRANSIT,
          sentById: user.id,
          sentAt: new Date(),
          ...(dto.notes ? { notes: [transfer.notes, dto.notes].filter(Boolean).join(' · ') } : {}),
        },
      });
      if (claimed.count !== 1) throw new ConflictException('Энэ хүсэлтийг өөр хүн шийдсэн / Someone else already handled it');
      const { from, to } = await this.checkWarehouses(tx, transfer.fromWarehouseId, transfer.toWarehouseId);
      await this.assertInStock(tx, from, sendQty);
      for (const item of transfer.items) {
        await tx.stockTransferItem.updateMany({ where: { id: item.id }, data: { quantity: sendQty.get(item.productId)! } });
      }
      await this.takeOut(tx, transfer, from.id, to.code, sendQty, user.id);
    }, SERIALIZABLE);

    this.log.log(`Transfer request ${transfer.transferNumber} dispatched by ${user.id}`);
    return this.get(id, user);
  }

  /**
   * The destination takes in what actually arrived. Lines left out arrived in full. A line that arrived short
   * needs a reason; the missing quantity stays out of both warehouses and is reported as a shortage.
   */
  async receive(id: string, user: AuthUser, dto: ReceiveTransferDto = {}) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    this.assertActsFor(user, transfer.toWarehouseId, 'receive a transfer into it');

    const sent = new Map(transfer.items.map((i) => [i.productId, i]));
    const received = new Map<string, { qty: Prisma.Decimal; reason: string | null }>();
    for (const item of transfer.items) received.set(item.productId, { qty: D(item.quantity), reason: null });
    for (const line of dto.items ?? []) {
      const item = sent.get(line.productId);
      if (!item) throw new BadRequestException('Product is not on this transfer');
      const qty = D(line.receivedQty);
      if (qty.lt(0)) throw new BadRequestException('Quantity cannot be negative');
      if (qty.gt(D(item.quantity))) {
        throw new BadRequestException('Илгээснээс их хүлээн авахгүй — илүү ирсэн бол тохируулгаар засна / Cannot receive more than was sent');
      }
      const reason = line.reason?.trim() || null;
      if (qty.lt(D(item.quantity)) && (!reason || reason.length < 3)) {
        throw new BadRequestException('Дутуу ирсэн барааны шалтгааныг бичнэ үү / A shortage needs a reason');
      }
      received.set(line.productId, { qty, reason: qty.lt(D(item.quantity)) ? reason : null });
    }
    const shortage = transfer.items.some((i) => received.get(i.productId)!.qty.lt(D(i.quantity)));

    await this.prisma.$transaction(async (tx) => {
      // Atomic claim: only one request can move IN_TRANSIT → RECEIVED, so stock is never added twice.
      const claimed = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: { status: TransferStatus.RECEIVED, receivedById: user.id, receivedAt: new Date(), hasShortage: shortage },
      });
      if (claimed.count !== 1) throw new ConflictException('This transfer is no longer in transit');
      for (const item of transfer.items) {
        const r = received.get(item.productId)!;
        await tx.stockTransferItem.updateMany({ where: { id: item.id }, data: { receivedQty: r.qty, shortageReason: r.reason } });
        if (r.qty.lte(0)) continue;
        await this.inventory.applyMovement(tx, {
          warehouseId: transfer.toWarehouseId,
          productId: item.productId,
          delta: r.qty,
          type: StockMovementType.TRANSFER_IN,
          refType: 'TRANSFER',
          refId: id,
          reason: `${transfer.transferNumber} received${r.reason ? ` (дутуу: ${r.reason})` : ''}`,
          actorId: user.id,
        });
      }
    }, SERIALIZABLE);

    this.log.log(`Transfer ${transfer.transferNumber} received by ${user.id}${shortage ? ' WITH SHORTAGE' : ''}`);
    return this.get(id, user);
  }

  /**
   * A request may be withdrawn by the shop that asked or refused by the source (nothing moved). Stock already in
   * transit goes back to the source, and only managers/admin may do that.
   */
  async cancel(id: string, reason: string, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer) throw new NotFoundException('Transfer not found');

    if (transfer.status === TransferStatus.REQUESTED) {
      if (!seesAllWarehouses(user.role)) {
        const locked = lockedWarehouseId(user);
        if (!locked || (locked !== transfer.fromWarehouseId && locked !== transfer.toWarehouseId)) {
          throw new ForbiddenException('Only the two warehouses can refuse or withdraw a request');
        }
      }
      const claimed = await this.prisma.stockTransfer.updateMany({
        where: { id, status: TransferStatus.REQUESTED },
        data: { status: TransferStatus.CANCELLED, cancelledById: user.id, cancelledAt: new Date(), cancelReason: reason },
      });
      if (claimed.count !== 1) throw new ConflictException('Энэ хүсэлт аль хэдийн шийдэгдсэн / Already handled');
      this.log.log(`Transfer request ${transfer.transferNumber} closed by ${user.id}: ${reason}`);
      return this.get(id, user);
    }

    if (!seesAllWarehouses(user.role)) throw new ForbiddenException('Only managers can cancel a transfer in transit');
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: { status: TransferStatus.CANCELLED, cancelledById: user.id, cancelledAt: new Date(), cancelReason: reason },
      });
      if (claimed.count !== 1) throw new ConflictException('Only a transfer that is still in transit can be cancelled');
      const items = await tx.stockTransferItem.findMany({ where: { transferId: id } });
      for (const item of items) {
        if (D(item.quantity).lte(0)) continue;
        // Booked as a reversal of the TRANSFER_OUT (positive delta), so reports show nothing transferred
        // rather than the same quantity both out and in.
        await this.inventory.applyMovement(tx, {
          warehouseId: transfer.fromWarehouseId,
          productId: item.productId,
          delta: item.quantity,
          type: StockMovementType.TRANSFER_OUT,
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

  /**
   * What a shop should ask for: products below their minimum level at `toWarehouseId` that the source holds.
   * Suggests enough to reach twice the minimum, never more than the source has.
   */
  async suggest(toWarehouseId: string, fromWarehouseId: string, user: AuthUser) {
    if (!seesAllWarehouses(user.role)) {
      const locked = lockedWarehouseId(user);
      if (locked !== toWarehouseId && locked !== fromWarehouseId) throw new ForbiddenException();
    }
    const products = await this.prisma.product.findMany({
      where: { active: true, minStockLevel: { gt: 0 } },
      select: { id: true, sku: true, nameMn: true, unit: true, minStockLevel: true },
    });
    if (!products.length) return [];
    const balances = await this.prisma.stockBalance.findMany({
      where: { warehouseId: { in: [toWarehouseId, fromWarehouseId] }, productId: { in: products.map((p) => p.id) } },
    });
    const have = (w: string, p: string) => D(balances.find((b) => b.warehouseId === w && b.productId === p)?.quantity ?? 0);
    return products
      .map((p) => {
        const min = D(p.minStockLevel);
        const atShop = have(toWarehouseId, p.id);
        const atSource = have(fromWarehouseId, p.id);
        const want = Prisma.Decimal.max(min.times(2).minus(atShop), 0).ceil();
        const suggested = Prisma.Decimal.min(want, atSource.floor());
        return { productId: p.id, sku: p.sku, nameMn: p.nameMn, unit: p.unit, minStockLevel: Number(min), atShop: Number(atShop), atSource: Number(atSource), suggested: Number(suggested) };
      })
      .filter((r) => r.atShop < r.minStockLevel && r.suggested > 0);
  }

  /** What is waiting for this user: requests to send from their warehouse, and stock on the way to it. */
  async pending(user: AuthUser) {
    const locked = lockedWarehouseId(user);
    const [toSend, toReceive] = await Promise.all([
      this.prisma.stockTransfer.count({ where: { status: TransferStatus.REQUESTED, ...(locked ? { fromWarehouseId: locked } : {}) } }),
      this.prisma.stockTransfer.count({ where: { status: TransferStatus.IN_TRANSIT, ...(locked ? { toWarehouseId: locked } : {}) } }),
    ]);
    return { toSend, toReceive, total: toSend + toReceive };
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
