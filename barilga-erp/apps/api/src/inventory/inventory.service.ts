import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SourceType, StockMovementType } from '@prisma/client';
import { productSearchFilter } from '../catalog/product-search';
import { PrismaService } from '../prisma/prisma.service';

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'NEGATIVE_STOCK';

export type WarehouseStock = { warehouseId: string; code: string; name: string; quantity: number };

export type StockItem = {
  id: string;
  sku: string;
  nameMn: string;
  nameEn: string;
  unit: string;
  active: boolean;
  /** Quantity in the selected warehouse, or the total across all warehouses when none is selected. */
  stockQty: number;
  minStockLevel: number;
  imageUrl: string | null;
  description: string | null;
  category: string;
  priceMnt: number;
  weightKg: number;
  lengthM: number;
  volumeM3: number;
  lowStock: boolean;
  status: StockStatus;
  warehouses?: WarehouseStock[];
};

/** Who/what a stock change is for. Written to the ledger row. */
export type StockContext = {
  /** Warehouse the stock moves in. Null/undefined = the default warehouse (legacy orders). */
  warehouseId?: string | null;
  refType?: string;
  refId?: string;
  reason?: string;
  actorId?: string | null;
};

type Db = Prisma.TransactionClient;

const ZERO = new Prisma.Decimal(0);
const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v.toString());

@Injectable()
export class InventoryService {
  private readonly log = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ───────── warehouses ─────────

  /** Per active warehouse: on hand and in transit to it, for one product. */
  async availability(productId: string) {
    const [product, warehouses, balances, transit] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: productId }, select: { id: true, sku: true, nameMn: true, unit: true, priceMnt: true } }),
      this.prisma.warehouse.findMany({ where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, code: true, name: true } }),
      this.prisma.stockBalance.findMany({ where: { productId } }),
      this.prisma.stockTransferItem.findMany({
        where: { productId, transfer: { status: 'IN_TRANSIT' } },
        select: { quantity: true, transfer: { select: { toWarehouseId: true } } },
      }),
    ]);
    if (!product) return null;
    return {
      product,
      warehouses: warehouses.map((w) => ({
        ...w,
        quantity: Number(balances.find((b) => b.warehouseId === w.id)?.quantity ?? 0),
        inTransit: transit.filter((t) => t.transfer.toWarehouseId === w.id).reduce((s, t) => s + Number(t.quantity), 0),
      })),
    };
  }

  async defaultWarehouseId(db: Db | PrismaService = this.prisma): Promise<string> {
    const w = await db.warehouse.findFirst({ where: { isDefault: true } });
    if (!w) throw new ConflictException('No default warehouse is configured');
    return w.id;
  }

  /** The requested warehouse (must exist and be active) or the default one. */
  async resolveWarehouseId(db: Db | PrismaService, requested?: string | null): Promise<string> {
    if (!requested) return this.defaultWarehouseId(db);
    const w = await db.warehouse.findUnique({ where: { id: requested } });
    if (!w) throw new BadRequestException('Warehouse not found');
    if (!w.isActive) throw new BadRequestException('Warehouse is not active');
    return w.id;
  }

  listWarehouses(includeInactive = false) {
    return this.prisma.warehouse.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    });
  }

  // ───────── the one place stock changes ─────────

  /**
   * Applies a signed quantity to one product in one warehouse: updates the warehouse balance, keeps
   * Product.stockQty equal to the total, and appends a ledger row. Every stock change goes through here.
   */
  async applyMovement(
    tx: Db,
    input: { productId: string; delta: Prisma.Decimal | number | string; type: StockMovementType } & StockContext,
  ): Promise<{ warehouseId: string; before: Prisma.Decimal; after: Prisma.Decimal }> {
    const delta = dec(input.delta);
    const warehouseId = await this.resolveStockWarehouse(tx, input.warehouseId);
    const balance = await tx.stockBalance.upsert({
      where: { warehouseId_productId: { warehouseId, productId: input.productId } },
      create: { warehouseId, productId: input.productId, quantity: delta },
      update: { quantity: { increment: delta } },
    });
    const after = dec(balance.quantity);
    await tx.product.update({
      where: { id: input.productId },
      data: { stockQty: { increment: delta } },
    });
    await tx.stockMovement.create({
      data: {
        warehouseId,
        productId: input.productId,
        type: input.type,
        quantityDelta: delta,
        balanceAfter: after,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        reason: input.reason ?? null,
        actorId: input.actorId ?? null,
      },
    });
    return { warehouseId, before: after.minus(delta), after };
  }

  /** Stock changes may target an inactive warehouse (e.g. closing out history), but it must exist. */
  private async resolveStockWarehouse(tx: Db, requested?: string | null): Promise<string> {
    if (!requested) return this.defaultWarehouseId(tx);
    const w = await tx.warehouse.findUnique({ where: { id: requested } });
    if (!w) throw new BadRequestException('Warehouse not found');
    return w.id;
  }

  async deductForOrder(
    tx: Db,
    items: Array<{
      productId: string;
      quantity: Prisma.Decimal | number | string;
      sourceType?: SourceType | string;
    }>,
    ctx: StockContext = {},
  ) {
    const needed = new Map<string, Prisma.Decimal>();
    for (const line of items) {
      if (line.sourceType === SourceType.EXTERNAL_SUPPLIER || line.sourceType === 'EXTERNAL_SUPPLIER') {
        continue;
      }
      const qty = dec(line.quantity);
      if (qty.lte(0)) continue;
      needed.set(line.productId, (needed.get(line.productId) ?? ZERO).plus(qty));
    }
    if (needed.size === 0) return;

    const products = await tx.product.findMany({ where: { id: { in: [...needed.keys()] } } });
    const byId = new Map(products.map((p) => [p.id, p]));

    for (const [productId, qty] of needed) {
      const product = byId.get(productId);
      if (!product) {
        throw new NotFoundException(`Product ${productId} is missing from inventory`);
      }
      const { before, after } = await this.applyMovement(tx, {
        ...ctx,
        refType: ctx.refType ?? 'ORDER',
        productId,
        delta: qty.negated(),
        type: StockMovementType.SALE,
      });
      if (after.lt(0)) {
        this.log.warn(
          `Oversold ${product.sku}: ${before.toString()} → ${after.toString()} (−${qty.toString()}). Reconcile via assign-supplier.`,
        );
      } else {
        this.log.log(`Stock ${product.sku}: ${before.toString()} → ${after.toString()} (−${qty.toString()})`);
      }
    }
  }

  async restoreForReturn(
    tx: Db,
    items: Array<{ productId: string; quantity: Prisma.Decimal | number | string }>,
    ctx: StockContext = {},
  ) {
    for (const line of items) {
      const qty = dec(line.quantity);
      if (qty.lte(0)) continue;
      await this.applyMovement(tx, {
        ...ctx,
        refType: ctx.refType ?? 'ORDER',
        productId: line.productId,
        delta: qty,
        type: StockMovementType.RETURN,
      });
      this.log.log(`Stock restore ${line.productId} +${qty.toString()}`);
    }
  }

  /** Returns stock that had been taken for a line that a supplier actually delivered (manager reconciliation). */
  reconcileRestore(tx: Db, productId: string, quantity: Prisma.Decimal | number | string, ctx: StockContext) {
    return this.applyMovement(tx, {
      ...ctx,
      refType: ctx.refType ?? 'ORDER',
      productId,
      delta: quantity,
      type: StockMovementType.RECONCILE,
    });
  }

  /**
   * Manual correction by a manager: either add/remove a quantity or set the counted quantity. A reason is
   * mandatory so the ledger always says why.
   */
  async adjust(
    input: {
      warehouseId: string;
      productId: string;
      reason: string;
      actorId: string;
    } & ({ delta: number } | { countedQuantity: number }),
  ) {
    return this.prisma.$transaction((tx) => this.adjustInTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  /** Same as {@link adjust} inside a caller's transaction (e.g. together with a product edit). */
  async adjustInTx(
    tx: Db,
    input: {
      warehouseId: string;
      productId: string;
      reason: string;
      actorId: string;
    } & ({ delta: number } | { countedQuantity: number }),
  ) {
    const reason = input.reason?.trim();
    if (!reason || reason.length < 3) throw new BadRequestException('A reason is required for a stock adjustment');
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw new NotFoundException('Product not found');
    const current = await tx.stockBalance.findUnique({
      where: { warehouseId_productId: { warehouseId: input.warehouseId, productId: input.productId } },
    });
    const currentQty = current ? dec(current.quantity) : ZERO;
    const delta = 'delta' in input ? dec(input.delta) : dec(input.countedQuantity).minus(currentQty);
    if (delta.isZero()) throw new BadRequestException('The adjustment does not change the quantity');
    const result = await this.applyMovement(tx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      delta,
      type: StockMovementType.ADJUSTMENT,
      refType: 'ADJUSTMENT',
      reason,
      actorId: input.actorId,
    });
    this.log.log(
      `Adjust ${product.sku} @${input.warehouseId}: ${result.before.toString()} → ${result.after.toString()} by ${input.actorId}: ${reason}`,
    );
    return {
      warehouseId: result.warehouseId,
      productId: input.productId,
      before: Number(result.before),
      after: Number(result.after),
    };
  }

  /** Called when a product is created with a starting quantity. */
  openingBalance(tx: Db, productId: string, quantity: number, ctx: StockContext) {
    if (!quantity) return Promise.resolve(null);
    return this.applyMovement(tx, {
      ...ctx,
      refType: 'OPENING',
      productId,
      delta: quantity,
      type: StockMovementType.OPENING,
      reason: ctx.reason ?? 'Эхний үлдэгдэл',
    });
  }

  // ───────── reads ─────────

  async listStock(q?: string, scope: { warehouseId?: string | null; allowed?: string[] | null } = {}) {
    const warehouses = await this.prisma.warehouse.findMany({
      where: { isActive: true, ...(scope.allowed ? { id: { in: scope.allowed } } : {}) },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    });
    if (scope.warehouseId && !warehouses.some((w) => w.id === scope.warehouseId)) {
      throw new NotFoundException('Warehouse not found');
    }
    const products = await this.prisma.product.findMany({
      where: await productSearchFilter(this.prisma, q),
      orderBy: { sku: 'asc' },
      include: { stockBalances: true },
    });
    const items = products.map((p) => {
      const perWarehouse: WarehouseStock[] = warehouses.map((w) => {
        const row = p.stockBalances.find((b) => b.warehouseId === w.id);
        return { warehouseId: w.id, code: w.code, name: w.name, quantity: row ? Number(row.quantity) : 0 };
      });
      const selected = scope.warehouseId
        ? (perWarehouse.find((w) => w.warehouseId === scope.warehouseId)?.quantity ?? 0)
        : scope.allowed
          ? perWarehouse.reduce((s, w) => s + w.quantity, 0)
          : p.stockBalances.reduce((s, b) => s + Number(b.quantity), 0);
      return { ...this.toStockItem({ ...p, stockQty: selected }), warehouses: perWarehouse };
    });
    return {
      warehouseId: scope.warehouseId ?? null,
      warehouses: warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name, isDefault: w.isDefault })),
      items,
      summary: {
        total: items.length,
        inStock: items.filter((i) => i.status === 'IN_STOCK').length,
        lowStock: items.filter((i) => i.status === 'LOW_STOCK').length,
        outOfStock: items.filter((i) => i.status === 'OUT_OF_STOCK').length,
        negativeStock: items.filter((i) => i.status === 'NEGATIVE_STOCK').length,
      },
    };
  }

  /** Ledger for one product (optionally one warehouse), newest first. */
  async listMovements(filter: { productId?: string; warehouseId?: string; allowed?: string[] | null; limit?: number }) {
    const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.prisma.stockMovement.findMany({
      where: {
        ...(filter.productId ? { productId: filter.productId } : {}),
        ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : filter.allowed ? { warehouseId: { in: filter.allowed } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        product: { select: { sku: true, nameMn: true, unit: true } },
        warehouse: { select: { code: true, name: true } },
        actor: { select: { fullName: true } },
      },
    });
  }

  async listReconciliation() {
    const balances = await this.prisma.stockBalance.findMany({
      where: { quantity: { lt: 0 } },
      include: { product: true, warehouse: { select: { code: true, name: true } } },
    });
    const productIds = [...new Set(balances.map((b) => b.productId))];
    const products = productIds.length
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } }, orderBy: { stockQty: 'asc' } })
      : [];
    const lines =
      productIds.length === 0
        ? []
        : await this.prisma.orderItem.findMany({
            where: {
              productId: { in: productIds },
              sourceType: SourceType.INTERNAL,
              order: { status: { in: ['COMPLETED', 'READY_FOR_LOADING'] } },
            },
            include: {
              product: true,
              returnItems: true,
              payables: true,
              order: { select: { id: true, orderNumber: true, status: true, customerName: true } },
            },
            orderBy: { order: { createdAt: 'desc' } },
          });

    const unassigned = lines
      .map((line) => {
        const returned = line.returnItems.reduce((sum, r) => sum.plus(r.quantity), new Prisma.Decimal(0));
        const remaining = new Prisma.Decimal(line.quantity.toString()).minus(returned);
        const hasOpenPayable = line.payables.some((p) => p.status === 'OPEN');
        return { line, remaining, hasOpenPayable };
      })
      .filter((row) => row.remaining.gt(0) && !row.hasOpenPayable)
      .map(({ line, remaining }) => ({
        orderId: line.order.id,
        orderNumber: line.order.orderNumber,
        orderStatus: line.order.status,
        customerName: line.order.customerName,
        orderItemId: line.id,
        productId: line.productId,
        sku: line.product.sku,
        nameMn: line.product.nameMn,
        remainingQty: Number(remaining),
        unitPrice: line.unitPrice,
        amountMnt: Math.round(line.unitPrice * Number(remaining)),
        currentStock: Number(line.product.stockQty),
      }));

    return {
      products: products.map((p) => this.toStockItem(p)),
      negativeBalances: balances.map((b) => ({
        warehouseId: b.warehouseId,
        warehouse: b.warehouse.name,
        productId: b.productId,
        sku: b.product.sku,
        quantity: Number(b.quantity),
      })),
      lines: unassigned,
      summary: {
        negativeProducts: products.length,
        unassignedLines: unassigned.length,
      },
    };
  }

  toStockItem(p: {
    id: string;
    sku: string;
    nameMn: string;
    nameEn: string;
    unit: string;
    active: boolean;
    stockQty: Prisma.Decimal | number;
    minStockLevel: Prisma.Decimal | number;
    imageUrl?: string | null;
    description?: string | null;
    category?: string;
    priceMnt?: number;
    weightKg?: Prisma.Decimal | number;
    lengthM?: Prisma.Decimal | number;
    volumeM3?: Prisma.Decimal | number;
  }): StockItem {
    const stockQty = Number(p.stockQty);
    const minStockLevel = Number(p.minStockLevel);
    const status: StockStatus =
      stockQty < 0
        ? 'NEGATIVE_STOCK'
        : stockQty === 0
          ? 'OUT_OF_STOCK'
          : stockQty <= minStockLevel
            ? 'LOW_STOCK'
            : 'IN_STOCK';
    return {
      id: p.id,
      sku: p.sku,
      nameMn: p.nameMn,
      nameEn: p.nameEn,
      unit: p.unit,
      active: p.active,
      stockQty,
      minStockLevel,
      imageUrl: p.imageUrl ?? null,
      description: p.description ?? null,
      category: p.category ?? 'General',
      priceMnt: Number(p.priceMnt ?? 0),
      weightKg: Number(p.weightKg ?? 0),
      lengthM: Number(p.lengthM ?? 0),
      volumeM3: Number(p.volumeM3 ?? 0),
      lowStock: status !== 'IN_STOCK',
      status,
    };
  }
}
