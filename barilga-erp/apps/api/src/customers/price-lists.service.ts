import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePriceListDto, SetPricesDto, UpdatePriceListDto } from './dto/price-list.dto';

/**
 * Named per-product price sets (өртгийн үнэ, бартерын үнэ, бөөний үнэ ...). A customer on a list buys every
 * product in it at the list price and everything else at retail. Prices are typed per product.
 */
@Injectable()
export class PriceListsService {
  private readonly log = new Logger(PriceListsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private rethrow(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException('A price list with this name already exists');
    }
    throw err;
  }

  async list(includeInactive = false) {
    const lists = await this.prisma.priceList.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { items: true, customers: true } } },
    });
    return lists.map(({ _count, ...l }) => ({ ...l, productCount: _count.items, customerCount: _count.customers }));
  }

  async create(dto: CreatePriceListDto) {
    try {
      const created = await this.prisma.priceList.create({ data: { name: dto.name, notes: dto.notes || null } });
      this.log.log(`Price list "${created.name}" created`);
      return created;
    } catch (err) {
      this.rethrow(err);
    }
  }

  async update(id: string, dto: UpdatePriceListDto) {
    const existing = await this.prisma.priceList.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Price list not found');
    try {
      return await this.prisma.priceList.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (err) {
      this.rethrow(err);
    }
  }

  /** Every active product with its retail price, last known cost and (if set) this list's price. */
  async prices(id: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id }, include: { items: true } });
    if (!list) throw new NotFoundException('Price list not found');
    const products = await this.prisma.product.findMany({
      where: { active: true },
      orderBy: { sku: 'asc' },
      select: { id: true, sku: true, nameMn: true, unit: true, category: true, priceMnt: true, lastCostMnt: true },
    });
    const byProduct = new Map(list.items.map((i) => [i.productId, i.priceMnt]));
    return {
      id: list.id,
      name: list.name,
      notes: list.notes,
      isActive: list.isActive,
      products: products.map((p) => ({
        productId: p.id,
        sku: p.sku,
        nameMn: p.nameMn,
        unit: p.unit,
        category: p.category,
        retailMnt: p.priceMnt,
        lastCostMnt: p.lastCostMnt,
        listPriceMnt: byProduct.get(p.id) ?? null,
      })),
    };
  }

  /** Sets (or with null, removes) list prices for the given products in one transaction. */
  async setPrices(id: string, dto: SetPricesDto, actorId: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('Price list not found');
    const ids = [...new Set(dto.prices.map((p) => p.productId))];
    if (ids.length !== dto.prices.length) throw new BadRequestException('Each product may appear only once');
    const found = await this.prisma.product.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new BadRequestException('Product not found');

    await this.prisma.$transaction(async (tx) => {
      for (const p of dto.prices) {
        if (p.priceMnt === null) {
          await tx.priceListItem.deleteMany({ where: { priceListId: id, productId: p.productId } });
        } else {
          await tx.priceListItem.upsert({
            where: { priceListId_productId: { priceListId: id, productId: p.productId } },
            create: { priceListId: id, productId: p.productId, priceMnt: p.priceMnt },
            update: { priceMnt: p.priceMnt },
          });
        }
      }
    });
    this.log.log(`Price list "${list.name}": ${dto.prices.length} price(s) changed by ${actorId}`);
    return this.prices(id);
  }
}
