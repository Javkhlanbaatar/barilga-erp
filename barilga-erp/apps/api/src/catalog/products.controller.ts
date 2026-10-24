import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { CATALOG_READ_ROLES, CATALOG_WRITE_ROLES } from '../auth/rbac';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { assertCan, Permission } from '../auth/permissions';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, isManagerRole } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { nextInStoreBarcode, normalizeBarcode } from './barcode';
import { productSearchFilter, productSearchTerm } from './product-search';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function productUploadDir() {
  const dir = join(process.cwd(), 'uploads', 'products');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Stored as a plain JSON list; an empty list is stored as nothing. A companion picked from the catalog keeps its productId. */
function companionsValue(list: CreateProductDto['companions']): Prisma.InputJsonValue | undefined {
  if (!list?.length) return undefined;
  return list.map((c) => ({
    name: c.name,
    qtyPerUnit: c.qtyPerUnit,
    unit: c.unit || 'ш',
    ...(c.productId ? { productId: c.productId } : {}),
  }));
}

@Controller('products')
export class ProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Companions picked from the catalog: the products must exist (looked up together), a product cannot go
   * out with itself, and a name or unit the form left empty is copied from the picked product. Only the
   * stored list changes; stock, prices and orders are not touched.
   */
  private async resolveCompanions(list: CreateProductDto['companions'], selfId?: string): Promise<CreateProductDto['companions']> {
    if (!list?.length) return list;
    const ids = [...new Set(list.map((c) => c.productId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return list;
    if (selfId && ids.includes(selfId)) throw new BadRequestException('Бараа өөрийгөө дагахгүй / A product cannot be its own companion');
    const found = await this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, nameMn: true, unit: true } });
    const byId = new Map(found.map((p) => [p.id, p]));
    if (ids.some((id) => !byId.has(id))) throw new BadRequestException('Дагах бараа олдсонгүй / Companion product not found');
    return list.map((c) => {
      const p = c.productId ? byId.get(c.productId) : undefined;
      return p ? { ...c, name: c.name || p.nameMn, unit: c.unit || p.unit } : c;
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_READ_ROLES)
  async list(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('search') search?: string) {
    const searchWhere = await productSearchFilter(this.prisma, productSearchTerm(q, search));
    const rows = await this.prisma.product.findMany({
      where: { active: true, ...searchWhere },
      orderBy: { nameEn: 'asc' },
    });
    // What we paid suppliers is for managers; the till and the warehouse see selling prices only.
    if (isManagerRole(user.role)) return rows;
    return rows.map(({ lastCostMnt: _cost, ...rest }) => rest);
  }

  @Get('all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  async listAll(@Query('q') q?: string, @Query('search') search?: string) {
    const searchWhere = await productSearchFilter(this.prisma, productSearchTerm(q, search));
    return this.prisma.product.findMany({
      where: searchWhere,
      orderBy: { sku: 'asc' },
    });
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  async create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    const { stockQty, warehouseId, companions: picked, barcode, ...rest } = dto;
    const companions = await this.resolveCompanions(picked);
    try {
      // The product starts at 0; any starting quantity is booked as an OPENING movement in one warehouse
      // so the ledger and the balances always agree.
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            ...rest,
            stockQty: 0,
            // No code on the goods: give it an in-store one so it can be labelled and scanned.
            barcode: normalizeBarcode(barcode) ?? (await nextInStoreBarcode(tx)),
            companions: companionsValue(companions) ?? Prisma.DbNull,
            category: dto.category?.trim() || 'General',
            imageUrl: dto.imageUrl || null,
            description: dto.description?.trim() || null,
          },
        });
        if (stockQty) {
          const target = await this.inventory.resolveWarehouseId(tx, warehouseId ?? user.warehouseId ?? null);
          // Someone given the product right outside the head office books opening stock only in their shops.
          assertWarehouseAccess(user, target);
          await this.inventory.openingBalance(tx, created.id, stockQty, {
            warehouseId: target,
            actorId: user.id,
            reason: 'Бараа бүртгэхэд оруулсан эхний үлдэгдэл',
          });
        }
        return tx.product.findUniqueOrThrow({ where: { id: created.id } });
      });
    } catch (err) {
if (isUniqueViolation(err)) {
        const target = String((err as Prisma.PrismaClientKnownRequestError).meta?.target ?? '');
        if (target.includes('barcode')) throw new ConflictException('Ийм баркодтой бараа бүртгэлтэй байна / Barcode already in use');
        throw new ConflictException(`${dto.sku} кодтой бараа бүртгэлтэй байна / SKU ${dto.sku} already exists`);
      }
      throw err;
    }
  }

  @Post(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, productUploadDir()),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').toLowerCase() || '.jpg';
          const safe = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
          cb(null, `${randomUUID()}${safe}`);
        },
      }),
      limits: { fileSize: 3 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!IMAGE_MIMES.has(file.mimetype)) {
          cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadImage(
    @Param('id') id: string,
    @UploadedFile() file?: { filename: string; mimetype: string },
  ) {
    if (!file?.filename) {
      throw new BadRequestException('Image file is required (field name: file)');
    }
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Product not found');
    }
    const imageUrl = `/uploads/products/${file.filename}`;
    return this.prisma.product.update({ where: { id }, data: { imageUrl } });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthUser) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    const { stockQty, companions: picked, barcode, ...rest } = dto;
    const companions = await this.resolveCompanions(picked, id);
    // The form always sends the quantity back; only a real change is a stock adjustment.
    const wantsStockChange = stockQty !== undefined && Number(existing.stockQty) !== stockQty;
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (wantsStockChange) {
          // With several warehouses "the quantity" is ambiguous, so the caller must say which one.
          const warehouses = await tx.warehouse.findMany({ where: { isActive: true } });
          if (warehouses.length !== 1) {
            throw new BadRequestException(
              'There are several warehouses; change stock with POST /inventory/adjust and a warehouseId',
            );
          }
          // Changing the count is a stock adjustment: it needs that right (not only the product right).
          assertCan(user, 'STOCK_ADJUST');
          assertWarehouseAccess(user, warehouses[0].id);
          // The typed value is that warehouse's count; compare with its own balance read inside the
          // transaction (not the product total read earlier, which a sale may have changed meanwhile).
          const bal = await tx.stockBalance.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouses[0].id, productId: id } },
          });
          const delta = Math.round((stockQty - Number(bal?.quantity ?? 0)) * 1000) / 1000;
          if (delta !== 0) await this.inventory.adjustInTx(tx, {
            warehouseId: warehouses[0].id,
            productId: id,
            delta,
            reason: 'Бараа засахад тоо хэмжээ өөрчилсөн',
            actorId: user.id,
          });
        }
        // Selling price changes are kept for the admin's edits report.
        if (dto.priceMnt !== undefined && dto.priceMnt !== existing.priceMnt) {
          await tx.editAudit.create({
            data: {
              entityType: 'PRODUCT_PRICE',
              entityId: id,
              summary: `${existing.sku} ${existing.nameMn}: үнэ ${existing.priceMnt} → ${dto.priceMnt}${
                existing.lastCostMnt != null && dto.priceMnt < existing.lastCostMnt ? ` (өртөг ${existing.lastCostMnt}₮-өөс доош)` : ''
              }`,
              before: { priceMnt: existing.priceMnt },
              after: { priceMnt: dto.priceMnt },
              reason: 'Барааны үнэ өөрчилсөн',
              actorId: user.id,
            },
          });
        }
        return tx.product.update({
          where: { id },
          data: {
            ...rest,
            // Clearing the code gives the product a fresh in-store one rather than leaving it unscannable.
            ...(barcode !== undefined ? { barcode: normalizeBarcode(barcode) ?? (await nextInStoreBarcode(tx)) } : {}),
            ...(companions !== undefined ? { companions: companionsValue(companions) ?? Prisma.DbNull } : {}),
            ...(dto.category !== undefined ? { category: dto.category.trim() || 'General' } : {}),
            ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}),
            ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
          },
        });
      });
    } catch (err) {
if (isUniqueViolation(err)) {
        const target = String((err as Prisma.PrismaClientKnownRequestError).meta?.target ?? '');
        if (target.includes('barcode')) throw new ConflictException('Ийм баркодтой бараа бүртгэлтэй байна / Barcode already in use');
        throw new ConflictException(`${dto.sku ?? existing.sku} кодтой бараа бүртгэлтэй байна / SKU ${dto.sku ?? existing.sku} already exists`);
      }
      throw err;
    }
  }

  /** Gives every product that has no barcode an in-store one (run once after importing old goods). */
  @Post('barcodes/fill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  async fillBarcodes() {
    const missing = await this.prisma.product.findMany({ where: { barcode: null }, orderBy: { sku: 'asc' }, select: { id: true } });
    for (let i = 0; i < missing.length; i++) {
      await this.prisma.product.update({ where: { id: missing[i].id }, data: { barcode: await nextInStoreBarcode(this.prisma) } });
    }
    return { assigned: missing.length };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Permission('PRODUCT_WRITE')
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    return this.prisma.product.update({ where: { id }, data: { active: false } });
  }
}
