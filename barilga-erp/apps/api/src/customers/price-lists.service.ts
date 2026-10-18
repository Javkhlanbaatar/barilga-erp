import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
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
          ...(dto.validUntil !== undefined ? { validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00Z`) : null } : {}),
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
      validUntil: list.validUntil ? list.validUntil.toISOString().slice(0, 10) : null,
      shared: Boolean(list.shareToken),
      publicPath: list.shareToken ? `/price/${list.shareToken}` : null,
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

  /**
   * What the customer sees on a printed or shared price list: the product, its unit and the price they pay.
   * Costs are never included. `all` adds every other active product at retail, marked as such.
   */
  async sheet(id: string, all = false) {
    const list = await this.prisma.priceList.findUnique({ where: { id }, include: { items: true } });
    if (!list) throw new NotFoundException('Price list not found');
    return this.buildSheet(list, all);
  }

  /** The retail price list (жижиглэн үнэ): every active product at its shelf price. */
  async retailSheet() {
    const products = await this.prisma.product.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { nameMn: 'asc' }],
      select: { sku: true, nameMn: true, unit: true, category: true, priceMnt: true },
    });
    return {
      name: 'Жижиглэн үнийн жагсаалт',
      notes: null,
      validUntil: null,
      generatedAt: new Date().toISOString(),
      items: products.map((p) => ({ sku: p.sku, nameMn: p.nameMn, unit: p.unit, category: p.category, priceMnt: p.priceMnt, retailMnt: p.priceMnt, listed: true })),
    };
  }

  private async buildSheet(
    list: { name: string; notes: string | null; validUntil: Date | null; items: Array<{ productId: string; priceMnt: number }> },
    all: boolean,
  ) {
    const byProduct = new Map(list.items.map((i) => [i.productId, i.priceMnt]));
    const products = await this.prisma.product.findMany({
      where: { active: true, ...(all ? {} : { id: { in: [...byProduct.keys()] } }) },
      orderBy: [{ category: 'asc' }, { nameMn: 'asc' }],
      select: { id: true, sku: true, nameMn: true, unit: true, category: true, priceMnt: true },
    });
    return {
      name: list.name,
      notes: list.notes,
      validUntil: list.validUntil ? list.validUntil.toISOString().slice(0, 10) : null,
      generatedAt: new Date().toISOString(),
      items: products.map((p) => ({
        sku: p.sku,
        nameMn: p.nameMn,
        unit: p.unit,
        category: p.category,
        priceMnt: byProduct.get(p.id) ?? p.priceMnt,
        retailMnt: p.priceMnt,
        listed: byProduct.has(p.id),
      })),
    };
  }

  /** Creates (or returns) the customer's read-only link. */
  async share(id: string, actorId: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('Price list not found');
    if (!list.isActive) throw new BadRequestException('Идэвхгүй жагсаалтыг илгээхгүй / The list is not active');
    const token = list.shareToken ?? randomBytes(24).toString('base64url');
    if (!list.shareToken) {
      await this.prisma.priceList.update({ where: { id }, data: { shareToken: token } });
      this.log.log(`Price list "${list.name}" shared by ${actorId}`);
    }
    return { publicPath: `/price/${token}` };
  }

  /** Turns the link off; anyone holding it sees "not found" from now on. */
  async unshare(id: string, actorId: string) {
    await this.prisma.priceList.updateMany({ where: { id }, data: { shareToken: null } });
    this.log.log(`Price list ${id} link revoked by ${actorId}`);
    return { shared: false };
  }

  /** The sheet behind a shared link; only while the list is active and the link has not been revoked. */
  async publicSheet(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('Price list not found');
    const list = await this.prisma.priceList.findUnique({ where: { shareToken: token }, include: { items: true } });
    if (!list || !list.isActive) throw new NotFoundException('Price list not found');
    return this.buildSheet(list, false);
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
      // Every change is kept for the admin's edits report (a list price can sell below cost).
      const before = new Map(
        (await tx.priceListItem.findMany({ where: { priceListId: id, productId: { in: ids } } })).map((i) => [i.productId, i.priceMnt]),
      );
      const products = new Map(
        (await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, lastCostMnt: true } })).map((p) => [p.id, p]),
      );
      for (const p of dto.prices) {
        const old = before.get(p.productId) ?? null;
        if (old === p.priceMnt) continue;
        const prod = products.get(p.productId);
        const belowCost = p.priceMnt !== null && prod?.lastCostMnt != null && p.priceMnt < prod.lastCostMnt;
        await tx.editAudit.create({
          data: {
            entityType: 'PRICE_LIST_PRICE',
            entityId: p.productId,
            summary: `${list.name} · ${prod?.sku ?? p.productId}: ${old ?? 'жагсаалтгүй'} → ${p.priceMnt ?? 'хассан'}${belowCost ? ' (өртгөөс доош)' : ''}`,
            before: { priceMnt: old },
            after: { priceMnt: p.priceMnt },
            reason: 'Үнийн жагсаалт өөрчилсөн',
            actorId,
          },
        });
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
