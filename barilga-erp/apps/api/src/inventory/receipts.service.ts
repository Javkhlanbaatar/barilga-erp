import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { createWithUniqueNumber, isUniqueConflictOn, ulaanbaatarYmd } from '../orders/order-number';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReceiptDto } from './dto/receipt.dto';
import { InventoryService } from './inventory.service';
import { lockedWarehouseId, seesAllWarehouses } from './warehouse-scope';

const RECEIPT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  receivedBy: { select: { id: true, fullName: true } },
  items: { include: { product: { select: { id: true, sku: true, nameMn: true, unit: true } } } },
} as const;

/**
 * Goods received from a supplier (бараа орлого). Each line adds stock to one warehouse through
 * InventoryService.applyMovement (type RECEIPT), so balances, Product.stockQty and the ledger stay in step.
 * The unit cost is optional; when given it also becomes the product's last known cost.
 * Mistakes are corrected with a stock adjustment (which records why), not by editing the receipt.
 */
@Injectable()
export class ReceiptsService {
  private readonly log = new Logger(ReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async create(dto: CreateReceiptDto, user: AuthUser) {
    if (!seesAllWarehouses(user.role)) {
      const locked = lockedWarehouseId(user);
      if (!locked) throw new ForbiddenException('You must be assigned to a warehouse to receive goods');
      if (locked !== dto.warehouseId) throw new ForbiddenException('You can only receive goods into your own warehouse');
    }
    const lines = new Map<string, { quantity: Prisma.Decimal; unitCostMnt: number | null }>();
    for (const item of dto.items) {
      const qty = new Prisma.Decimal(item.quantity.toString());
      if (qty.lte(0)) throw new BadRequestException('Every quantity must be greater than zero');
      if (lines.has(item.productId)) throw new BadRequestException('Each product may appear only once in a receipt');
      lines.set(item.productId, { quantity: qty, unitCostMnt: item.unitCostMnt ?? null });
    }

    const created = await createWithUniqueNumber({
      prefix: `OR-${ulaanbaatarYmd()}-`,
      countExisting: (prefix) => this.prisma.stockReceipt.count({ where: { receiptNumber: { startsWith: prefix } } }),
      isConflict: (err) => isUniqueConflictOn(err, 'receipt_number') || isUniqueConflictOn(err, 'receiptNumber'),
      label: 'a receipt number',
      create: (receiptNumber) =>
        this.prisma.$transaction(
          async (tx) => {
            const warehouse = await tx.warehouse.findUnique({ where: { id: dto.warehouseId } });
            if (!warehouse || !warehouse.isActive) throw new BadRequestException('Warehouse not found or inactive');
            const productIds = [...lines.keys()];
            const products = await tx.product.findMany({ where: { id: { in: productIds } } });
            if (products.length !== productIds.length) throw new BadRequestException('Product not found');

            const receipt = await tx.stockReceipt.create({
              data: {
                receiptNumber,
                warehouseId: warehouse.id,
                supplierName: dto.supplierName,
                supplierInvoiceNo: dto.supplierInvoiceNo || null,
                notes: dto.notes || null,
                receivedById: user.id,
                items: {
                  create: productIds.map((productId) => ({
                    productId,
                    quantity: lines.get(productId)!.quantity,
                    unitCostMnt: lines.get(productId)!.unitCostMnt,
                  })),
                },
              },
            });
            for (const [productId, line] of lines) {
              await this.inventory.applyMovement(tx, {
                warehouseId: warehouse.id,
                productId,
                delta: line.quantity,
                type: StockMovementType.RECEIPT,
                refType: 'RECEIPT',
                refId: receipt.id,
                reason: `${receiptNumber} · ${dto.supplierName}${dto.supplierInvoiceNo ? ` #${dto.supplierInvoiceNo}` : ''}`,
                actorId: user.id,
              });
              if (line.unitCostMnt !== null) {
                await tx.product.update({ where: { id: productId }, data: { lastCostMnt: line.unitCostMnt } });
              }
            }
            return receipt;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
    });
    this.log.log(`Receipt ${created.receiptNumber} into ${dto.warehouseId} from "${dto.supplierName}" by ${user.id}`);
    return this.get(created.id, user);
  }

  private scope(user: AuthUser): Prisma.StockReceiptWhereInput {
    const locked = lockedWarehouseId(user);
    return locked ? { warehouseId: locked } : {};
  }

  list(user: AuthUser, filter: { warehouseId?: string; limit?: number } = {}) {
    const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.prisma.stockReceipt.findMany({
      where: { AND: [this.scope(user), filter.warehouseId ? { warehouseId: filter.warehouseId } : {}] },
      orderBy: { receivedAt: 'desc' },
      take,
      include: RECEIPT_INCLUDE,
    });
  }

  async get(id: string, user: AuthUser) {
    const receipt = await this.prisma.stockReceipt.findFirst({
      where: { AND: [{ id }, this.scope(user)] },
      include: RECEIPT_INCLUDE,
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }
}
