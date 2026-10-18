import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountEntryKind, Prisma, StockMovementType } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { createWithUniqueNumber, isUniqueConflictOn, ulaanbaatarYmd } from '../orders/order-number';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReceiptDto } from './dto/receipt.dto';
import { InventoryService } from './inventory.service';
import { assignedWarehouseIds, isManagerRole, warehouseWhere } from './warehouse-scope';

const RECEIPT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  receivedBy: { select: { id: true, fullName: true } },
  supplierCustomer: { select: { id: true, name: true } },
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
    const assigned = assignedWarehouseIds(user);
    if (assigned) {
      if (!assigned.length) throw new ForbiddenException('You must be assigned to a warehouse to receive goods');
      if (!assigned.includes(dto.warehouseId)) throw new ForbiddenException('You can only receive goods into your own warehouse');
    }
    // A cost or a supplier partner creates money we owe (a PURCHASE line on the partner account): managers
    // decide that. Warehouse staff record what arrived; a manager adds the cost later (`үнэ засах`).
    if (!isManagerRole(user.role) && (dto.supplierCustomerId || dto.items.some((i) => i.unitCostMnt != null))) {
      throw new ForbiddenException('Өртөг, нийлүүлэгч харилцагчийг зөвхөн менежер оруулна / Only managers enter costs and supplier partners');
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
            const partner = dto.supplierCustomerId
              ? await tx.customer.findUnique({ where: { id: dto.supplierCustomerId } })
              : null;
            if (dto.supplierCustomerId && !partner) throw new BadRequestException('Supplier partner not found');
            if (partner && !partner.sellsToUs && !partner.barterContract) {
              throw new BadRequestException('Энэ харилцагч нийлүүлэгч биш / Partner is not marked as a supplier');
            }
            const productIds = [...lines.keys()];
            const products = await tx.product.findMany({ where: { id: { in: productIds } } });
            if (products.length !== productIds.length) throw new BadRequestException('Product not found');

            const receipt = await tx.stockReceipt.create({
              data: {
                receiptNumber,
                warehouseId: warehouse.id,
                supplierName: dto.supplierName,
                supplierInvoiceNo: dto.supplierInvoiceNo || null,
                supplierCustomerId: partner?.id ?? null,
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
            // Goods from a registered partner, with prices: we now owe them that much (their account).
            const owed = ReceiptsService.costTotal([...lines.values()]);
            if (partner && owed > 0) {
              await tx.accountEntry.create({
                data: {
                  customerId: partner.id,
                  kind: AccountEntryKind.PURCHASE,
                  amountMnt: owed,
                  description: `Бараа орлого ${receiptNumber}${dto.supplierInvoiceNo ? ` (падаан ${dto.supplierInvoiceNo})` : ''}`,
                  refType: 'RECEIPT',
                  refId: receipt.id,
                  createdById: user.id,
                },
              });
            }
            return receipt;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
    });
    this.log.log(`Receipt ${created.receiptNumber} into ${dto.warehouseId} from "${dto.supplierName}" by ${user.id}`);
    return this.get(created.id, user);
  }

  /** Purchase value of the lines that carry a cost. */
  static costTotal(lines: Array<{ quantity: Prisma.Decimal | number | string; unitCostMnt: number | null }>) {
    return Math.round(lines.reduce((s, l) => s + (l.unitCostMnt === null ? 0 : Number(l.quantity) * l.unitCostMnt), 0));
  }

  /**
   * A manager corrects a purchase price later. The receipt line, the partner account (if any) and — when this
   * is the newest priced receipt of the product — its last cost follow; before/after/reason go to the edit log.
   */
  async editItemCost(receiptId: string, itemId: string, unitCostMnt: number | null, reason: string, user: AuthUser) {
    if (!isManagerRole(user.role)) throw new ForbiddenException('Only a manager or admin can change purchase prices');
    await this.get(receiptId, user); // a branch manager only prices receipts of their own warehouses
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.stockReceiptItem.findFirst({ where: { id: itemId, receiptId }, include: { receipt: true } });
      if (!item) throw new NotFoundException('Receipt line not found');
      if (item.unitCostMnt === unitCostMnt) throw new BadRequestException('The price is unchanged');
      await tx.stockReceiptItem.update({ where: { id: itemId }, data: { unitCostMnt } });

      const newer = await tx.stockReceiptItem.count({
        where: { productId: item.productId, unitCostMnt: { not: null }, receipt: { receivedAt: { gt: item.receipt.receivedAt } } },
      });
      if (newer === 0 && unitCostMnt !== null) {
        await tx.product.update({ where: { id: item.productId }, data: { lastCostMnt: unitCostMnt } });
      }

      if (item.receipt.supplierCustomerId) {
        const all = await tx.stockReceiptItem.findMany({ where: { receiptId } });
        const owed = ReceiptsService.costTotal(all);
        const entry = await tx.accountEntry.findFirst({ where: { refType: 'RECEIPT', refId: receiptId } });
        if (entry) {
          await tx.accountEntry.update({ where: { id: entry.id }, data: { amountMnt: owed } });
        } else if (owed > 0) {
          await tx.accountEntry.create({
            data: {
              customerId: item.receipt.supplierCustomerId,
              kind: AccountEntryKind.PURCHASE,
              amountMnt: owed,
              description: `Бараа орлого ${item.receipt.receiptNumber}`,
              refType: 'RECEIPT',
              refId: receiptId,
              createdById: user.id,
            },
          });
        }
      }

      await tx.editAudit.create({
        data: {
          entityType: 'RECEIPT_ITEM',
          entityId: itemId,
          summary: `Худалдан авсан үнэ засав — ${item.receipt.receiptNumber}`,
          before: { unitCostMnt: item.unitCostMnt, productId: item.productId, quantity: Number(item.quantity) },
          after: { unitCostMnt, productId: item.productId, quantity: Number(item.quantity) },
          reason,
          actorId: user.id,
        },
      });
      // Serializable like attachPartner, so pricing a line while the receipt is moved to a partner cannot leave
      // the partner's account with the old total.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.log.log(`Receipt ${receiptId} line ${itemId} cost → ${unitCostMnt} by ${user.id}: ${reason}`);
    return this.get(receiptId, user);
  }

  /**
   * Goods that came in without a partner chosen (or from the wrong one) are put on a partner's account later:
   * the receipt is linked and its priced lines become what we owe them. Lines priced later follow
   * automatically (editItemCost). Managers only; kept in the edits report.
   */
  async attachPartner(receiptId: string, supplierCustomerId: string | null, reason: string, user: AuthUser) {
    if (!isManagerRole(user.role)) throw new ForbiddenException('Only a manager or admin can change the supplier partner');
    await this.get(receiptId, user);
    await this.prisma.$transaction(
      async (tx) => {
        const receipt = await tx.stockReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { items: true } });
        if ((receipt.supplierCustomerId ?? null) === supplierCustomerId) throw new BadRequestException('Өөрчлөлт алга / Nothing changes');
        const partner = supplierCustomerId ? await tx.customer.findUnique({ where: { id: supplierCustomerId } }) : null;
        if (supplierCustomerId && !partner) throw new BadRequestException('Supplier partner not found');
        if (partner && !partner.sellsToUs && !partner.barterContract) {
          throw new BadRequestException('Энэ харилцагч нийлүүлэгч биш / Partner is not marked as a supplier');
        }
        const entry = await tx.accountEntry.findFirst({ where: { refType: 'RECEIPT', refId: receiptId } });
        const owed = ReceiptsService.costTotal(receipt.items);
        if (entry) await tx.accountEntry.delete({ where: { id: entry.id } });
        if (partner && owed > 0) {
          await tx.accountEntry.create({
            data: {
              customerId: partner.id,
              kind: AccountEntryKind.PURCHASE,
              amountMnt: owed,
              description: `Бараа орлого ${receipt.receiptNumber}${receipt.supplierInvoiceNo ? ` (падаан ${receipt.supplierInvoiceNo})` : ''}`,
              refType: 'RECEIPT',
              refId: receiptId,
              createdById: user.id,
            },
          });
        }
        await tx.stockReceipt.update({
          where: { id: receiptId },
          data: { supplierCustomerId: partner?.id ?? null, ...(partner ? { supplierName: partner.name } : {}) },
        });
        await tx.editAudit.create({
          data: {
            entityType: 'RECEIPT_PARTNER',
            entityId: receiptId,
            summary: `${receipt.receiptNumber}: нийлүүлэгч → ${partner?.name ?? 'харилцагчгүй'} (${owed}₮)`,
            before: { supplierCustomerId: receipt.supplierCustomerId, amountMnt: entry?.amountMnt ?? null },
            after: { supplierCustomerId: partner?.id ?? null, amountMnt: partner && owed > 0 ? owed : null },
            reason,
            actorId: user.id,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.log.log(`Receipt ${receiptId} partner → ${supplierCustomerId ?? 'none'} by ${user.id}: ${reason}`);
    return this.get(receiptId, user);
  }

  private scope(user: AuthUser): Prisma.StockReceiptWhereInput {
    return warehouseWhere(user) as Prisma.StockReceiptWhereInput;
  }

  list(user: AuthUser, filter: { warehouseId?: string; supplierCustomerId?: string; from?: string; to?: string; limit?: number } = {}) {
    const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const ok = (d?: string) => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d));
    const receivedAt =
      ok(filter.from) || ok(filter.to)
        ? {
            ...(ok(filter.from) ? { gte: new Date(`${filter.from}T00:00:00.000+08:00`) } : {}),
            ...(ok(filter.to) ? { lte: new Date(`${filter.to}T23:59:59.999+08:00`) } : {}),
          }
        : undefined;
    return this.prisma.stockReceipt.findMany({
      where: {
        AND: [
          this.scope(user),
          filter.warehouseId ? { warehouseId: filter.warehouseId } : {},
          filter.supplierCustomerId ? { supplierCustomerId: filter.supplierCustomerId } : {},
          receivedAt ? { receivedAt } : {},
        ],
      },
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
