import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PriceShare, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { assertCan, PermissionOverrides } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { ymdInUlaanbaatar } from '../reports/report-dates';
import {
  CreatePriceListDto,
  CreatePriceShareDto,
  MAX_SHEET_CATEGORIES,
  MAX_SHEET_PRODUCTS,
  PRODUCT_ID_RE,
  SetPricesDto,
  UpdatePriceListDto,
} from './dto/price-list.dto';

/** Who is acting (the parts the rights check needs). */
export type PriceListActor = { id: string; role: Role; permissions?: PermissionOverrides };

/**
 * What a sheet shows. `all` adds the products that are not on the list (at retail). `productIds` / `categories`
 * limit it: when both are empty nothing is filtered, otherwise a product is shown when its id is picked OR its
 * category is picked.
 */
export type SheetOptions = { all?: boolean; productIds?: string[]; categories?: string[] };

type SheetList = { name: string; notes: string | null; validUntil: Date | null; items: Array<{ productId: string; priceMnt: number }> };

const RETAIL_NAME = 'Жижиглэн үнийн жагсаалт';

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** A link works through its last day in Ulaanbaatar time. */
const isExpired = (expiresAt: Date | null, today = ymdInUlaanbaatar()) => Boolean(expiresAt) && ymd(expiresAt)! < today;

/** No products or categories picked: the link shows the list as it is. */
const isWholeList = (s: Pick<PriceShare, 'productIds' | 'categories'>) => s.productIds.length === 0 && s.categories.length === 0;

/** The list's own link (what POST :id/share hands out, and what the old per-list links became). */
// A labelled link was made for someone ("Номин"): it is never handed out as the list's own link.
const isPlainLink = (s: PriceShare) => isWholeList(s) && !s.label && !s.includeUnlisted && !s.expiresAt;

const newToken = () => randomBytes(24).toString('base64url');

/** Trimmed, de-duplicated and checked: ids must look like product ids; both lists are capped. */
function cleanSelection(productIds: string[] = [], categories: string[] = []) {
  const ids = [...new Set(productIds.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (ids.some((id) => !PRODUCT_ID_RE.test(id))) throw new BadRequestException('Барааны дугаар буруу / Invalid product id');
  if (ids.length > MAX_SHEET_PRODUCTS) {
    throw new BadRequestException(`Нэг удаад ${MAX_SHEET_PRODUCTS} хүртэл бараа сонгоно / Choose at most ${MAX_SHEET_PRODUCTS} products`);
  }
  const cats = [...new Set(categories.map((s) => String(s).trim()).filter(Boolean))];
  if (cats.some((c) => c.length > 60)) throw new BadRequestException('Ангиллын нэр хэт урт байна / Category name is too long');
  if (cats.length > MAX_SHEET_CATEGORIES) {
    throw new BadRequestException(`Нэг удаад ${MAX_SHEET_CATEGORIES} хүртэл ангилал сонгоно / Choose at most ${MAX_SHEET_CATEGORIES} categories`);
  }
  return { productIds: ids, categories: cats };
}

const inSelection = (sel: { productIds: string[]; categories: string[] }, p: { id: string; category: string }) =>
  isWholeList(sel) || sel.productIds.includes(p.id) || sel.categories.includes(p.category);

/** A price list as the API returns it; the legacy share token is never part of it. */
const listFields = (l: { id: string; name: string; notes: string | null; isActive: boolean; validUntil: Date | null; createdAt: Date; updatedAt: Date }) => ({
  id: l.id,
  name: l.name,
  notes: l.notes,
  isActive: l.isActive,
  validUntil: l.validUntil,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

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

  /** Names and counts for the till and the admin screen. No link tokens (the till reads this). */
  async list(includeInactive = false) {
    const [lists, items, customers] = await Promise.all([
      this.prisma.priceList.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, notes: true, isActive: true, validUntil: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.priceListItem.groupBy({ by: ['priceListId'], _count: { _all: true } }),
      this.prisma.customer.groupBy({ by: ['priceListId'], where: { priceListId: { not: null } }, _count: { _all: true } }),
    ]);
    const productCount = new Map(items.map((g) => [g.priceListId, g._count._all]));
    const customerCount = new Map(customers.map((g) => [g.priceListId, g._count._all]));
    return lists.map((l) => ({ ...listFields(l), productCount: productCount.get(l.id) ?? 0, customerCount: customerCount.get(l.id) ?? 0 }));
  }

  async create(dto: CreatePriceListDto) {
    try {
      const created = await this.prisma.priceList.create({ data: { name: dto.name, notes: dto.notes || null } });
      this.log.log(`Price list "${created.name}" created`);
      return listFields(created);
    } catch (err) {
      this.rethrow(err);
    }
  }

  async update(id: string, dto: UpdatePriceListDto) {
    const existing = await this.prisma.priceList.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Price list not found');
    try {
      const updated = await this.prisma.priceList.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.validUntil !== undefined ? { validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00Z`) : null } : {}),
        },
      });
      return listFields(updated);
    } catch (err) {
      this.rethrow(err);
    }
  }

  /** Every active product with its retail price, last known cost and (if set) this list's price. */
  async prices(id: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id }, include: { items: true } });
    if (!list) throw new NotFoundException('Price list not found');
    const [products, shares] = await Promise.all([
      this.prisma.product.findMany({
        where: { active: true },
        orderBy: { sku: 'asc' },
        select: { id: true, sku: true, nameMn: true, unit: true, category: true, priceMnt: true, lastCostMnt: true },
      }),
      this.prisma.priceShare.findMany({ where: { priceListId: id, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const today = ymdInUlaanbaatar();
    const live = shares.filter((s) => !isExpired(s.expiresAt, today));
    const link = live.find(isPlainLink);
    const byProduct = new Map(list.items.map((i) => [i.productId, i.priceMnt]));
    return {
      id: list.id,
      name: list.name,
      notes: list.notes,
      isActive: list.isActive,
      validUntil: ymd(list.validUntil),
      shared: Boolean(link),
      publicPath: link ? `/price/${link.token}` : null,
      /** Links that work now (the whole-list one and any limited ones). */
      shareCount: live.length,
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
  async sheet(id: string, opts: SheetOptions = {}) {
    const list = await this.prisma.priceList.findUnique({ where: { id }, include: { items: true } });
    if (!list) throw new NotFoundException('Price list not found');
    return this.buildSheet(list, opts);
  }

  /** The retail price list (жижиглэн үнэ): active products at their shelf price. */
  async retailSheet(opts: Omit<SheetOptions, 'all'> = {}) {
    return this.buildSheet(null, opts);
  }

  /**
   * One builder for every sheet. `list` null = the retail prices. A list shows its own products at the list
   * price (and with `all` the rest at retail); the selection then narrows that down. `scope` is set when the
   * sheet was narrowed (the print says "Сонгосон N бараа").
   */
  private async buildSheet(list: SheetList | null, opts: SheetOptions = {}) {
    const { productIds, categories } = cleanSelection(opts.productIds, opts.categories);
    const selected = productIds.length > 0 || categories.length > 0;
    const byProduct = new Map((list?.items ?? []).map((i) => [i.productId, i.priceMnt]));
    const where: Prisma.ProductWhereInput = { active: true };
    if (list && !opts.all) where.id = { in: [...byProduct.keys()] };
    if (selected) {
      where.OR = [
        ...(productIds.length ? [{ id: { in: productIds } }] : []),
        ...(categories.length ? [{ category: { in: categories } }] : []),
      ];
    }
    const products = await this.prisma.product.findMany({
      where,
      orderBy: [{ category: 'asc' }, { nameMn: 'asc' }],
      select: { id: true, sku: true, nameMn: true, unit: true, category: true, priceMnt: true },
    });
    const items = products.map((p) => ({
      sku: p.sku,
      nameMn: p.nameMn,
      unit: p.unit,
      category: p.category,
      priceMnt: list ? (byProduct.get(p.id) ?? p.priceMnt) : p.priceMnt,
      retailMnt: p.priceMnt,
      listed: list ? byProduct.has(p.id) : true,
    }));
    return {
      name: list?.name ?? RETAIL_NAME,
      notes: list?.notes ?? null,
      validUntil: ymd(list?.validUntil),
      generatedAt: new Date().toISOString(),
      scope: selected ? { count: items.length, categories } : null,
      items,
    };
  }

  /** A link as the managers see it (with its token, to copy it again). */
  private view(s: PriceShare, today = ymdInUlaanbaatar()) {
    return {
      id: s.id,
      token: s.token,
      publicPath: `/price/${s.token}`,
      label: s.label,
      priceListId: s.priceListId,
      productIds: s.productIds,
      categories: s.categories,
      includeUnlisted: s.includeUnlisted,
      expiresAt: ymd(s.expiresAt),
      revokedAt: s.revokedAt,
      createdAt: s.createdAt,
      status: s.revokedAt ? 'REVOKED' : isExpired(s.expiresAt, today) ? 'EXPIRED' : 'ACTIVE',
      productCount: s.productIds.length,
      categoryCount: s.categories.length,
    };
  }

  /**
   * A read-only link for a customer: a list (or, with priceListId null, the retail prices) limited to the
   * chosen products / categories. Retail prices are public, so the till may send those; a list needs the right.
   */
  async createShare(dto: CreatePriceShareDto, actor: PriceListActor) {
    const priceListId = dto.priceListId ?? null;
    if (priceListId) {
      assertCan(actor, 'PRICE_LIST_WRITE');
      const list = await this.prisma.priceList.findUnique({ where: { id: priceListId } });
      if (!list) throw new NotFoundException('Price list not found');
      if (!list.isActive) throw new BadRequestException('Идэвхгүй жагсаалтыг илгээхгүй / The list is not active');
    }
    const { productIds, categories } = cleanSelection(dto.productIds, dto.categories);
    if (productIds.length) {
      const found = await this.prisma.product.count({ where: { id: { in: productIds } } });
      if (found !== productIds.length) throw new BadRequestException('Сонгосон бараа олдсонгүй / A chosen product was not found');
    }
    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(`${dto.expiresAt}T00:00:00Z`);
      if (Number.isNaN(expiresAt.getTime()) || ymd(expiresAt) !== dto.expiresAt) throw new BadRequestException('Дуусах өдөр буруу / Invalid end date');
      if (dto.expiresAt < ymdInUlaanbaatar()) throw new BadRequestException('Дуусах өдөр өнгөрсөн байна / The end date has already passed');
    }
    const share = await this.prisma.priceShare.create({
      data: {
        token: newToken(),
        label: dto.label || null,
        priceListId,
        productIds,
        categories,
        // Retail has no "unlisted" products.
        includeUnlisted: priceListId ? Boolean(dto.includeUnlisted) : false,
        expiresAt,
        createdById: actor.id,
      },
    });
    this.log.log(
      `Price link ${share.id} (${priceListId ?? 'retail'}, ${productIds.length} product(s), ${categories.length} categor(ies)) created by ${actor.id}`,
    );
    return this.view(share);
  }

  /** The links of one list (or `retail`), newest first, with how many products each shows now. */
  async listShares(priceListId: string | undefined, actor: PriceListActor) {
    if (!priceListId) throw new BadRequestException('Үнийн жагсаалтаа сонгоно уу / priceListId is required (a list id or "retail")');
    const retail = priceListId === 'retail';
    let listed: Set<string> | null = null;
    if (!retail) {
      assertCan(actor, 'PRICE_LIST_WRITE');
      const list = await this.prisma.priceList.findUnique({ where: { id: priceListId }, include: { items: true } });
      if (!list) throw new NotFoundException('Price list not found');
      listed = new Set(list.items.map((i) => i.productId));
    }
    const shares = await this.prisma.priceShare.findMany({
      where: { priceListId: retail ? null : priceListId },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { fullName: true } } },
    });
    if (!shares.length) return [];
    const products = await this.prisma.product.findMany({ where: { active: true }, select: { id: true, category: true } });
    const onList = listed;
    const listedProducts = onList ? products.filter((p) => onList.has(p.id)) : products;
    const today = ymdInUlaanbaatar();
    return shares.map((s) => {
      const base = listed && !s.includeUnlisted ? listedProducts : products;
      return {
        ...this.view(s, today),
        createdBy: s.createdBy?.fullName ?? null,
        /** Products the link shows today. */
        itemCount: base.filter((p) => inSelection(s, p)).length,
      };
    });
  }

  /** Turns one link off; anyone holding it sees "not found" from now on. */
  async revokeShare(id: string, actor: PriceListActor) {
    const share = await this.prisma.priceShare.findUnique({ where: { id } });
    if (!share) throw new NotFoundException('Холбоос олдсонгүй / Link not found');
    if (share.priceListId) assertCan(actor, 'PRICE_LIST_WRITE');
    if (!share.revokedAt) {
      await this.prisma.priceShare.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
      this.log.log(`Price link ${id} revoked by ${actor.id}`);
    }
    return { id, revoked: true };
  }

  /** Shortcut for the list screen: returns (or creates) the list's own link to the whole list. */
  async share(id: string, actorId: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('Price list not found');
    if (!list.isActive) throw new BadRequestException('Идэвхгүй жагсаалтыг илгээхгүй / The list is not active');
    const today = ymdInUlaanbaatar();
    const existing = (await this.prisma.priceShare.findMany({ where: { priceListId: id, revokedAt: null }, orderBy: { createdAt: 'desc' } })).find(
      (s) => isPlainLink(s) && !isExpired(s.expiresAt, today),
    );
    if (existing) return this.view(existing, today);
    const created = await this.prisma.priceShare.create({ data: { token: newToken(), priceListId: id, createdById: actorId } });
    this.log.log(`Price list "${list.name}" shared by ${actorId}`);
    return this.view(created, today);
  }

  /** Turns off the list's own everyday link. Links made for someone (named, dated, limited) stay; they are closed one by one. */
  async unshare(id: string, actorId: string) {
    const ids = (await this.prisma.priceShare.findMany({ where: { priceListId: id, revokedAt: null } })).filter(isPlainLink).map((s) => s.id);
    if (ids.length) {
      await this.prisma.priceShare.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    this.log.log(`Price list ${id}: ${ids.length} link(s) revoked by ${actorId}`);
    return { shared: false };
  }

  /**
   * The sheet behind a link: only while the link is open, not past its last day and the list is active, and
   * only the products the link was made for.
   */
  async publicSheet(token: string) {
    if (!token || token.length < 20 || token.length > 100) throw new NotFoundException('Price list not found');
    const share = await this.prisma.priceShare.findUnique({ where: { token } });
    if (!share) throw new NotFoundException('Price list not found');
    if (share.revokedAt) throw new NotFoundException('Энэ холбоосыг хаасан / This link has been closed');
    if (isExpired(share.expiresAt)) throw new NotFoundException('Энэ холбоосын хугацаа дууссан / This link has expired');
    let list: SheetList | null = null;
    if (share.priceListId) {
      const found = await this.prisma.priceList.findUnique({ where: { id: share.priceListId }, include: { items: true } });
      if (!found || !found.isActive) throw new NotFoundException('Price list not found');
      list = found;
    }
    const sheet = await this.buildSheet(list, { all: share.includeUnlisted, productIds: share.productIds, categories: share.categories });
    return { ...sheet, label: share.label };
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
